const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { isLocalFilePath } = require('../localKeyPath.js')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { validateTomcat, vmOptionTokens } = require('./tomcatRun.js')
const { usesMaven, mavenApproval, mavenFields } = require('./runSuggestions.js')
const { normalizeContextReference } = require('./workspaceServers.js')
const { validateLogEncoding } = require('./developmentEncoding.js')
const { normalizeJarReferences } = require('../runtimes/jarSearch.js')
const { restoreStartOrder, reconcileStartOrder } = require('./runStartOrder.js')

const MAX_BYTES = 2 * 1024 * 1024
const MAX_PROJECTS = 200
const MAX_PRESETS = 50
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ONE_LINE = /^[^\x00\r\n\u2028\u2029]*$/
const NAME_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/
const JDK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,159}$/
const SPRING_VM_OPTIONS = 'Spring Boot VM 인자는 한 줄에 입력하고 공백이 있는 인자는 따옴표로 묶어 주세요.'

const isSpringBootTask = ({ kind, taskId }) => kind === 'task' && typeof taskId === 'string' && /:(?:maven|gradle)$/.test(taskId)

function springBootFields({ port, vmArgs = '' }, hotReload) {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('실행 포트는 1~65535 사이의 숫자로 입력해 주세요.')
  }
  const args = vmOptionTokens(vmArgs, SPRING_VM_OPTIONS)
  if (hotReload !== 'off' && args.some(arg => /^-agentlib:jdwp|^-Xrunjdwp/.test(arg))) {
    throw new Error('바로 반영을 켠 구성은 JDWP VM 인자를 따로 지정할 수 없습니다.')
  }
  return { ...(port !== undefined && { port }), ...(args.length && { vmArgs: vmArgs.trim() }) }
}

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

function mavenExecutionFields(preset) {
  if (!usesMaven(preset)) return {}
  const { mavenRunner, mavenSplit, mavenPin, mavenSource } = preset
  if (mavenRunner !== undefined && (typeof mavenRunner !== 'string' || !JDK_ID.test(mavenRunner))) {
    throw new Error('Maven을 실행할 보관함 JDK를 선택해 주세요.')
  }
  if ([mavenSplit, mavenPin].some(value => value !== undefined && typeof value !== 'boolean')) {
    throw new Error('Maven JDK 분리와 보관 스위치를 확인해 주세요.')
  }
  if (mavenSource !== undefined && !['online', 'pinned'].includes(mavenSource)) throw new Error('Maven 저장소 선택을 확인해 주세요.')
  return { ...(mavenRunner !== undefined && { mavenRunner }), ...(mavenSplit !== undefined && { mavenSplit }),
    ...(mavenPin !== undefined && { mavenPin }), ...(mavenSource !== undefined && { mavenSource }) }
}

function mavenExecutionApproval(preset) {
  const { mavenRunner, mavenSplit, mavenPin, mavenSource } = mavenExecutionFields(preset)
  const lines = [mavenRunner && `Maven 실행 JDK ${mavenRunner}`,
    mavenSplit !== undefined && `프로젝트 JDK로 Maven 컴파일·테스트 ${mavenSplit ? '켜기' : '끄기'}`,
    mavenSource === 'pinned' && 'Maven 보관본으로 빌드 (file: 미러)',
    mavenSource !== 'pinned' && mavenPin && '성공한 Maven 빌드의 의존성 보관'].filter(Boolean)
  if (!lines.length) return null
  return { text: lines.join('\n'), signature: ['mavenExecution', preset.jdk, mavenRunner ?? null, mavenSplit ?? null,
    mavenPin === true, mavenSource ?? 'online'] }
}

