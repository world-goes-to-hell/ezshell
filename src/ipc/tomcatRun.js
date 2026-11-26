const fs = require('node:fs/promises')
const path = require('node:path')
const { parseXml } = require('../sessionImport/filezilla.js')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { sameOrInside } = require('../localFiles/roots.js')

const XML_LIMIT = 256 * 1024
const TOOL_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const BASE_NAME = /^run-(?:(\d+)-)?[A-Za-z0-9]{6}$/
const LEGACY_BASE_MAX_AGE = 24 * 60 * 60 * 1000
const MODELS = ['maven', 'ant']
const BAD_ARGUMENTS = 'Tomcat VM 인자를 한 줄에 입력하고 공백이 있는 인자는 따옴표로 묶어 주세요.'
const BAD_WEBAPP = '워크트리 안에서 WEB-INF가 있는 웹 폴더를 선택해 주세요.'

function vmOptionTokens(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x08\x0a-\x1f\x7f\u2028\u2029]/u.test(raw)) throw new Error(BAD_ARGUMENTS)
  const tokens = []
  let word = ''
  let quote = ''
  const finish = () => {
    if (!word) return
    if (!word.startsWith('-') || word === '-') throw new Error(BAD_ARGUMENTS)
    tokens.push(word)
    word = ''
  }
  for (const char of raw) {
    if (char === quote) quote = ''
    else if (quote) word += char
    else if (char === '"' || char === "'") quote = char
    else if (/\s/u.test(char)) finish()
    else word += char
  }
  if (quote) throw new Error(BAD_ARGUMENTS)
  finish()
  return tokens
}

function validatePreparation(input) {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || !MODELS.includes(input.tool)) throw new Error('기동 전 빌드 도구를 확인해 주세요.')
  if (input.tool === 'ant' && typeof input.target === 'string' && TOOL_TOKEN.test(input.target)) return { tool: 'ant', target: input.target }
  if (input.tool === 'maven' && typeof input.goals === 'string' && input.goals.length <= 1024 && !/[\r\n\u2028\u2029]/u.test(input.goals)) {
    const goals = input.goals.trim().split(/\s+/)
    if (goals.length <= 12 && goals.every(goal => TOOL_TOKEN.test(goal))) return { tool: 'maven', goals: goals.join(' ') }
  }
  throw new Error('Ant 타깃이나 Maven 목표를 확인해 주세요.')
}

