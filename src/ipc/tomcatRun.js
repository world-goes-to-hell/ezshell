const fs = require('node:fs/promises')
const path = require('node:path')
const { parseXml } = require('../sessionImport/filezilla.js')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { eclipseTestSource } = require('./eclipseProject.js')
const { javaCharset, javaLogOptions, windowsConsoleEncoding } = require('./developmentEncoding.js')
const { mavenVersionFromHome } = require('../runtimes/apacheToolHome.js')
const { allowedJar, jarHasClass, jarClassName, copyCheckedJar } = require('../runtimes/jarSearch.js')
const { ownerExited } = require('./runScratch.js')

const XML_LIMIT = 256 * 1024
const TOOL_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/
const BASE_NAME = /^run-(?:(\d+)-)?[A-Za-z0-9]{6}$/
const LEGACY_BASE_MAX_AGE = 24 * 60 * 60 * 1000
const activeBases = new Set()
const MODELS = ['maven', 'ant', 'eclipse']
const BAD_ARGUMENTS = 'Tomcat VM 인자를 한 줄에 입력하고 공백이 있는 인자는 따옴표로 묶어 주세요.'
const BAD_WEBAPP = '워크트리 안에서 WEB-INF가 있는 웹 폴더를 선택해 주세요.'

function vmOptionTokens(raw, invalid = BAD_ARGUMENTS, combineModuleOptions = false) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x08\x0a-\x1f\x7f\u2028\u2029]/u.test(raw)) throw new Error(invalid)
  const tokens = []
  let word = ''
  let quote = ''
  const finish = () => {
    if (!word) return
    if (combineModuleOptions && /^--add-(?:opens|exports|reads)$/.test(tokens.at(-1)) && /^[\w.$/-]+=[\w.$,-]+$/.test(word)) {
      tokens[tokens.length - 1] += `=${word}`
      word = ''
      return
    }
    if (!word.startsWith('-') || word === '-') throw new Error(invalid)
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
  if (quote) throw new Error(invalid)
  finish()
  return tokens
}

function workspaceVmArguments(raw) {
  const setting = /^-D([^=]+)(?:=|$)/i
  const managed = /^(?:catalina\.(?:home|base)|wtp\.deploy|java\.(?:io\.tmpdir|endorsed\.dirs|util\.logging\.config\.file))$/i
  const confidential = /password|passwd|secret|credential|token|api[._-]?key|access[._-]?key|(?:^|[._-])pwd?(?:$|[._-])/i
  let omittedCredentials = 0
  const tokens = vmOptionTokens(raw.replace(/[\r\n]+/g, ' ')).filter(arg => {
    const property = setting.exec(arg)?.[1] ?? ''
    if (confidential.test(property)) { omittedCredentials++; return false }
    return !managed.test(property) && !/^-agentlib:jdwp|^-Xrunjdwp/.test(arg)
  })
  catalinaOptions(tokens, process.platform)
  return { vmArgs: tokens.map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' '), omittedCredentials }
}

function validatePreparation(input) {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || !MODELS.includes(input.tool)) throw new Error('기동 전 빌드 도구를 확인해 주세요.')
  if (input.tool === 'eclipse') return { tool: 'eclipse' }
  if (input.tool === 'ant' && typeof input.target === 'string' && TOOL_TOKEN.test(input.target)) return { tool: 'ant', target: input.target }
  if (input.tool === 'maven' && typeof input.goals === 'string' && input.goals.length <= 1024 && !/[\r\n\u2028\u2029]/u.test(input.goals)) {
    const goals = input.goals.trim().split(/\s+/)
    if (goals.length <= 12 && goals.every(goal => TOOL_TOKEN.test(goal))) return { tool: 'maven', goals: goals.join(' ') }
  }
  throw new Error('Ant 타깃이나 Maven 목표를 확인해 주세요.')
}

const validContextPath = value => value === '/' || (typeof value === 'string' && value !== '/ROOT' && /^\/[\p{L}\p{N}_-][\p{L}\p{N}._-]{0,63}$/u.test(value))

