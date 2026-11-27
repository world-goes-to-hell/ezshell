const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { findBuild, featureOf, validSelection, VERSION } = require('./providers.js')
const { downloadArchive, SHA256 } = require('./download.js')
const { findHotswapAgent, AGENT_VERSION, MAX_AGENT_BYTES } = require('./enhancedProviders.js')
const { extractArchive } = require('./archive.js')
const { findLocalJdks, unpackedHome, readRelease } = require('./discovery.js')
const { findApacheBuild, validApacheSelection } = require('./apacheProviders.js')
const { LOCAL_TOOL_ID, seriesOf, hasApacheToolHome, unpackedApacheHome,
  inspectLocalTomcat6, findLocalApacheTools } = require('./apacheToolHome.js')
const { findGradleBuild, findNodeBuild } = require('./gradleNodeProviders.js')
const { hasGradleNodeHome, unpackedGradleNodeHome, findLocalGradleNodeTools } = require('./gradleNodeHome.js')

const MAX_INDEX_BYTES = 1024 * 1024
const LOOKUP_TTL_MS = 5 * 60 * 1000
const LOCAL_ID = /^local-[0-9a-f]{24}$/
const stagingPaths = new Set()
const TEMPORARY_DIR = /^\.(?:install|remove)-/
const AGENT = 'hotswap-agent'
const AGENT_JAR = 'hotswap-agent.jar'
const TOOLS = 'tools'
const GRADLE_NODE_SERIES = { gradle: 'current', node: 'lts' }
const isGradleNode = tool => typeof tool === 'string' && Object.hasOwn(GRADLE_NODE_SERIES, tool)
const validToolSelection = (tool, series) => isGradleNode(tool) ? GRADLE_NODE_SERIES[tool] === series : validApacheSelection(tool, series)
const buildId = ({ vendor, version, arch }) => `${vendor}-${version}-${arch}`
const publicJdk = ({ home: _home, relativeHome: _relativeHome, ...entry }) => entry
const toolId = ({ tool, version }) => `${tool}-${version}`
const publicTool = ({ home: _home, ...entry }) => entry
const samePath = (left, right) => path.relative(left, right) === ''

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function removeInside(root, target) {
  if (!isInside(root, target)) throw new Error('JDK 보관함 밖의 파일은 지울 수 없습니다.')
  fs.rmSync(target, { recursive: true, force: true })
}

function hasLiveOwner(name) {
  const pid = Number(/^\.(?:install|remove)-(\d+)-/.exec(name)?.[1])
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

async function installedSize(root, signal) {
  let size = 0
  const directories = [root]
  for (const directory of directories) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted()
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) directories.push(filename)
      if (entry.isFile()) size += (await fs.promises.stat(filename)).size
    }
  }
  return size
}

function indexEntry(value, platform) {
  const validHome = value?.relativeHome === '.' || (platform === 'darwin' && value?.relativeHome === path.join('Contents', 'Home'))
  if (!validHome || !validSelection(value.vendor, value.feature) || typeof value.version !== 'string' || !VERSION.test(value.version)
    || featureOf(value.version) !== value.feature || typeof value.arch !== 'string' || !/^[a-z][a-z0-9_]{1,12}$/.test(value.arch)
    || value.id !== buildId(value)) return null
  return { id: value.id, vendor: value.vendor, version: value.version, feature: value.feature, arch: value.arch,
    managed: true, relativeHome: value.relativeHome,
    ...(Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0 ? { sizeBytes: value.sizeBytes } : {}) }
}

