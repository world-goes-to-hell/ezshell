const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { isLocalFilePath } = require('../localKeyPath.js')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { validateTomcat } = require('./tomcatRun.js')
const { mavenApproval, mavenFields } = require('./runSuggestions.js')
const { normalizeContextReference } = require('./workspaceServers.js')
const { validateLogEncoding } = require('./developmentEncoding.js')
const { normalizeJarReferences } = require('../runtimes/jarSearch.js')

const MAX_BYTES = 2 * 1024 * 1024
const MAX_PROJECTS = 200
const MAX_PRESETS = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ONE_LINE = /^[^\x00\r\n\u2028\u2029]*$/
const NAME_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const JDK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,159}$/

// Keep the same separators, drive-root form and case as the sidebar's projectKeyOf.
function projectKey(root) {
  const value = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const key = value === '' || /^[a-z]:$/i.test(value) ? value + '/' : value
  return /^[a-z]:[\\/]/i.test(root) ? key.toLowerCase() : key
}

function presetName(value) {
  const name = typeof value === 'string' ? value.trim().normalize('NFC') : ''
  if (!name || [...name].length > 20 || NAME_CONTROL.test(name) || !ONE_LINE.test(name)) throw new Error('구성 이름을 한 줄로 1~20자 입력해 주세요.')
  return name
}

function presetRelative(value) {
  if (typeof value !== 'string' || value.length > 4096 || NAME_CONTROL.test(value) || !ONE_LINE.test(value) || /[:]/.test(value) || /^[\\/]/.test(value)) {
    throw new Error('프로젝트 안의 폴더를 선택해 주세요.')
  }
  const parts = value.split(/[\\/]+/).filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.toLowerCase() === '.git')) throw new Error('프로젝트 안의 폴더를 선택해 주세요.')
  return parts.join('/') || '.'
}

async function realDirectory(value) {
  const entry = typeof value === 'string' && await resolveLocalPreviewPath(value).catch(() => null)
  if (!entry?.stat.isDirectory()) throw new Error('로컬 프로젝트 폴더를 찾을 수 없습니다.')
  return entry.path
}

async function directoryInProject(root, relative) {
  const cwd = await realDirectory(path.join(root, presetRelative(relative)))
  if (!sameOrInside(root, cwd) || path.relative(root, cwd).split(path.sep).some(part => part.toLowerCase() === '.git')) {
    throw new Error('프로젝트 안의 폴더를 선택해 주세요.')
  }
  return cwd
}

const commandHash = command => createHash('sha256').update(command).digest('hex')

function presetApproval(preset) {
  if (preset.kind === 'custom') return { command: preset.command, hash: commandHash(preset.command) }
  const maven = mavenApproval(preset)
  if (preset.kind !== 'tomcat') return maven && { command: maven.text, hash: commandHash(JSON.stringify(maven.signature)) }
  if (!preset.vmArgs.trim() && !preset.prepare && !preset.contextXml && !preset.extraLibs?.length) return null
  const prepare = preset.prepare
  const build = prepare?.tool === 'eclipse' ? '이클립스식 빌드 (.classpath의 Java 소스와 리소스)' : prepare && `${prepare.tool} ${prepare.target ?? prepare.goals}`
  const command = [build && `기동 전 빌드\n${build}`,
    preset.vmArgs.trim() && `Tomcat VM 인자\n${preset.vmArgs}`, maven?.text,
    preset.contextXml && `Tomcat 컨텍스트 설정 파일\n${preset.contextXml}`,
    preset.extraLibs?.length && `Tomcat에 연결할 JAR\n${preset.extraLibs.join('\n')}`].filter(Boolean).join('\n\n')
  return { command, hash: commandHash(JSON.stringify(['tomcat', preset.vmArgs, prepare, ...(maven ? [maven.signature] : []),
    ...(preset.contextXml ? [['contextXml', preset.contextXml]] : []),
    ...(preset.extraLibs?.length ? [['extraLibs', preset.extraLibs]] : [])])) }
}

