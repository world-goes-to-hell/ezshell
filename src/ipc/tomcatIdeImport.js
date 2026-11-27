const fs = require('node:fs/promises')
const path = require('node:path')
const { parse } = require('jsonc-parser')
const { parseXml } = require('../sessionImport/filezilla.js')
const { isLocalFilePath } = require('../localKeyPath.js')
const { readPrefix, resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { presetRelative } = require('./runPresetStore.js')
const { validContextPath, vmOptionTokens, webDirectory, workspaceVmArguments } = require('./tomcatRun.js')

const MAX_BYTES = 256 * 1024
const MAX_CONFIGS = 24
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u
const SMART_TOMCAT = 'com.poratu.idea.plugins.tomcat'
const IDEA_TOMCAT = new Set(['#com.intellij.j2ee.web.tomcat.TomcatRunConfigurationFactory',
  'com.intellij.j2ee.web.tomcat.TomcatRunConfigurationFactory', 'TomcatRunConfiguration'])
const RSP_TOMCAT = /^org\.jboss\.ide\.eclipse\.as\.server\.tomcat\.\d+$/
const children = (node, name) => Array.isArray(node?.children) ? node.children.filter(item => item?.name === name) : []
const child = (node, name) => children(node, name)[0]
const options = node => new Map(children(node, 'option').map(({ attrs }) => [attrs.name, attrs.value]))
const safeName = value => typeof value === 'string' && !CONTROL.test(value) && value.trim().slice(0, 120)
const portOf = value => (typeof value === 'number' || typeof value === 'string') &&
  /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : undefined

function relativePath(root, value) {
  if (!sameOrInside(root, value)) return null
  try { return presetRelative(path.relative(root, value) || '.') } catch { return null }
}

/** Resolve supported project macros without evaluating commands, environment or other IDE variables. */
function projectPath(root, base, value, from = base) {
  if (typeof value !== 'string' || !value || value.length > 4096 || CONTROL.test(value)) return null
  const expanded = value.replace(/^file:\/\/(?=\$PROJECT_DIR\$|\$MODULE_DIR\$)/, '')
    .replace(/^\$PROJECT_DIR\$(?=$|[\\/])|^\$\{workspaceFolder\}(?=$|[\\/])/, () => base)
    .replace(/^\$MODULE_DIR\$(?=$|[\\/])/, () => from)
  if (/\$\{|\$[A-Z_]+\$/i.test(expanded)) return null
  if (!path.isAbsolute(expanded) && /^[/\\]|:/.test(expanded)) return null
  const location = path.resolve(from, expanded)
  return isLocalFilePath(location) && relativePath(root, location) !== null ? location : null
}

async function exactEntry(file, directory = false) {
  if (!file || !path.isAbsolute(file) || !isLocalFilePath(file) || CONTROL.test(file) ||
      path.normalize(file).split(/[\\/]+/).some(part => part.toLowerCase() === '.git')) return null
  const entry = await resolveLocalPreviewPath(file).catch(() => null)
  return entry && path.relative(entry.path, file) === '' && (directory ? entry.stat.isDirectory() : entry.stat.isFile()) ? entry : null
}

async function readConfiguration(file, allowed) {
  if (!allowed()) throw new Error('먼저 잠금을 해제해 주세요.')
  const entry = await exactEntry(file)
  if (!entry) return null
  if (entry.stat.size > MAX_BYTES) throw new Error('IDE 설정 파일이 너무 큽니다.')
  const bytes = await readPrefix(entry, MAX_BYTES + 1, allowed)
  if (bytes.length > MAX_BYTES) throw new Error('IDE 설정 파일이 너무 큽니다.')
  const body = bytes.toString('utf8').replace(/^\uFEFF/, '').trim()
  if (body.startsWith('<')) return parseXml(body)
  const errors = []
  const config = parse(body, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error('IDE 설정 파일을 읽지 못했습니다.')
  return config
}

async function matchingXml(base, relative, pattern) {
  const dir = await exactEntry(path.join(base, relative), true)
  if (!dir) return []
  const found = []
  const entries = await fs.opendir(dir.path)
  for await (const entry of entries) {
    if (entry.isFile() && !CONTROL.test(entry.name) && pattern.test(entry.name)) found.push(path.join(dir.path, entry.name))
    if (found.length === 32) break
  }
  return found.sort()
}

function ideaCandidates(xml) {
  const managers = xml?.name === 'component' ? [xml] : children(xml, 'component')
  const configs = xml?.name === 'configuration' ? [xml] : managers
    .filter(node => ['RunManager', 'ProjectRunConfigurationManager'].includes(node.attrs.name)).flatMap(node => children(node, 'configuration'))
  return configs.flatMap(config => {
    const { type, name, factoryName } = config.attrs
    if (config.attrs.default === 'true') return []
    const fields = options(config)
    if (type === SMART_TOMCAT) return [{ name, source: 'Smart Tomcat', port: fields.get('port') ?? 8080,
      context: fields.get('contextPath'), web: fields.get('docBase'), vm: fields.get('vmOptions') }]
    if (!IDEA_TOMCAT.has(type) || factoryName && factoryName.toLowerCase() !== 'local') return []
    const server = options(child(config, 'server-settings'))
    const run = children(config, 'ConfigurationWrapper').find(node => node.attrs.RunnerId === 'Run')
    const vm = options(run).get('VM_PARAMETERS') ?? fields.get('VM_PARAMETERS')
    const deploy = child(config, 'deployment')?.children.filter(node => ['artifact', 'file', 'external'].includes(node.name)) ?? []
    const common = { name, source: 'IntelliJ', port: server.get('HTTP_PORT') ?? fields.get('HTTP_PORT'), vm }
    return deploy.length ? deploy.slice(0, MAX_CONFIGS).map(item => ({ ...common,
      name: deploy.length > 1 && safeName(item.attrs.name) ? `${name} · ${item.attrs.name}` : name,
      context: options(child(item, 'settings')).get('CONTEXT_PATH') ?? options(item).get('CONTEXT_PATH'),
      artifact: item.name === 'artifact' ? item.attrs.name : undefined,
      web: item.name === 'artifact' ? undefined : item.attrs.path ?? item.attrs.name })) : [common]
  })
}

function vscodeCandidates(config) {
  const serverType = config?.['org.jboss.tools.rsp.server.typeId']
  if (typeof serverType === 'string' && RSP_TOMCAT.test(serverType)) {
    const deployments = Object.values(config.deployables ?? {}).slice(0, MAX_CONFIGS)
    const common = { name: config.id, source: 'VS Code · Community Server Connectors',
      port: config['server.http.port'], catalina: config['server.base.dir'] ?? config['server.home.dir'],
      vm: [true, 'true'].includes(config['args.override.boolean']) ? config['args.vm.override.string'] : undefined }
    return deployments.length ? deployments.map(item => {
      const output = item?.options?.option?.['deployment.output.name']
      return { ...common, deploy: item?.path, context: safeName(output) ? `/${output.replace(/\.war$/i, '')}` : undefined }
    }) : [common]
  }
  const launches = Array.isArray(config?.configurations) ? config.configurations : [config]
  return launches.slice(0, MAX_CONFIGS).filter(item => item?.type === 'java' && item.request === 'launch' &&
    item.mainClass === 'org.apache.catalina.startup.Bootstrap')
    .map(item => ({ name: item.name, source: 'VS Code', vm: item.vmArgs, cwd: item.cwd }))
}

function tokenizeVm(raw) {
  if (raw === undefined) return []
  const text = Array.isArray(raw) && raw.every(arg => typeof arg === 'string' && !/["']/u.test(arg))
    ? raw.map(arg => /\s/u.test(arg) ? `"${arg}"` : arg).join(' ') : raw
  if (typeof text !== 'string') throw new Error('VM 인자 형식')
  return vmOptionTokens(text.replace(/[\r\n]+/g, ' '), 'VM 인자 형식', true)
}

function importVm(tokens) {
  const portable = tokens.filter(arg => !/["']|\$\{|\$[A-Z_]+\$/i.test(arg) &&
    /^(?:-D[\w.-]+(?:=.*)?|-X(?:ms|mx|ss)\d+[kmg]?|-XX:[+-]Use\w+GC|-(?:ea|da)|--add-(?:opens|exports|reads)=[\w.$/-]+=[\w.$,-]+)$/i.test(arg) &&
    !/^-D(?:java\.system\.class\.loader|java\.library\.path|java\.security\..*|java\.util\.logging\.manager)(?:=|$)/i.test(arg))
  const { vmArgs } = workspaceVmArguments(portable.map(arg => /\s/u.test(arg) ? `"${arg}"` : arg).join(' '))
  return vmArgs
}

async function candidatesIn(base, allowed, notes) {
  const files = [
    ...await matchingXml(base, '.run', /\.run\.xml$/i),
    ...await matchingXml(base, '.idea/runConfigurations', /\.xml$/i),
    path.join(base, '.idea/workspace.xml'),
    ...await matchingXml(base, '.vscode', /\.json$/i)
  ]
  const candidates = []
  for (const file of files) {
    if (!allowed()) break
    try {
      const config = await readConfiguration(file, allowed)
      candidates.push(...(/\.xml$/i.test(file) ? ideaCandidates(config) : vscodeCandidates(config)))
    } catch { notes.add('읽을 수 없는 IDE 설정 파일이 있습니다.') }
    if (candidates.length >= MAX_CONFIGS) break
  }
  return candidates.slice(0, MAX_CONFIGS)
}

async function artifactFolder(base, name, allowed) {
  for (const file of await matchingXml(base, '.idea/artifacts', /\.xml$/i)) {
    if (!allowed()) return
    const xml = await readConfiguration(file, allowed).catch(() => null)
    const artifact = children(xml, 'artifact').find(item => item.attrs.name === name)
    if (artifact) return child(artifact, 'output-path')?.text
  }
}

async function webFolder(root, base, cwd, candidate, artifact) {
  const deployed = projectPath(root, base, candidate.deploy)
  const explicit = projectPath(root, base, candidate.web ?? artifact, candidate.webBase ?? cwd)
  const folders = candidate.web ? [explicit] : [
    explicit,
    deployed, ...['src/main/webapp', 'WebContent', 'WebRoot', '.'].map(folder => path.resolve(cwd, folder)),
    ...(deployed && deployed !== cwd ? ['src/main/webapp', 'WebContent', 'WebRoot'].map(folder => path.resolve(deployed, folder)) : [])
  ]
  const usable = new Set()
  for (const folder of folders.filter(Boolean)) {
    const relative = relativePath(root, folder)
    if (relative === null) continue
    const verified = await webDirectory(root, relative).catch(() => null)
    if (verified && path.relative(verified, folder) === '') usable.add(relative)
    if ((folder === explicit || folder === deployed) && usable.has(relative)) return relative
  }
  return usable.size === 1 ? [...usable][0] : undefined
}

/** Inspect only the worktree and the selected module. A picked IDE file authorizes only that one file. */
async function importTomcatIde(root, cwd, file, allowed = () => true) {
  const notes = new Set()
  const found = []
  if (file) {
    const config = await readConfiguration(file, allowed).catch(() => { throw new Error('선택한 IDE 설정 파일을 읽지 못했습니다.') })
    if (!config) throw new Error('이 PC의 일반 IDE 설정 파일을 선택해 주세요.')
    const candidates = config.name && Array.isArray(config.children) ? ideaCandidates(config) : vscodeCandidates(config)
    found.push(...candidates.map(candidate => ({ candidate, base: root })))
  } else {
    for (const base of new Set([cwd, root])) {
      const candidates = await candidatesIn(base, allowed, notes)
      found.push(...candidates.map(candidate => ({ candidate, base })))
    }
  }
  const servers = new Map()
  const artifacts = new Map()
  for (const { candidate, base } of found.slice(0, MAX_CONFIGS)) {
    if (!allowed()) break
    const name = safeName(candidate.name) || candidate.source
    let tokens = []
    let vmArgs
    try {
      tokens = tokenizeVm(candidate.vm)
      vmArgs = importVm(tokens)
      if (tokens.length > vmOptionTokens(vmArgs).length) notes.add('IDE 전용, 자격 증명 또는 지원 범위 밖의 VM 인자를 건너뛰었습니다.')
    } catch { notes.add('일부 VM 인자를 읽지 못했습니다.') }
    const catalina = candidate.catalina ?? tokens.find(arg => /^-Dcatalina\.base=/i.test(arg))?.split('=').slice(1).join('=')
    const working = projectPath(root, base, candidate.cwd) ?? base
    const catalinaPath = projectPath(root, base, catalina, working)
    const config = catalinaPath && await readConfiguration(path.join(catalinaPath, 'conf/server.xml'), allowed).catch(() => null)
    const services = config?.name === 'Server' ? children(config, 'Service') : []
    const connector = services.flatMap(service => children(service, 'Connector')).find(({ attrs }) =>
      /^(?:HTTP\/|org\.apache\.coyote\.http11\.|$)/i.test(attrs.protocol ?? '') && attrs.SSLEnabled !== 'true')
    const contexts = services.flatMap(service => children(child(service, 'Engine'), 'Host'))
      .flatMap(host => children(host, 'Context').map(context => ({ context: context.attrs, host: host.attrs })))
    const single = contexts.length === 1 ? contexts[0] : undefined
    const port = portOf(candidate.port) ?? portOf(connector?.attrs.port)
    const contextPath = candidate.context ?? (single && (single.context.path || '/'))
    const artifactKey = JSON.stringify([base, candidate.artifact])
    if (candidate.artifact && !artifacts.has(artifactKey)) artifacts.set(artifactKey, await artifactFolder(base, candidate.artifact, allowed))
    const docBase = !candidate.artifact && single?.context.docBase
    const hostBase = single && projectPath(root, base, single.host.appBase ?? 'webapps', catalinaPath)
    const web = candidate.web ?? (docBase && (path.isAbsolute(docBase) || hostBase) ? docBase : undefined)
    const webapp = await webFolder(root, base, cwd, { ...candidate, web, webBase: candidate.web ? cwd : hostBase }, artifacts.get(artifactKey))
    const contextFile = webapp && path.join(root, webapp, 'META-INF/context.xml')
    const context = await readConfiguration(contextFile, allowed).catch(() => null)
    const server = { name, source: candidate.source, ...(webapp && { webapp }), ...(port && { port }), ...(vmArgs && { vmArgs }),
      ...(validContextPath(contextPath) && { contextPath }),
      ...(context?.name === 'Context' && { contextXml: relativePath(root, contextFile) }) }
    servers.set(JSON.stringify(server), server)
  }
  return { servers: [...servers.values()], notes: [...notes] }
}

module.exports = { importTomcatIde }