function createRuntimes({ userData, platform = process.platform, arch = process.arch, env = process.env, home, request } = {}) {
  const filename = path.join(userData, 'runtimes.json')
  const localToolsFile = path.join(userData, 'local-apache-tools.json')
  const cache = new Map()
  let operation = null
  let cleanedAtFirstUse = false

  function index() {
    try {
      const stat = fs.lstatSync(filename)
      if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return []
      const { jdks } = JSON.parse(fs.readFileSync(filename, 'utf8'))
      return Array.isArray(jdks) ? jdks.map(value => indexEntry(value, platform)).filter(Boolean) : []
    } catch { return [] }
  }

  function writeJson(target, value) {
    const temporary = `${target}.${randomUUID()}.part`
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, target)
    } finally { fs.rmSync(temporary, { force: true }) }
  }

  const writeIndex = jdks => writeJson(filename, { jdks })

  function managedBase(create = false, kind = 'jdk') {
    let directory = fs.realpathSync(userData)
    for (const segment of ['runtimes', kind]) {
      directory = path.join(directory, segment)
      if (create) {
        try { fs.mkdirSync(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      if (!fs.lstatSync(directory).isDirectory()) throw new Error('JDK 보관함 경로를 확인할 수 없습니다.')
    }
    return directory
  }

  function cleanStaging(kind) {
    let root
    let entries
    try {
      root = managedBase(false, kind)
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || !TEMPORARY_DIR.test(entry.name) || hasLiveOwner(entry.name)) continue
      const folder = path.join(root, entry.name)
      if (stagingPaths.has(folder)) continue
      try { removeInside(root, folder) } catch { /* A busy file can be retried on the next install. */ }
    }
  }

  function cleanAtFirstUse() {
    if (cleanedAtFirstUse) return
    cleanedAtFirstUse = true
    cleanStaging('jdk')
    cleanStaging(AGENT)
    cleanStaging(TOOLS)
  }

  function managedHome(entry) {
    try {
      const root = managedBase()
      const target = path.join(root, entry.id)
      const location = path.join(target, entry.relativeHome)
      if (!samePath(fs.realpathSync(location), location) || readRelease(location, platform)?.feature !== entry.feature) return null
      return location
    } catch { return null }
  }

  const local = () => findLocalJdks({ env, home, platform })

  function list() {
    cleanAtFirstUse()
    const managed = index().map(entry => ({ ...entry, home: managedHome(entry) })).filter(entry => entry.home)
    const found = local().filter(entry => !managed.some(installed => samePath(installed.home, entry.home)))
    const sort = (a, b) => b.feature - a.feature || a.vendor.localeCompare(b.vendor) || b.version.localeCompare(a.version, undefined, { numeric: true })
    return [...managed.sort(sort), ...found.sort(sort)].map(publicJdk)
  }

  function javaHomeOf(id) {
    cleanAtFirstUse()
    if (typeof id !== 'string' || id.length > 120) return null
    if (LOCAL_ID.test(id)) return local().find(entry => entry.id === id)?.home ?? null
    const entry = index().find(record => record.id === id)
    return entry ? managedHome(entry) : null
  }

  function registeredTools() {
    try {
      const stat = fs.lstatSync(localToolsFile)
      if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) return []
      const paths = JSON.parse(fs.readFileSync(localToolsFile, 'utf8'))
      return Array.isArray(paths) ? paths.filter(value => typeof value === 'string').slice(0, 100) : []
    } catch { return [] }
  }

  const localTools = () => [
    ...findLocalApacheTools({ env, home, platform, registered: registeredTools() }),
    ...findLocalGradleNodeTools({ env, home, platform })
  ]

  function managedTool(root, id) {
    const parts = /^(tomcat|maven|ant|gradle|node)-(\d{1,4}\.\d{1,4}(?:\.\d{1,4})?)$/.exec(id)
    if (!parts) return null
    const [, tool, version] = parts
    if (tool !== 'gradle' && version.split('.').length !== 3) return null
    const series = isGradleNode(tool) ? GRADLE_NODE_SERIES[tool] : seriesOf(tool, version)
    if (!series || (tool === 'tomcat' && series === '6')) return null
    try {
      const directory = path.join(root, id)
      if (!fs.lstatSync(directory).isDirectory()) return null
      const record = path.join(directory, 'release.json')
      const stat = fs.lstatSync(record)
      if (!stat.isFile() || stat.size > 1024) return null
      const { sizeBytes } = JSON.parse(fs.readFileSync(record, 'utf8'))
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null
      const home = path.join(directory, 'home')
      const validHome = isGradleNode(tool) ? hasGradleNodeHome : hasApacheToolHome
      if (!validHome(home, tool, platform)) return null
      return { id, tool, version, series, managed: true, sizeBytes, home }
    } catch { return null }
  }

  function listTools() {
    cleanAtFirstUse()
    let managed = []
    try {
      const root = managedBase(false, TOOLS)
      managed = fs.readdirSync(root).map(id => managedTool(root, id)).filter(Boolean)
    } catch { /* The tool library may not exist yet. */ }
    const found = localTools().filter(entry => !managed.some(installed => samePath(installed.home, entry.home)))
    const sort = (a, b) => a.tool.localeCompare(b.tool) || (b.version ?? '').localeCompare(a.version ?? '', 'en', { numeric: true })
    return [...managed.sort(sort), ...found.sort(sort)].map(publicTool)
  }

  function toolHomeOf(id) {
    cleanAtFirstUse()
    if (typeof id !== 'string' || id.length > 120) return null
    if (LOCAL_TOOL_ID.test(id)) return localTools().find(entry => entry.id === id)?.home ?? null
    try { return managedTool(managedBase(false, TOOLS), id)?.home ?? null } catch { return null }
  }

  function registerTomcat6(directory) {
    const entry = inspectLocalTomcat6(directory, platform)
    if (!entry) throw new Error('선택한 폴더에서 Tomcat 6 설치를 확인할 수 없습니다.')
    const known = registeredTools().filter(folder => !samePath(folder, entry.home))
    writeJson(localToolsFile, [entry.home, ...known].slice(0, 100))
    return publicTool(entry)
  }

  function agentRecord(root, version) {
    try {
      const directory = path.join(root, version)
      const recordFile = path.join(directory, 'release.json')
      if (!fs.lstatSync(directory).isDirectory()) return null
      const record = fs.lstatSync(recordFile)
      if (!record.isFile() || record.size > 1024) return null
      const metadata = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
      if (!SHA256.test(metadata.sha256) || !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes <= 0 || metadata.sizeBytes > MAX_AGENT_BYTES) return null
      const jar = path.join(directory, AGENT_JAR)
      const stat = fs.lstatSync(jar)
      if (!stat.isFile() || stat.size !== metadata.sizeBytes) return null
      if (createHash('sha256').update(fs.readFileSync(jar)).digest('hex') !== metadata.sha256) return null
      return { version, jar }
    } catch { return null }
  }

  function agentsIn(root) {
    return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && AGENT_VERSION.test(entry.name))
      .map(entry => entry.name).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  }

  function installedAgent() {
    cleanAtFirstUse()
    try {
      const root = managedBase(false, AGENT)
      for (const version of agentsIn(root)) {
        const agent = agentRecord(root, version)
        if (agent) return agent
      }
    } catch { /* No installed agent. */ }
    return null
  }

  function hotswapAgentStatus() {
    const agent = installedAgent()
    return agent ? { installed: true, version: agent.version } : { installed: false }
  }

  function hotswapAgentPath() { return installedAgent()?.jar ?? null }

  function isJbr(id) {
    const entry = index().find(item => item.id === id && item.vendor === 'jbr')
    return Boolean(entry && managedHome(entry))
  }

  // HotswapAgent reads private JDK fields to learn which file a stream came from (its MyBatis plugin
  // does this for every mapper XML). On Java 17+ that throws unless the packages are opened, and the
  // app fails to start with "Cannot resolve reference to bean 'sqlSessionFactory'".
  // See docs/fix/2026-11-27-enhanced-reload-mybatis-add-opens.md.
  const HOTSWAP_AGENT_OPENS = ['--add-opens=java.base/sun.nio.ch=ALL-UNNAMED', '--add-opens=java.base/java.io=ALL-UNNAMED']

  function enhancedJvmArgs(id) {
    const jar = isJbr(id) ? hotswapAgentPath() : null
    return jar ? ['-XX:+AllowEnhancedClassRedefinition', '-XX:HotswapAgent=external', `-javaagent:${jar}`, ...HOTSWAP_AGENT_OPENS] : null
  }

  async function getBuild(vendor, feature, signal) {
    if (!validSelection(vendor, feature)) throw new Error('JDK 공급자와 버전을 선택해 주세요.')
    const key = `${vendor}:${feature}`
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.build
    const build = await findBuild(vendor, feature, { platform, arch, request, signal })
    signal?.throwIfAborted()
    cache.set(key, { build, expires: Date.now() + LOOKUP_TTL_MS })
    return build
  }

  async function available(vendor, feature) {
    cleanAtFirstUse()
    const build = await getBuild(vendor, feature)
    if (!build) return null
    const { url: _url, sha256: _sha256, sha512: _sha512, archive: _archive, ...summary } = build
    return { id: buildId(build), ...summary }
  }

  async function getToolBuild(tool, series, signal) {
    if (!validToolSelection(tool, series)) throw new Error('개발 도구와 버전 계열을 선택해 주세요.')
    const key = `tool:${tool}:${series}`
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.build
    const options = { platform, arch, request, signal }
    const build = await (tool === 'gradle' ? findGradleBuild(options) : tool === 'node' ? findNodeBuild(options) : findApacheBuild(tool, series, options))
    signal?.throwIfAborted()
    cache.set(key, { build, expires: Date.now() + LOOKUP_TTL_MS })
    return build
  }

  async function toolAvailable(tool, series) {
    const build = await getToolBuild(tool, series)
    if (!build) return null
    const { url: _url, sha256: _sha256, sha512: _sha512, archive: _archive, distributionFolder: _folder, ...summary } = build
    return { id: toolId(build), ...summary }
  }

  async function withInstallation(kind, vendor, feature, onProgress, run) {
    if (operation) throw new Error('이미 개발 도구를 받고 있습니다.')
    const controller = new AbortController()
    const { signal } = controller
    operation = controller
    let staging
    let root
    const report = (phase, received, total) => onProgress({ vendor, feature, phase, received, total })
    try {
      cleanAtFirstUse()
      cleanStaging(kind)
      report('lookup', 0, null)
      return await run({ signal, report, stagingIn(base) {
        root = base
        staging = fs.mkdtempSync(path.join(root, `.install-${process.pid}-`))
        stagingPaths.add(staging)
        return staging
      } })
    } finally {
      try { if (staging) removeInside(root, staging) } finally {
        stagingPaths.delete(staging)
        operation = null
        onProgress(null)
      }
    }
  }

  async function install(vendor, feature, onProgress = () => {}) {
    if (!validSelection(vendor, feature)) throw new Error('JDK 공급자와 버전을 선택해 주세요.')
    return withInstallation('jdk', vendor, feature, onProgress, async ({ signal, report, stagingIn }) => {
      const build = await getBuild(vendor, feature, signal)
      signal.throwIfAborted()
      if (!build) throw new Error('현재 플랫폼에 맞는 공개 JDK 빌드가 없습니다.')
      const id = buildId(build)
      const current = index().find(entry => entry.id === id)
      if (current && managedHome(current)) return publicJdk(current)

      const root = managedBase(true)
      const destination = path.join(root, id)
      if (fs.existsSync(destination)) throw new Error('같은 이름의 JDK 폴더가 이미 있습니다.')
      const staging = stagingIn(root)
      const archive = path.join(staging, `jdk.${build.archive}`)
      report('download', 0, build.sizeBytes ?? null)
      const bytes = await downloadArchive(build, archive, { request, signal, onProgress: (received, total) => report('download', received, total) })
      signal.throwIfAborted()
      report('unpack', bytes, bytes)
      const unpack = path.join(staging, 'contents')
      await extractArchive(archive, unpack, build.archive, signal)
      const { folder, relativeHome } = unpackedHome(unpack, platform, feature)
      const sizeBytes = await installedSize(folder, signal)
      signal.throwIfAborted()

      const entry = indexEntry({ id, vendor, version: build.version, feature, arch, relativeHome, sizeBytes }, platform)
      if (!entry) throw new Error('JDK 보관함의 기록을 만들 수 없습니다.')
      const records = index().filter(record => record.id !== id)
      // Publish the index first. Missing folders are ignored, so an interrupted rename is retryable.
      writeIndex([...records, entry])
      try { fs.renameSync(folder, destination) } catch (error) {
        writeIndex(records)
        throw error
      }
      return publicJdk(entry)
    })
  }

  async function installHotswapAgent(onProgress = () => {}) {
    return withInstallation(AGENT, AGENT, null, onProgress, async ({ signal, report, stagingIn }) => {
      const build = await findHotswapAgent({ request, signal })
      signal.throwIfAborted()
      if (!build) throw new Error('검증할 수 있는 HotswapAgent 릴리스가 없습니다.')
      const root = managedBase(true, AGENT)
      if (agentRecord(root, build.version)) return
      const target = path.join(root, build.version)
      const staging = stagingIn(root)
      report('download', 0, build.sizeBytes)
      const sizeBytes = await downloadArchive(build, path.join(staging, AGENT_JAR), { request, signal,
        onProgress: (received, total) => report('download', received, total) })
      signal.throwIfAborted()
      fs.writeFileSync(path.join(staging, 'release.json'), JSON.stringify({ sizeBytes, sha256: build.sha256.toLowerCase() }), { flag: 'wx', mode: 0o600 })
      const old = fs.existsSync(target) ? moveAside(root, target) : null
      try { fs.renameSync(staging, target) } catch (error) {
        if (old) fs.renameSync(old, target)
        throw error
      }
      if (old) removeInside(root, old)
    })
  }

  async function installTool(tool, series, onProgress = () => {}) {
    if (!validToolSelection(tool, series)) throw new Error('개발 도구와 버전 계열을 선택해 주세요.')
    return withInstallation(TOOLS, tool, null, onProgress, async ({ signal, report, stagingIn }) => {
      const build = await getToolBuild(tool, series, signal)
      signal.throwIfAborted()
      if (!build) throw new Error('현재 플랫폼에 맞는 개발 도구 배포본이 없습니다.')
      const id = toolId(build)
      const root = managedBase(true, TOOLS)
      const current = managedTool(root, id)
      if (current) return publicTool(current)
      const destination = path.join(root, id)
      if (fs.existsSync(destination)) throw new Error('같은 이름의 개발 도구 폴더가 이미 있습니다.')
      const staging = stagingIn(root)
      const archive = path.join(staging, `tool.${build.archive}`)
      report('download', 0, null)
      const bytes = await downloadArchive(build, archive, { request, signal,
        onProgress: (received, total) => report('download', received, total) })
      signal.throwIfAborted()
      report('unpack', bytes, bytes)
      const unpack = path.join(staging, 'contents')
      await extractArchive(archive, unpack, build.archive, signal, { allowRepeatedDirectories: tool === 'maven' })
      const unpackedHome = isGradleNode(tool) ? unpackedGradleNodeHome : unpackedApacheHome
      const folder = unpackedHome(unpack, build, platform)
      const sizeBytes = await installedSize(folder, signal)
      signal.throwIfAborted()
      const ready = path.join(staging, 'ready')
      fs.mkdirSync(ready)
      fs.renameSync(folder, path.join(ready, 'home'))
      fs.writeFileSync(path.join(ready, 'release.json'), JSON.stringify({ sizeBytes }), { flag: 'wx', mode: 0o600 })
      fs.renameSync(ready, destination)
      return { id, tool, version: build.version, series, managed: true, sizeBytes }
    })
  }

  function moveAside(root, folder) {
    if (!fs.lstatSync(folder).isDirectory() || !samePath(fs.realpathSync(folder), folder)) throw new Error('보관함 밖의 파일은 지울 수 없습니다.')
    const hidden = path.join(root, `.remove-${process.pid}-${randomUUID()}`)
    fs.renameSync(folder, hidden)
    return hidden
  }

  function remove(id) {
    if (operation) throw new Error('JDK를 받은 다음 다시 시도해 주세요.')
    cleanAtFirstUse()
    const records = index()
    if (!records.some(entry => entry.id === id)) throw new Error('ezShell에서 받은 JDK만 지울 수 있습니다.')
    const root = managedBase()
    const folder = path.join(root, id)
    const hidden = moveAside(root, folder)
    try { writeIndex(records.filter(entry => entry.id !== id)) } catch (error) {
      fs.renameSync(hidden, folder)
      throw error
    }
    removeInside(root, hidden)
  }

  function removeHotswapAgent() {
    if (operation) throw new Error('개발 도구를 받은 다음 다시 시도해 주세요.')
    const root = managedBase(false, AGENT)
    for (const version of agentsIn(root)) removeInside(root, moveAside(root, path.join(root, version)))
  }

  function removeTool(id) {
    if (operation) throw new Error('개발 도구를 받은 다음 다시 시도해 주세요.')
    if (typeof id !== 'string' || id.length > 120 || LOCAL_TOOL_ID.test(id)) throw new Error('ezShell에서 받은 도구만 지울 수 있습니다.')
    const root = managedBase(false, TOOLS)
    if (!managedTool(root, id)) throw new Error('ezShell에서 받은 도구만 지울 수 있습니다.')
    removeInside(root, moveAside(root, path.join(root, id)))
  }

  function cancel() {
    if (!operation || operation.signal.aborted) return false
    operation.abort()
    return true
  }

  return { list, available, install, remove, cancel, javaHomeOf, isJbr, enhancedJvmArgs,
    listTools, toolHomeOf, toolAvailable, installTool, removeTool, registerTomcat6,
    hotswapAgentStatus, hotswapAgentPath, installHotswapAgent, removeHotswapAgent }
}

module.exports = { createRuntimes }