function presetApproval(preset) {
  const { kind, relative, jdk, hotReload } = preset
  const environment = Object.entries(preset.env).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  const signature = [2, kind, relative, jdk, environment, hotReload]
  const options = [relative !== '.' && `실행 폴더\n${relative}`, jdk !== 'system' && `JDK\n${jdk}`,
    environment.length && `환경 변수 이름\n${environment.map(([name]) => name).join('\n')}`,
    hotReload !== 'off' && `바로 반영\n${hotReload === 'enhanced' ? '확장' : '표준'}`]
  const approval = (parts, target) => ({ command: [...parts, ...options].filter(Boolean).join('\n\n'),
    hash: commandHash(JSON.stringify([...signature, ...target])) })
  if (kind === 'custom') return approval([preset.command], [preset.command])
  const maven = preset.mavenSource === 'pinned' ? null : mavenApproval(preset)
  const execution = mavenExecutionApproval(preset)
  const mavenParts = [maven?.text, execution?.text]
  const mavenSignature = [maven?.signature, execution?.signature]
  if (kind === 'task') {
    const { port, vmArgs } = preset
    const springParts = [port !== undefined && `Spring Boot 실행 포트\n${port}`, vmArgs && `Spring Boot VM 인자\n${vmArgs}`]
    const springSignature = port !== undefined || vmArgs ? [port ?? null, vmArgs ?? null] : []
    return approval([`기동 후보\n${preset.taskId}`, ...springParts, ...mavenParts], [preset.taskId, ...mavenSignature, ...springSignature])
  }
  const { tomcat, webapp, contextPath, port, prepare, contextXml, extraLibs, vmArgs } = preset
  const build = prepare?.tool === 'eclipse' ? '이클립스식 빌드 (.classpath의 Java 소스와 리소스)' : prepare && `${prepare.tool} ${prepare.target ?? prepare.goals}`
  return approval([`Tomcat 실행 대상\n${tomcat}\n웹 폴더 ${webapp}\nhttp://127.0.0.1:${port}${contextPath}`,
    build && `기동 전 빌드\n${build}`, vmArgs.trim() && `Tomcat VM 인자\n${vmArgs}`, ...mavenParts,
    contextXml && `Tomcat 컨텍스트 설정 파일\n${contextXml}`, extraLibs?.length && `Tomcat에 연결할 JAR\n${extraLibs.join('\n')}`],
  [tomcat, webapp, contextPath, port, vmArgs, prepare, contextXml, extraLibs, ...mavenSignature])
}

function validatePreset(input, id) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof id !== 'string' || !UUID.test(id)) throw new Error('실행 구성을 확인해 주세요.')
  const name = presetName(input.name)
  const relative = presetRelative(input.relative ?? '.')
  const jdk = input.jdk ?? 'system'
  if (typeof jdk !== 'string' || !JDK_ID.test(jdk)) throw new Error('등록된 JDK를 선택해 주세요.')
  const hotReload = input.hotReload === undefined ? 'off' : input.hotReload
  const springTask = isSpringBootTask(input)
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
    const preset = { ...input, ...tomcat }
    return { ...base, ...tomcat, ...(contextXml && { contextXml }), ...(extraLibs.length && { extraLibs }), ...mavenFields(preset), ...mavenExecutionFields(preset) }
  }
  if (input.kind === 'task' && typeof input.taskId === 'string' && input.taskId.length <= 300 && /^(?:.+):(gradle|maven|node)$/.test(input.taskId) && ONE_LINE.test(input.taskId)) {
    return { ...base, kind: 'task', taskId: input.taskId, ...(springTask && springBootFields(input, hotReload)), ...mavenFields(input), ...mavenExecutionFields(input) }
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
      if (presets.length) {
        let startOrder
        try { if (project.startOrder) startOrder = restoreStartOrder(project.startOrder, presets) }
        catch { /* Fall back to the legacy fields for this project. */ }
        projects.set(key, { root: project.root, presets, ...(startOrder && { startOrder }) })
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[run presets] 저장된 실행 구성을 읽지 못했습니다.')
  }

  const list = key => projects.get(key)?.presets ?? []
  const startOrder = key => reconcileStartOrder(projects.get(key)?.startOrder, list(key))
  function write(root, presets, order) {
    const key = projectKey(root)
    const next = new Map(projects)
    const previousOrder = order ?? projects.get(key)?.startOrder
    if (presets.length) next.set(key, { root, presets, ...(previousOrder && { startOrder: reconcileStartOrder(previousOrder, presets) }) })
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
  return { list, startOrder, hasStartOrder: key => Boolean(projects.get(key)?.startOrder),
    roots: () => [...projects.values()].map(project => project.root), write, markAgentAction }
}

module.exports = { createRunPresetStore, validatePreset, presetName, presetRelative, publicPreset, commandHash, presetApproval, projectKey, realDirectory, directoryInProject, isSpringBootTask }
