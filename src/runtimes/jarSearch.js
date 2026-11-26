const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { pipeline } = require('node:stream/promises')
const yauzl = require('yauzl')
const { isLocalFilePath } = require('../localKeyPath.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { parseXml } = require('../sessionImport/filezilla.js')

const { lstat, opendir, realpath } = fs.promises
const open = promisify(fs.open)
const fstat = promisify(fs.fstat)
const close = promisify(fs.close)
const openZip = promisify(yauzl.fromRandomAccessReader)
const FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
const LIMITS = { maxFiles: 8000, maxEntries: 80_000, maxJarBytes: 256 * 1024 * 1024, timeoutMs: 12_000 }
const MAX_CLASS_PATH_BYTES = 256 * 1024
const MAX_ZIP_ENTRIES = 100_000
const MAX_CENTRAL_BYTES = 16 * 1024 * 1024
const TIMED_OUT = Symbol('jar search deadline')
const SKIP_FOLDERS = new Set(['.git', 'node_modules'])
const CLASS = /^[$_\p{ID_Start}][$\p{ID_Continue}]*(?:[./][$_\p{ID_Start}][$\p{ID_Continue}]*)*$/u
const COORDINATE_PART = /^[a-z0-9_][a-z0-9._+-]{0,159}$/i
const JAR = /\.jar$/i
const isLocalAbsolute = value => isLocalFilePath(value) && path.isAbsolute(value)
const identity = stat => `${stat.dev}:${stat.ino}`
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value
const jarClassName = value => typeof value === 'string' && value.length <= 512 && CLASS.test(value)
const CACHE_ROOTS = { maven: '.m2/repository', gradle: '.gradle/caches/modules-2/files-2.1' }

class CentralDirectoryReader extends yauzl.RandomAccessReader {
  constructor(fd, size) {
    super()
    this.fd = fd
    this.size = size
  }

  read(buffer, offset, length, position, callback) {
    if (!Number.isSafeInteger(position) || position < 0 || length > this.size - position) {
      queueMicrotask(() => callback(new Error('JAR directory is outside the file')))
      return
    }
    this.ref()
    fs.read(this.fd, buffer, offset, length, position, (error, bytesRead, result) => {
      try { callback(error, bytesRead, result) } finally { this.unref() }
    })
  }

  close(callback) { fs.close(this.fd, callback) }
}

async function canonicalDirectory(directory) {
  if (!isLocalAbsolute(directory) || !(await lstat(directory).catch(() => null))?.isDirectory()) return null
  const real = await realpath(directory).catch(() => null)
  return isLocalAbsolute(real) ? real : null
}

// Paths learned from a project or a cache may not traverse any symlinks or junctions.
async function checkedEntry(root, target) {
  if (!isLocalAbsolute(target) || !sameOrInside(root, target)) return null
  const parts = path.relative(root, target).split(path.sep).filter(Boolean)
  let current = root
  let stat = await lstat(root).catch(() => null)
  for (const part of parts) {
    if (!stat?.isDirectory() || SKIP_FOLDERS.has(part.toLowerCase())) return null
    current = path.join(current, part)
    stat = await lstat(current).catch(() => null)
  }
  if (!stat || stat.isSymbolicLink()) return null
  const real = await realpath(target).catch(() => null)
  return isLocalAbsolute(real) && path.relative(target, real) === '' ? stat : null
}

async function cacheRoots(home) {
  const roots = {}
  const cacheHome = await canonicalDirectory(home)
  if (cacheHome) for (const [name, relative] of Object.entries(CACHE_ROOTS)) {
    const root = path.join(cacheHome, relative)
    if ((await checkedEntry(cacheHome, root))?.isDirectory()) roots[name] = root
  }
  return roots
}

const relativePath = (root, target) => path.relative(root, target).split(path.sep).join('/')
const jarReference = value => typeof value === 'string' && value.length <= 4096 && JAR.test(value)
  && !/[\p{Cc}\p{Cf}\p{Cs}%]/u.test(value) && !value.includes('${')

function normalizeJarReferences(values) {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > 20 || !values.every(value => {
    if (!jarReference(value)) return false
    if (path.isAbsolute(value)) return isLocalAbsolute(value)
    return !/[:\\]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..')
  })) throw new Error('Tomcat에 연결할 JAR 경로를 확인해 주세요. 최대 20개까지 연결할 수 있습니다.')
  return [...new Set(values)]
}