function validateTomcat(input, presetRelative) {
  const { tomcat, vmArgs = '', contextPath = '/', port = 8080 } = input
  if (typeof tomcat !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(tomcat)) throw new Error('등록된 Tomcat을 선택해 주세요.')
  if (typeof input.webapp !== 'string' || !input.webapp.trim()) throw new Error(BAD_WEBAPP)
  const webapp = presetRelative(input.webapp)
  if (contextPath !== '/' && (typeof contextPath !== 'string' || !/^\/[\p{L}\p{N}_-][\p{L}\p{N}._-]{0,63}$/u.test(contextPath) || contextPath === '/ROOT')) {
    throw new Error('컨텍스트 경로를 / 또는 /이름 형식으로 입력해 주세요.')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HTTP 포트는 1~65535 사이의 숫자로 입력해 주세요.')
  const vmOptions = vmOptionTokens(vmArgs)
  catalinaOptions(vmOptions, process.platform)
  if (input.hotReload && input.hotReload !== 'off' && vmOptions.some(arg => /^-agentlib:jdwp|^-Xrunjdwp/.test(arg))) {
    throw new Error('바로 반영을 켠 구성은 JDWP VM 인자를 따로 지정할 수 없습니다.')
  }
  const prepare = validatePreparation(input.prepare)
  return { kind: 'tomcat', tomcat, webapp, contextPath, port, vmArgs, ...(prepare && { prepare }) }
}

const local = file => resolveLocalPreviewPath(file).catch(() => null)

async function directoryUnder(root, relative) {
  const directory = await local(path.join(root, relative))
  return directory?.stat.isDirectory() && sameOrInside(root, directory.path) ? directory.path : null
}

async function webDirectory(worktree, relative) {
  const directory = await directoryUnder(worktree, relative)
  if (!directory || !await directoryUnder(directory, 'WEB-INF')) throw new Error(BAD_WEBAPP)
  // Catalina substitutes ${...} in attributes after decoding the XML.
  if (directory.includes('${') || /[\x00-\x1f]/.test(directory)) throw new Error('Tomcat에서 사용할 수 없는 문자가 웹 폴더의 실제 경로에 있습니다.')
  return directory
}

async function webappCandidates(worktree) {
  const output = []
  const pending = [{ relative: '.', depth: 0 }]
  const ignored = new Set(['.git', 'node_modules', '.gradle', '.idea', 'WEB-INF', 'META-INF'])
  for (let visited = 0; visited < 200 && pending.length && output.length < 30; visited++) {
    const { relative, depth } = pending.shift()
    const folder = await directoryUnder(worktree, relative)
    if (!folder) continue
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    if (entries.some(entry => entry.name === 'WEB-INF' && entry.isDirectory())) output.push(relative.replaceAll(path.sep, '/'))
    if (depth >= 4) continue
    const directories = entries.filter(entry => entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.'))
      .sort((a, b) => Number(!/^(?:WebContent|webapp|src|main|target)$/.test(a.name)) - Number(!/^(?:WebContent|webapp|src|main|target)$/.test(b.name)))
    for (const entry of directories.slice(0, 50)) pending.push({ relative: path.join(relative, entry.name), depth: depth + 1 })
  }
  return output
}

async function xmlFile(root, relative) {
  const entry = await local(path.join(root, relative))
  if (!entry?.stat.isFile() || !sameOrInside(root, entry.path) || entry.stat.size > XML_LIMIT) return null
  const handle = await fs.open(entry.path, 'r')
  try {
    const buffer = Buffer.alloc(XML_LIMIT + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead <= XML_LIMIT ? parseXml(buffer.toString('utf8', 0, bytesRead)) : null
  } finally { await handle.close() }
}

async function antTargets(folder) {
  try {
    const xml = await xmlFile(folder, 'build.xml')
    if (xml?.name !== 'project') return []
    return [...new Set(xml.children.filter(item => item.name === 'target' && TOOL_TOKEN.test(item.attrs.name ?? '')).map(item => item.attrs.name))]
  } catch { return [] }
}

const quote = (value, platform) => `'${value.replaceAll("'", platform === 'win32' ? "''" : "'\\''")}'`

function launchCommand(binary, words, platform) {
  return `${platform === 'win32' ? '& ' : ''}${quote(binary, platform)} ${words.join(' ')}`
}

async function preparationCommand(prepare, cwd, toolHomeFor, platform) {
  if (!prepare) return null
  if (prepare.tool === 'ant' && !(await antTargets(cwd)).includes(prepare.target)) throw new Error('build.xml에서 선택한 Ant 타깃을 찾을 수 없습니다.')
  const home = await toolHomeFor(prepare.tool)
  const base = prepare.tool === 'ant' ? 'ant' : 'mvn'
  const launcher = platform === 'win32' ? `${base}${prepare.tool === 'ant' ? '.bat' : '.cmd'}` : base
  const binary = home ? path.join(home, 'bin', launcher) : base
  if (home && !(await local(binary))?.stat.isFile()) throw new Error('선택한 빌드 도구를 실행할 수 없습니다.')
  return launchCommand(binary, prepare.tool === 'ant' ? [prepare.target] : prepare.goals.split(' '), platform)
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])
}

const node = (name, attrs) => ({ name, attrs, children: [], text: '' })
const child = (parent, name) => parent?.children.find(item => item.name === name)

function writeElement(element, depth = 0) {
  const indent = '  '.repeat(depth)
  const attrs = Object.entries(element.attrs).map(([key, value]) => ` ${key}="${xmlEscape(value)}"`).join('')
  if (!element.children.length && !element.text) return `${indent}<${element.name}${attrs}/>\n`
  const body = element.children.map(item => writeElement(item, depth + 1)).join('')
  return `${indent}<${element.name}${attrs}>${element.text ? xmlEscape(element.text) : ''}${body ? `\n${body}${indent}` : ''}</${element.name}>\n`
}

function tomcatConfiguration(server, preset, webapp) {
  const service = child(server, 'Service')
  const engine = child(service, 'Engine')
  const host = engine?.children.find(item => item.name === 'Host' && item.attrs.name === 'localhost') ?? child(engine, 'Host')
  const http = service?.children.find(item => item.name === 'Connector' && (!item.attrs.protocol || /^HTTP\/|^org\.apache\.coyote\.http11\./i.test(item.attrs.protocol)) && item.attrs.SSLEnabled !== 'true')
  if (server?.name !== 'Server' || !http || !host) throw new Error('Tomcat server.xml에서 HTTP 커넥터와 Host를 확인할 수 없습니다.')
  server.attrs.port = '-1'
  delete server.attrs.portOffset
  for (const listener of server.children.filter(item => item.name === 'Listener' && item.attrs.className === 'org.apache.catalina.startup.VersionLoggerListener')) {
    listener.attrs.logArgs = 'false'
  }
  server.children = server.children.filter(item => item.name !== 'Service' || item === service)
  service.children = service.children.filter(item => item.name !== 'Connector' || item === http)
  Object.assign(http.attrs, { port: String(preset.port), address: '127.0.0.1', scheme: 'http', secure: 'false' })
  delete http.attrs.SSLEnabled
  http.children = http.children.filter(item => item.name !== 'SSLHostConfig')
  Object.assign(engine.attrs, { name: 'Catalina', defaultHost: 'localhost' })
  engine.children = engine.children.filter(item => item.name !== 'Host' || item === host)
  Object.assign(host.attrs, { name: 'localhost', autoDeploy: 'false', deployOnStartup: 'false', appBase: 'apps' })
  host.children = host.children.filter(item => item.name !== 'Context')
  const context = node('Context', { docBase: webapp })
  // With both Host deployment scanners off, start just this explicit context at boot.
  host.children.push(node('Context', { ...context.attrs, path: preset.contextPath === '/' ? '' : preset.contextPath }))
  return { server: `<?xml version="1.0" encoding="UTF-8"?>\n${writeElement(server)}`, context: writeElement(context),
    descriptor: preset.contextPath === '/' ? 'ROOT.xml' : `${preset.contextPath.slice(1)}.xml` }
}

async function makeBase(userData, id, conf, config) {
  const base = (await local(userData))?.path
  if (!base || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('Tomcat 실행 폴더를 확인할 수 없습니다.')
  let parent = base
  for (const name of ['runtimes', 'tomcat-base', id]) {
    parent = path.join(parent, name)
    await fs.mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error })
    const stat = await fs.lstat(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Tomcat 실행 폴더에 링크를 사용할 수 없습니다.')
  }
  const removeBase = async directory => {
    const entry = await fs.lstat(directory).catch(() => null)
    if (entry?.isDirectory() && !entry.isSymbolicLink() && await fs.realpath(directory) === directory && path.dirname(directory) === parent) {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 })
    }
  }
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    const match = BASE_NAME.exec(entry.name)
    if (!match || !entry.isDirectory()) continue
    const orphan = path.join(parent, entry.name)
    try {
      const owner = Number(match[1])
      if (owner) {
        try { process.kill(owner, 0); continue }
        catch (error) { if (error.code !== 'ESRCH') continue }
      } else if (Date.now() - (await fs.stat(orphan)).mtimeMs < LEGACY_BASE_MAX_AGE) continue
      await removeBase(orphan)
    } catch { /* Retry on the next launch if the directory is busy. */ }
  }
  const directory = await fs.mkdtemp(path.join(parent, `run-${process.pid}-`))
  const cleanup = () => removeBase(directory)
  try {
    const target = path.join(directory, 'conf')
    await fs.cp(conf, target, { recursive: true, filter: async from => {
      if (path.relative(conf, from).split(path.sep)[0]?.toLowerCase() === 'catalina') return false
      const stat = await fs.lstat(from)
      return stat.isDirectory() || stat.isFile()
    } })
    const context = path.join(target, 'Catalina', 'localhost')
    await Promise.all(['logs', 'temp', 'work', 'apps', path.relative(directory, context)].map(name => fs.mkdir(path.join(directory, name), { recursive: true })))
    await fs.writeFile(path.join(target, 'server.xml'), config.server)
    await fs.writeFile(path.join(context, config.descriptor), config.context, { flag: 'wx' })
    return { directory, cleanup }
  } catch (error) { await cleanup(); throw error }
}

