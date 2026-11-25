const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { findBuild, featureOf, validSelection, VERSION } = require('./providers.js')
const { downloadArchive } = require('./download.js')
const { extractArchive } = require('./archive.js')
const { findLocalJdks, unpackedHome, readRelease } = require('./discovery.js')

const MAX_INDEX_BYTES = 1024 * 1024
const LOOKUP_TTL_MS = 5 * 60 * 1000
const LOCAL_ID = /^local-[0-9a-f]{24}$/
const stagingPaths = new Set()
const TEMPORARY_DIR = /^\.(?:install|remove)-/
const buildId = ({ vendor, version, arch }) => `${vendor}-${version}-${arch}`
const publicJdk = ({ home: _home, relativeHome: _relativeHome, ...entry }) => entry
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

  function writeIndex(jdks) {
    const temporary = `${filename}.${randomUUID()}.part`
    try {
      fs.writeFileSync(temporary, JSON.stringify({ jdks }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, filename)
    } finally { fs.rmSync(temporary, { force: true }) }
  }

  function managedBase(create = false) {
    let directory = fs.realpathSync(userData)
    for (const segment of ['runtimes', 'jdk']) {
      directory = path.join(directory, segment)
      if (create) {
        try { fs.mkdirSync(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      if (!fs.lstatSync(directory).isDirectory()) throw new Error('JDK 보관함 경로를 확인할 수 없습니다.')
    }
    return directory
  }

  function cleanStaging() {
    let root
    let entries
    try {
      root = managedBase()
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
    cleanStaging()
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
    const { url: _url, sha256: _sha256, archive: _archive, ...summary } = build
    return { id: buildId(build), ...summary }
  }

  async function install(vendor, feature, onProgress = () => {}) {
    if (!validSelection(vendor, feature)) throw new Error('JDK 공급자와 버전을 선택해 주세요.')
    if (operation) throw new Error('이미 JDK를 받고 있습니다.')
    const controller = new AbortController()
    const { signal } = controller
    operation = controller
    let staging
    let root
    const report = (phase, received, total) => onProgress({ vendor, feature, phase, received, total })
    try {
      cleanedAtFirstUse = true
      cleanStaging()
      report('lookup', 0, null)
      const build = await getBuild(vendor, feature, signal)
      signal.throwIfAborted()
      if (!build) throw new Error('현재 플랫폼에 맞는 공개 JDK 빌드가 없습니다.')
      const id = buildId(build)
      const current = index().find(entry => entry.id === id)
      if (current && managedHome(current)) return publicJdk(current)

      root = managedBase(true)
      const destination = path.join(root, id)
      if (fs.existsSync(destination)) throw new Error('같은 이름의 JDK 폴더가 이미 있습니다.')
      staging = fs.mkdtempSync(path.join(root, `.install-${process.pid}-`))
      stagingPaths.add(staging)
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
    } finally {
      try { if (staging) removeInside(root, staging) } finally {
        stagingPaths.delete(staging)
        operation = null
        onProgress(null)
      }
    }
  }

  function remove(id) {
    if (operation) throw new Error('JDK를 받은 다음 다시 시도해 주세요.')
    cleanAtFirstUse()
    const records = index()
    if (!records.some(entry => entry.id === id)) throw new Error('ezShell에서 받은 JDK만 지울 수 있습니다.')
    const root = managedBase()
    const folder = path.join(root, id)
    const real = fs.realpathSync(folder)
    if (!samePath(real, folder)) throw new Error('JDK 보관함 밖의 파일은 지울 수 없습니다.')
    const hidden = path.join(root, `.remove-${process.pid}-${randomUUID()}`)
    fs.renameSync(folder, hidden)
    try { writeIndex(records.filter(entry => entry.id !== id)) } catch (error) {
      fs.renameSync(hidden, folder)
      throw error
    }
    removeInside(root, hidden)
  }

  function cancel() {
    if (!operation || operation.signal.aborted) return false
    operation.abort()
    return true
  }

  return { list, available, install, remove, cancel, javaHomeOf }
}

module.exports = { createRuntimes }