async function allowedJar({ projectRoot, reference, home = os.homedir() }) {
  if (!jarReference(reference)) return null
  const project = await canonicalDirectory(projectRoot)
  if (!project) return null
  const target = path.resolve(project, reference)
  if (!isLocalAbsolute(target) || (!path.isAbsolute(reference) && !sameOrInside(project, target))) return null
  const roots = sameOrInside(project, target) ? { project } : await cacheRoots(home)
  for (const [source, root] of Object.entries(roots)) {
    if (!sameOrInside(root, target)) continue
    const stat = await checkedEntry(root, target)
    if (!stat?.isFile() || stat.size > LIMITS.maxJarBytes) return null
    const relative = relativePath(root, target)
    return { path: target, stat, source, reference: source === 'project' ? relative : target,
      displayPath: source === 'project' ? relative : `~/${CACHE_ROOTS[source]}/${relative}` }
  }
  return null
}

async function jarHasClass(jar, className, signal = AbortSignal.timeout(LIMITS.timeoutMs)) {
  if (!jarClassName(className)) return false
  const classEntry = className.replaceAll('.', '/') + '.class'
  const result = await inspectJar(jar.path, jar.stat, new Set([classEntry]), true, LIMITS.maxJarBytes, signal).catch(() => null)
  signal.throwIfAborted()
  return result?.found.has(classEntry) ?? false
}

async function copyCheckedJar(jar, destination, signal) {
  const source = await fs.promises.open(jar.path, FLAGS)
  try {
    const stat = await source.stat()
    const unchanged = current => current.isFile() && identity(current) === identity(jar.stat)
      && current.size === jar.stat.size && current.mtimeMs === jar.stat.mtimeMs && current.ctimeMs === jar.stat.ctimeMs
    if (!unchanged(stat)) throw new Error('연결한 JAR 파일이 바뀌었습니다. 다시 실행해 주세요.')
    await pipeline(source.createReadStream({ autoClose: false, end: Math.max(0, stat.size - 1) }),
      fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal })
    if (!unchanged(await source.stat())) throw new Error('연결한 JAR 파일이 바뀌었습니다. 다시 실행해 주세요.')
  } finally { await source.close() }
}

function artifactFile(filename, artifact, version) {
  const stem = filename.replace(JAR, '')
  return stem === `${artifact}-${version}` || stem.startsWith(`${artifact}-${version}-`)
}

function cacheCoordinate(filename, { maven, gradle }) {
  if (maven && sameOrInside(maven, filename)) {
    const parts = path.relative(maven, filename).split(path.sep)
    const file = parts.pop()
    const version = parts.pop()
    const artifact = parts.pop()
    const group = parts.join('.')
    if ([group, artifact, version].every(part => typeof part === 'string' && COORDINATE_PART.test(part))
      && artifactFile(file, artifact, version)) return `${group}:${artifact}:${version}`
  }
  if (gradle && sameOrInside(gradle, filename)) {
    const parts = path.relative(gradle, filename).split(path.sep)
    const [group, artifact, version, hash, file] = parts
    if (parts.length === 5 && [group, artifact, version].every(part => COORDINATE_PART.test(part))
      && /^[a-f0-9]{32,128}$/i.test(hash) && artifactFile(file, artifact, version)) return `${group}:${artifact}:${version}`
  }
  return null
}

function metadataCoordinate(entry, filename) {
  const match = /^META-INF\/maven\/([^/]+)\/([^/]+)\/pom\.properties$/.exec(entry)
  if (!match) return null
  const [, group, artifact] = match
  const base = path.basename(filename).replace(JAR, '')
  if (!COORDINATE_PART.test(group) || !COORDINATE_PART.test(artifact) || !base.startsWith(`${artifact}-`)) return null
  const version = base.slice(artifact.length + 1)
  // The version is inferred from an ordinary artifact filename, with no classifier guessed.
  return /^\d+(?:\.\d+)*(?:[.-](?:SNAPSHOT|RELEASE|Final|GA|(?:RC|M)\d+))?$/i.test(version)
    ? `${group}:${artifact}:${version}` : null
}