async function tomcatLayout(worktree, cwd, webapp, home) {
  const output = await directoryUnder(webapp, path.join('WEB-INF', 'classes'))
  if (!output) return { reason: 'WEB-INF/classes 폴더가 없어 Java 바로 반영을 사용할 수 없습니다.' }
  let classpath
  try { classpath = await xmlFile(cwd, '.classpath') } catch { /* Try the conventional source folders. */ }
  const entries = classpath?.name === 'classpath' ? classpath.children.filter(item => item.name === 'classpathentry') : []
  const defaultOutput = entries.find(item => item.attrs.kind === 'output')?.attrs.path
  const listed = entries.filter(item => {
    const { kind, path: source, output: destination } = item.attrs
    if (kind !== 'src' || !source || source.split(/[\\/]/).some(part => /^tests?$/i.test(part))) return false
    if (child(item, 'attributes')?.children.some(attribute => attribute.name === 'attribute' && attribute.attrs.name === 'test' && attribute.attrs.value === 'true')) return false
    if (!destination) return true
    const target = path.resolve(cwd, destination)
    return path.relative(output, target) === '' || Boolean(defaultOutput && path.relative(path.resolve(cwd, defaultOutput), target) === '')
  }).map(item => item.attrs.path)
  const validSources = async values => (await Promise.all(values.filter(relative => relative && !path.isAbsolute(relative))
    .map(async relative => {
      const source = await local(path.resolve(cwd, relative))
      return source?.stat.isDirectory() && sameOrInside(worktree, source.path) ? source.path : null
    }))).filter(Boolean)
  let sources = await validSources(listed)
  if (!sources.length) {
    const conventional = await validSources(['src/main/java', 'src'])
    sources = conventional.slice(0, 1)
  }
  if (!sources.length) return { reason: 'Tomcat에서 감시할 Java 소스 폴더를 찾을 수 없습니다.' }
  const jars = async (root, relative) => {
    const directory = await directoryUnder(root, relative)
    if (!directory) return []
    return (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /\.jar$/i.test(entry.name))
      .map(entry => path.join(directory, entry.name))
  }
  return { classpath: [output, ...await jars(webapp, path.join('WEB-INF', 'lib')), ...await jars(home, 'lib')],
    roots: [...new Set(sources)].map(source => ({ source, output, moduleRoot: cwd })) }
}