function validatePreset(input, id) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof id !== 'string' || !UUID.test(id)) throw new Error('실행 구성을 확인해 주세요.')
  const name = presetName(input.name)
  const relative = presetRelative(input.relative ?? '.')
  const jdk = input.jdk ?? 'system'
  if (typeof jdk !== 'string' || !JDK_ID.test(jdk)) throw new Error('등록된 JDK를 선택해 주세요.')
  const hotReload = input.hotReload === undefined ? 'off' : input.hotReload
  const springTask = input.kind === 'task' && typeof input.taskId === 'string' && /:(?:maven|gradle)$/.test(input.taskId)
  if (!['off', 'standard', 'enhanced'].includes(hotReload) || (hotReload !== 'off' && !springTask && input.kind !== 'tomcat')) {
    throw new Error('바로 반영은 Spring Boot와 Tomcat 실행 구성에서만 선택할 수 있습니다.')
  }
  const env = input.env ?? {}
  if (typeof env !== 'object' || Array.isArray(env)) throw new Error('환경 변수를 확인해 주세요.')
  const entries = Object.entries(env)
  if (entries.length > 20 || entries.some(([key, value]) => !ENV_NAME.test(key) || typeof value !== 'string' || value.length > 4096 || !ONE_LINE.test(value))) {
    throw new Error('환경 변수는 영문 대문자·숫자·밑줄 이름과 한 줄 값으로 최대 20개까지 넣을 수 있습니다.')
  }
  const flags = { notify: true, agentControl: true, inAll: true, waitReady: false }
  for (const key of Object.keys(flags)) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') throw new Error('실행 구성의 스위치를 확인해 주세요.')
    flags[key] = input[key]
  }
  const base = { id, name, relative, jdk, hotReload, logEncoding: validateLogEncoding(input.logEncoding), env: Object.fromEntries(entries), ...flags }
  if (input.kind === 'tomcat') {
    const tomcat = validateTomcat(input, presetRelative)
    const contextXml = normalizeContextReference(input.contextXml, presetRelative)
    const extraLibs = normalizeJarReferences(input.extraLibs)
    return { ...base, ...tomcat, ...(contextXml && { contextXml }), ...(extraLibs.length && { extraLibs }), ...mavenFields({ ...input, ...tomcat }) }
  }
  if (input.kind === 'task' && typeof input.taskId === 'string' && input.taskId.length <= 300 && /^(?:.+):(gradle|maven|node)$/.test(input.taskId) && ONE_LINE.test(input.taskId)) {
    return { ...base, kind: 'task', taskId: input.taskId, ...mavenFields(input) }
  }
  if (input.kind === 'custom' && typeof input.command === 'string' && input.command.trim() && input.command.length <= 4096 && ONE_LINE.test(input.command)) {
    return { ...base, kind: 'custom', command: input.command.trim() }
  }
  throw new Error('실행 후보나 한 줄 명령을 선택해 주세요.')
}

const publicPreset = ({ confirmedHash, agentActionNotified, ...preset }) => preset

function createRunPresetStore(file) {
  let projects = new Map()
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw new Error('파일이 너무 큽니다.')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data?.version !== 1) throw new Error('저장 형식을 확인해 주세요.')
    const ids = new Set()
    for (const project of Array.isArray(data?.projects) ? data.projects.slice(0, MAX_PROJECTS) : []) {
      if (!project || typeof project.root !== 'string' || !isLocalFilePath(project.root) || !Array.isArray(project.presets)) continue
      const key = projectKey(project.root)
      if (projects.has(key)) continue
      const names = new Set()
      const presets = []
      for (const entry of project.presets.slice(0, MAX_PRESETS)) {
        try {
          const preset = validatePreset(entry, entry?.id)
          if (ids.has(preset.id) || names.has(preset.name)) continue
          const approval = presetApproval(preset)
          if (approval && entry.confirmedHash === approval.hash) preset.confirmedHash = entry.confirmedHash
          if (entry.agentActionNotified === true) preset.agentActionNotified = true
          ids.add(preset.id)
          names.add(preset.name)
          presets.push(preset)
        } catch { /* Ignore a malformed entry and keep the others. */ }
      }
      if (presets.length) projects.set(key, { root: project.root, presets })
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[run presets] 저장된 실행 구성을 읽지 못했습니다.')
  }

  const list = key => projects.get(key)?.presets ?? []
  function write(root, presets) {
    const key = projectKey(root)
    const next = new Map(projects)
    if (presets.length) next.set(key, { root, presets })
    else next.delete(key)
    const data = JSON.stringify({ version: 1, projects: [...next.values()] }) + '\n'
    if (next.size > MAX_PROJECTS || presets.length > MAX_PRESETS || Buffer.byteLength(data) > MAX_BYTES) throw new Error('저장할 실행 구성이 너무 많습니다.')
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
      projects = next
    } finally { try { fs.unlinkSync(temporary) } catch {} }
  }
  function markAgentAction(root, id) {
    const presets = list(projectKey(root))
    const preset = presets.find(item => item.id === id)
    if (!preset || preset.agentActionNotified) return false
    // Keep the preset reference stable while another worktree may be launching it.
    preset.agentActionNotified = true
    try { write(root, presets) }
    catch (error) { delete preset.agentActionNotified; throw error }
    return true
  }
  return { list, roots: () => [...projects.values()].map(project => project.root), write, markAgentAction }
}

module.exports = { createRunPresetStore, validatePreset, presetName, presetRelative, publicPreset, commandHash, presetApproval, projectKey, realDirectory, directoryInProject }