function searchDirectory(zip, classEntries, filename, coordinate, signal) {
  if (zip.entryCount > MAX_ZIP_ENTRIES) return Promise.resolve({ limited: true })
  return new Promise((resolve, reject) => {
    let bytes = 0
    const found = new Set()
    let guessed = null
    let ambiguous = false
    let finished = false
    const finish = (result, aborted = false) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', cancel)
      if (aborted) reject(result)
      else resolve(result)
    }
    const cancel = () => finish(signal.reason, true)
    signal.addEventListener('abort', cancel, { once: true })
    zip.on('error', () => finish(null))
    zip.once('end', () => finish({ found, coordinate: coordinate ?? (ambiguous ? null : guessed) }))
    zip.on('entry', entry => {
      if (finished || signal.aborted) return
      bytes += 46 + entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength
      if (bytes > MAX_CENTRAL_BYTES) return finish({ found, coordinate, limited: true })
      // JAR names are UTF-8, including old tools that omitted the ZIP UTF-8 flag.
      const name = entry.fileName.toString('utf8')
      if (classEntries.has(name)) {
        found.add(name)
        if (coordinate && found.size === classEntries.size) return finish({ found, coordinate })
      } else if (!coordinate) {
        const guess = metadataCoordinate(name, filename)
        if (guess && guessed && guessed !== guess) ambiguous = true
        guessed ??= guess
      }
      zip.readEntry()
    })
    if (signal.aborted) cancel()
    else zip.readEntry()
  })
}

async function inspectJar(filename, stat, classEntries, coordinate, limit, signal) {
  const fd = await open(filename, FLAGS)
  let reader, zip
  try {
    signal.throwIfAborted()
    const current = await fstat(fd)
    if (!current.isFile() || identity(current) !== identity(stat)) return null
    if (current.size > limit) return { limited: true }
    reader = new CentralDirectoryReader(fd, current.size)
    zip = await openZip(reader, current.size, { lazyEntries: true, autoClose: false, decodeStrings: false })
    return await searchDirectory(zip, classEntries, filename, coordinate, signal)
  } finally {
    if (zip) zip.close()
    else if (reader) reader.unref()
    else await close(fd).catch(() => {})
  }
}

async function classpathLibraries(root, directory, signal) {
  const filename = path.join(directory, '.classpath')
  const stat = await checkedEntry(root, filename)
  if (!stat?.isFile() || stat.size > MAX_CLASS_PATH_BYTES) return []
  signal.throwIfAborted()
  const file = await fs.promises.open(filename, FLAGS)
  try {
    const current = await file.stat()
    if (!current.isFile() || identity(current) !== identity(stat) || current.size > MAX_CLASS_PATH_BYTES) return []
    const bytes = Buffer.alloc(current.size)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    signal.throwIfAborted()
    const xml = parseXml(bytes.toString('utf8', 0, bytesRead))
    if (xml?.name !== 'classpath') return []
    return xml.children.filter(entry => entry.name === 'classpathentry' && entry.attrs.kind === 'lib' && JAR.test(entry.attrs.path ?? ''))
      .map(entry => path.resolve(directory, entry.attrs.path.replaceAll('\\', '/')))
  } finally { await file.close() }
}

async function scanScope(root, start, project, context) {
  const pending = [{ directory: start, archives: !project }]
  while (pending.length && !context.stopped) {
    context.signal.throwIfAborted()
    const { directory, archives } = pending.pop()
    if (!(await checkedEntry(root, directory))?.isDirectory()) continue
    const entries = await opendir(directory).catch(() => null)
    if (!entries) continue
    for await (const entry of entries) {
      context.signal.throwIfAborted()
      if (!context.takeEntry()) return
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory() && !SKIP_FOLDERS.has(entry.name.toLowerCase())) {
        pending.push({ directory: filename, archives: archives || entry.name.toLowerCase() === 'lib' })
      } else if (entry.isFile() && archives && JAR.test(entry.name)) {
        await context.visit(root, filename)
      } else if (entry.isFile() && project && entry.name === '.classpath') {
        const libraries = await classpathLibraries(root, directory, context.signal).catch(() => [])
        for (const library of libraries) {
          if (!context.takeEntry()) return
          await context.visit(root, library)
          if (context.stopped) return
        }
      }
      if (context.stopped) return
    }
  }
}