function catalinaOptions(tokens, platform) {
  if (platform !== 'win32') return tokens.map(token => quote(token, platform)).join(' ')
  // catalina.bat expands CATALINA_OPTS as command text. Keep shell control characters out.
  if (tokens.some(token => /["%!^&|<>]/.test(token))) throw new Error('Windows Tomcat VM 인자에는 명령 셸 특수 문자를 사용할 수 없습니다.')
  return tokens.map(token => /\s/.test(token) ? `"${token.replace(/\\+$/, '$&$&')}"` : token).join(' ')
}

async function planTomcat(preset, cwd, { toolHomeOf, toolHomeFor, platform = process.platform }) {
  const home = (await local(await toolHomeOf(preset.tomcat)))?.path
  const name = platform === 'win32' ? 'catalina.bat' : 'catalina.sh'
  const launcher = home && await local(path.join(home, 'bin', name))
  if (!launcher?.stat.isFile() || !sameOrInside(home, launcher.path) || !await directoryUnder(home, 'conf')) throw new Error('선택한 Tomcat을 찾을 수 없습니다.')
  const prepareCommand = await preparationCommand(preset.prepare, cwd, toolHomeFor, platform)
  const command = launchCommand(path.join(home, 'bin', name), ['run'], platform)
  // Tomcat's default ConsoleHandler writes UTF-8 even on non-UTF-8 Windows consoles.
  const consoleEncoding = platform === 'win32' ? '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n' : ''
  return { home, command: consoleEncoding + command, prepareCommand, platform }
}

async function stageTomcat(plan, { preset, task, worktree, userData, prepareReload }) {
  const webapp = await webDirectory(worktree, preset.webapp)
  const conf = await directoryUnder(plan.home, 'conf')
  let server
  try { if (conf) server = await xmlFile(conf, 'server.xml') } catch { /* Report a localized error below. */ }
  if (!server) throw new Error('Tomcat server.xml을 읽을 수 없습니다.')
  const reload = preset.hotReload === 'off' ? {} : await prepareReload({ layout: await tomcatLayout(worktree, task.cwd, webapp, plan.home),
    worktree, cwd: task.cwd, mode: preset.hotReload, args: task.enhancedArgs })
  const { jvmArgs = [], ...hot } = reload
  const opts = catalinaOptions([...vmOptionTokens(preset.vmArgs), ...jvmArgs], plan.platform)
  const config = tomcatConfiguration(server, preset, webapp)
  const base = await makeBase(userData, preset.id, conf, config)
  return { ...task, ...hot, command: plan.command, env: { ...task.env, CATALINA_HOME: plan.home, CATALINA_BASE: base.directory, CATALINA_OPTS: opts,
    ...(task.javaHome && { JRE_HOME: task.javaHome }) }, expectedUrl: `http://127.0.0.1:${preset.port}${encodeURI(preset.contextPath)}`,
    cleanup: base.cleanup }
}

module.exports = { validateTomcat, antTargets, webDirectory, webappCandidates, planTomcat, stageTomcat, tomcatLayout, tomcatConfiguration, catalinaOptions }