function validateTomcat(input, presetRelative) {
  const { tomcat, vmArgs = '', contextPath = '/', port = 8080 } = input
  if (typeof tomcat !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(tomcat)) throw new Error('등록된 Tomcat을 선택해 주세요.')
  if (typeof input.webapp !== 'string' || !input.webapp.trim()) throw new Error(BAD_WEBAPP)
  const webapp = presetRelative(input.webapp)
  if (!validContextPath(contextPath)) {
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
  if (!prepare || prepare.tool === 'eclipse') return { prepareCommand: null }
  if (prepare.tool === 'ant' && !(await antTargets(cwd)).includes(prepare.target)) throw new Error('build.xml에서 선택한 Ant 타깃을 찾을 수 없습니다.')
  const home = await toolHomeFor(prepare.tool)
  const base = prepare.tool === 'ant' ? 'ant' : 'mvn'
  const launcher = platform === 'win32' ? `${base}${prepare.tool === 'ant' ? '.bat' : '.cmd'}` : base
  const binary = home ? path.join(home, 'bin', launcher) : base
  if (home && !(await local(binary))?.stat.isFile()) throw new Error('선택한 빌드 도구를 실행할 수 없습니다.')
  return {
    prepareCommand: launchCommand(binary, prepare.tool === 'ant' ? [prepare.target] : prepare.goals.split(' '), platform),
    ...(prepare.tool === 'maven' && { mavenVersion: mavenVersionFromHome(home) })
  }
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

function webappResources(major, eclipseBuild, approved) {
  const { output, extraJars = [], jarDirectory } = eclipseBuild ?? {}
  const jars = approved?.paths ?? []
  const entries = (major === 7 ? [output, ...extraJars, ...jars] : [output, jarDirectory, ...jars]).filter(Boolean)
  if (entries.some(file => file.includes('${') || /[\x00-\x1f]/.test(file) || (major === 7 && file.includes(';')))) {
    throw new Error('Tomcat에 연결할 수 없는 문자가 클래스 또는 JAR 경로에 있습니다.')
  }
  if (major === 7) return node('Loader', { className: 'org.apache.catalina.loader.VirtualWebappLoader', virtualClasspath: entries.join(';'), searchVirtualFirst: 'true' })
  if (!(major >= 8)) throw new Error('클래스 또는 JAR를 연결하려면 버전을 확인할 수 있는 Tomcat 7 이상이 필요합니다.')
  const resources = node('Resources', {})
  const mount = (name, base, webAppMount) => node(name, { className: 'org.apache.catalina.webresources.DirResourceSet', base, webAppMount })
  if (output) resources.children.push(mount('PreResources', output, '/WEB-INF/classes'))
  // Expose external jars as entries of WEB-INF/lib so class loading and web-fragment scanning agree.
  if (jarDirectory) resources.children.push(mount('PreResources', jarDirectory, '/WEB-INF/lib'))
  // Mount each file so Tomcat registers it as a WEB-INF/lib JAR, including when the webapp lacks that directory.
  for (const base of jars) resources.children.push(node('PostResources', {
    className: 'org.apache.catalina.webresources.FileResourceSet', base, webAppMount: `/WEB-INF/lib/${path.basename(base)}`
  }))
  return resources
}

function tomcatConfiguration(server, preset, webapp, eclipseBuild, contextEntries = [], approved) {
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
  context.children.push(...contextEntries)
  const component = (eclipseBuild || approved) && webappResources(approved?.major ?? eclipseBuild.major, eclipseBuild, approved)
  if (component) context.children.push(component)
  // With both Host deployment scanners off, start just this explicit context at boot.
  host.children.push({ ...context, attrs: { ...context.attrs, path: preset.contextPath === '/' ? '' : preset.contextPath } })
  return { server: `<?xml version="1.0" encoding="UTF-8"?>\n${writeElement(server)}`, context: writeElement(context),
    descriptor: preset.contextPath === '/' ? 'ROOT.xml' : `${preset.contextPath.slice(1)}.xml`, component }
}

async function makeBase(userData, id, conf, configure, encoding) {
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
        // A server handed over by the app before an update still runs on its base (runScratch.js)
        if (!ownerExited(owner)) continue
      } else if (Date.now() - (await fs.stat(orphan)).mtimeMs < LEGACY_BASE_MAX_AGE) continue
      await removeBase(orphan)
    } catch { /* Retry on the next launch if the directory is busy. */ }
  }
  const directory = await fs.mkdtemp(path.join(parent, `run-${process.pid}-`))
  const cleanup = async () => {
    await removeBase(directory)
    activeBases.delete(cleanup)
  }
  activeBases.add(cleanup)
  try {
    const config = await configure(directory)
    const target = path.join(directory, 'conf')
    await fs.cp(conf, target, { recursive: true, filter: async from => {
      if (path.relative(conf, from).split(path.sep)[0]?.toLowerCase() === 'catalina') return false
      if (path.relative(conf, from).toLowerCase() === 'server.xml') return false
      const stat = await fs.lstat(from)
      return stat.isDirectory() || stat.isFile()
    } })
    if (config.component) {
      // Tomcat applies conf/context.xml after server.xml to each Context. Preserve a customized
      // default component and add the run's mounts there too so that it cannot replace them.
      const defaults = await xmlFile(target, 'context.xml')
      const existing = child(defaults, config.component.name)
      if (defaults?.name === 'Context' && existing) {
        const previousClasspath = existing.attrs.virtualClasspath
        Object.assign(existing.attrs, config.component.attrs)
        if (config.component.name === 'Loader' && previousClasspath) {
          existing.attrs.virtualClasspath = `${previousClasspath};${config.component.attrs.virtualClasspath}`
        }
        existing.children.push(...config.component.children)
        await fs.writeFile(path.join(target, 'context.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n${writeElement(defaults)}`)
      }
    }
    const context = path.join(target, 'Catalina', 'localhost')
    await Promise.all(['logs', 'temp', 'work', 'apps', path.relative(directory, context)].map(name => fs.mkdir(path.join(directory, name), { recursive: true })))
    await fs.writeFile(path.join(target, 'server.xml'), config.server, { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(context, config.descriptor), config.context, { flag: 'wx', mode: 0o600 })
    if (encoding !== 'auto') {
      const logging = path.join(target, 'logging.properties')
      const stat = await fs.lstat(logging).catch(() => null)
      if (stat?.isFile() && stat.size <= XML_LIMIT) {
        const original = await fs.readFile(logging, 'utf8')
        const configured = original.replace(/^[ \t]*java\.util\.logging\.ConsoleHandler\.encoding[ \t]*[=:].*$/gm, '')
        await fs.writeFile(logging, `${configured}\njava.util.logging.ConsoleHandler.encoding = ${javaCharset(encoding)}\n`)
      }
    }
    return { directory, cleanup }
  } catch (error) { await cleanup(); throw error }
}

function closeTomcatBases() {
  return activeBases.size ? Promise.allSettled([...activeBases].map(cleanup => cleanup())) : null
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
    if (kind !== 'src' || !source || eclipseTestSource(item)) return false
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
  return { classpath: [output, ...await tomcatJars(webapp, path.join('WEB-INF', 'lib')), ...await tomcatJars(home, 'lib')],
    roots: [...new Set(sources)].map(source => ({ source, output, moduleRoot: cwd })) }
}

async function tomcatJars(root, relative) {
  const directory = await directoryUnder(root, relative)
  if (!directory) return []
  return (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /\.jar$/i.test(entry.name))
    .map(entry => path.join(directory, entry.name)).sort()
}

function catalinaOptions(tokens, platform) {
  if (platform !== 'win32') return tokens.map(token => quote(token, platform)).join(' ')
  // catalina.bat expands CATALINA_OPTS as command text. Keep shell control characters out.
  if (tokens.some(token => /["%!^&|<>]/.test(token))) throw new Error('Windows Tomcat VM 인자에는 명령 셸 특수 문자를 사용할 수 없습니다.')
  return tokens.map(token => /\s/.test(token) ? `"${token.replace(/\\+$/, '$&$&')}"` : token).join(' ')
}

async function planTomcat(preset, cwd, { toolHomeOf, toolHomeFor, toolVersionOf = () => null, platform = process.platform }) {
  const home = (await local(await toolHomeOf(preset.tomcat)))?.path
  const name = platform === 'win32' ? 'catalina.bat' : 'catalina.sh'
  const launcher = home && await local(path.join(home, 'bin', name))
  if (!launcher?.stat.isFile() || !sameOrInside(home, launcher.path) || !await directoryUnder(home, 'conf')) throw new Error('선택한 Tomcat을 찾을 수 없습니다.')
  const preparation = await preparationCommand(preset.prepare, cwd, toolHomeFor, platform)
  const command = launchCommand(path.join(home, 'bin', name), ['run'], platform)
  const encoding = preset.logEncoding ?? 'auto'
  const inheritedMs949 = encoding === 'auto' && vmOptionTokens(preset.vmArgs).some(arg => /^-D(?:file|(?:sun\.)?stdout)\.encoding=(?:ms949|cp949|windows-949|euc-kr)$/i.test(arg))
  const effectiveEncoding = inheritedMs949 ? 'ms949' : encoding
  // Tomcat's stock ConsoleHandler uses UTF-8. ConPTY transcodes from the selected console page.
  const consoleEncoding = platform === 'win32' ? `${windowsConsoleEncoding(effectiveEncoding === 'auto' ? 'utf-8' : effectiveEncoding)}\n` : ''
  const version = await toolVersionOf(preset.tomcat) ?? /^tomcat-(\d+\.\d+(?:\.\d+)?)/.exec(preset.tomcat)?.[1]
  return { home, command: consoleEncoding + command, ...preparation, platform, effectiveEncoding, major: Number(version?.split('.')[0]) }
}

async function jdbcLibraries(contextEntries, home, extraLibraries, signal) {
  const drivers = [...new Set(contextEntries.filter(item => item.name === 'Resource').map(item => item.attrs.driverClassName))]
    .filter(driver => jarClassName(driver) && !driver.includes('/'))
  const missing = []
  const common = new Set()
  if (!drivers.length) return { missing, common }
  const installed = (await Promise.all((await tomcatJars(home, 'lib')).map(reference => allowedJar({ projectRoot: home, home: null, reference }))))
    .filter(Boolean)
  const find = async (jars, driver) => {
    for (const jar of jars) if (await jarHasClass(jar, driver, signal)) return jar
    return null
  }
  for (const driver of drivers) {
    if (await find(installed, driver)) continue
    const jar = await find(extraLibraries, driver)
    if (jar) common.add(jar.path)
    else missing.push(driver)
  }
  return { missing, common }
}

async function stageLibraries(directory, major, jars, common, webapp, eclipseBuild, signal) {
  if (!jars.length) return undefined
  const lib = path.join(directory, 'approved-lib')
  await fs.mkdir(lib)
  const commonLib = path.join(directory, 'lib')
  if (common.size) await fs.mkdir(commonLib)
  const usedNames = new Set((await tomcatJars(webapp, path.join('WEB-INF', 'lib'))).concat(eclipseBuild?.extraJars ?? [])
    .map(jar => path.basename(jar).toLowerCase()))
  const paths = []
  let index = 0
  for (const jar of jars) {
    let name
    do { name = `ezshell-approved-${++index}.jar` } while (usedNames.has(name))
    const staged = path.join(lib, name)
    await copyCheckedJar(jar, staged, signal)
    if (common.has(jar.path)) await fs.copyFile(staged, path.join(commonLib, name))
    paths.push(staged)
  }
  return { major, paths }
}

async function stageTomcat(plan, { preset, task, worktree, userData, prepareReload, eclipseBuild, contextEntries = [], javaFeature, extraLibraries = [], signal }) {
  const webapp = await webDirectory(worktree, preset.webapp)
  const conf = await directoryUnder(plan.home, 'conf')
  let server
  try { if (conf) server = await xmlFile(conf, 'server.xml') } catch { /* Report a localized error below. */ }
  if (!server) throw new Error('Tomcat server.xml을 읽을 수 없습니다.')
  const { missing, common } = await jdbcLibraries(contextEntries, plan.home, extraLibraries, signal)
  let approved
  const base = await makeBase(userData, preset.id, conf, async directory => {
    approved = await stageLibraries(directory, plan.major, extraLibraries, common, webapp, eclipseBuild, signal)
    return tomcatConfiguration(server, preset, webapp, eclipseBuild, contextEntries, approved)
  }, plan.effectiveEncoding ?? 'auto')
  try {
    let reload = {}
    if (preset.hotReload !== 'off') {
      const layout = eclipseBuild?.layout ?? await tomcatLayout(worktree, task.cwd, webapp, plan.home)
      if (layout.classpath && approved) {
        const originals = new Set(extraLibraries.map(jar => jar.path))
        layout.classpath = [...layout.classpath.filter(jar => !originals.has(jar)), ...approved.paths]
      }
      reload = await prepareReload({ layout, worktree, cwd: task.cwd, mode: preset.hotReload, args: task.enhancedArgs })
    }
    const { jvmArgs = [], ...hot } = reload
    const opts = catalinaOptions([...vmOptionTokens(preset.vmArgs), ...javaLogOptions(plan.effectiveEncoding ?? 'auto', javaFeature), ...jvmArgs], plan.platform)
    return { ...task, ...hot, logEncoding: plan.effectiveEncoding, command: plan.command, env: { ...task.env, CATALINA_HOME: plan.home, CATALINA_BASE: base.directory, CATALINA_OPTS: opts,
      ...(task.javaHome && { JRE_HOME: task.javaHome }) }, expectedUrl: `http://127.0.0.1:${preset.port}${encodeURI(preset.contextPath)}`,
      ...(missing.length && { missingJdbcDrivers: missing }), cleanup: base.cleanup }
  } catch (error) { await base.cleanup(); throw error }
}

module.exports = { validateTomcat, validContextPath, vmOptionTokens, workspaceVmArguments, antTargets, webDirectory, webappCandidates, planTomcat, stageTomcat, tomcatLayout, tomcatJars, tomcatConfiguration, catalinaOptions, closeTomcatBases }