/**
 * Returns every matching JAR found within the budgets. An incomplete search reports its partial
 * matches. The caller authorizes the project root and additional folders before passing them here.
 */
async function searchJarClasses({ projectRoot, classNames, home = os.homedir(), folders = [], signal, limits = {} } = {}) {
  if (!Array.isArray(classNames) || !classNames.length || !classNames.every(jarClassName)) throw new Error('찾을 Java 클래스 이름을 확인해 주세요.')
  if (!isLocalAbsolute(projectRoot) || !Array.isArray(folders) || folders.some(folder => !isLocalAbsolute(folder))) {
    throw new Error('이 PC의 프로젝트와 검색 폴더를 선택해 주세요.')
  }
  if (!Object.entries(limits).every(([key, value]) => Object.hasOwn(LIMITS, key) && Number.isSafeInteger(value) && value > 0 && value <= LIMITS[key])) {
    throw new Error('JAR 검색 한도를 확인해 주세요.')
  }
  signal?.throwIfAborted()
  const { maxFiles, maxEntries, maxJarBytes, timeoutMs } = { ...LIMITS, ...limits }
  const entryOf = name => name.replaceAll('.', '/') + '.class'
  const entriesByClass = new Map(classNames.map(name => [name, entryOf(name)]))
  const classEntries = new Set(entriesByClass.values())
  const deadline = new AbortController()
  const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  const byEntry = new Map([...classEntries].map(entry => [entry, []]))
  const seen = new Set()
  const roots = {}
  let entries = 0
  let scanned = 0
  let incomplete = false
  const context = {
    signal: active,
    stopped: false,
    takeEntry() {
      if (++entries <= maxEntries) return true
      incomplete = context.stopped = true
      return false
    },
    async visit(root, filename) {
      active.throwIfAborted()
      const key = pathKey(filename)
      if (seen.has(key)) return
      const stat = await checkedEntry(root, filename)
      if (!stat?.isFile()) return
      seen.add(key)
      if (scanned >= maxFiles) { incomplete = context.stopped = true; return }
      scanned++
      if (stat.size > maxJarBytes) { incomplete = true; return }
      const result = await inspectJar(filename, stat, classEntries, cacheCoordinate(filename, roots), maxJarBytes, active).catch(() => null)
      active.throwIfAborted()
      if (result?.limited) incomplete = true
      if (result?.found) for (const entry of result.found) byEntry.get(entry).push({ path: filename, coordinate: result.coordinate })
    }
  }
  let stopSearch
  const stopped = new Promise((_, reject) => {
    stopSearch = () => reject(active.reason)
    active.addEventListener('abort', stopSearch, { once: true })
  })
  const timer = setTimeout(() => deadline.abort(TIMED_OUT), timeoutMs)
  async function scan() {
    const project = await canonicalDirectory(projectRoot)
    if (!project) throw new Error('검색할 프로젝트 폴더를 찾을 수 없습니다.')
    Object.assign(roots, await cacheRoots(home))
    for (const relative of ['lib', 'WEB-INF/lib', 'WebContent/WEB-INF/lib', 'src/main/webapp/WEB-INF/lib']) {
      await scanScope(project, path.join(project, relative), false, context)
    }
    for (const folder of folders) {
      active.throwIfAborted()
      if (context.stopped) return
      const root = await canonicalDirectory(folder)
      if (root) await scanScope(root, root, false, context)
    }
    await scanScope(project, project, true, context)
    for (const root of Object.values(roots)) await scanScope(root, root, false, context)
  }
  try { await Promise.race([scan(), stopped]) }
  catch (error) {
    if (error !== TIMED_OUT) throw error
    incomplete = true
  } finally {
    clearTimeout(timer)
    active.removeEventListener('abort', stopSearch)
  }
  return { matches: new Map([...entriesByClass].map(([name, entry]) => [name, byEntry.get(entry).slice()])), scanned, incomplete }
}

async function searchJars({ className, ...options } = {}) {
  const result = await searchJarClasses({ ...options, classNames: [className] })
  return { ...result, matches: result.matches.get(className) }
}

module.exports = { searchJars, searchJarClasses, allowedJar, jarHasClass, jarClassName, normalizeJarReferences, copyCheckedJar }
