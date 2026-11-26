const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')
const { fileURLToPath, pathToFileURL } = require('node:url')
const yauzl = require('yauzl')
const { sameOrInside } = require('../localFiles/roots.js')
const { resolveLocalPreviewPath } = require('../agentChat/localPreview.js')
const { processList } = require('../agentIdle.js')

const exec = promisify(execFile)
const BUILD_BYTES = 256 * 1024
const MAX_CLASSES = 2048
const MAX_CLASS_BYTES = 4 * 1024 * 1024
const JAVA_OPTIONS = ['-implicit:none', '-g', '-parameters']

async function readSmall(root, name) {
  const entry = await resolveLocalPreviewPath(path.join(root, name)).catch(() => null)
  if (!entry?.stat.isFile() || !sameOrInside(root, entry.path) || entry.stat.size > BUILD_BYTES) return ''
  const handle = await fs.open(entry.path, 'r')
  try {
    const buffer = Buffer.alloc(BUILD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally { await handle.close() }
}

const xmlValue = (xml, tag) => new RegExp(`<${tag.replaceAll('.', '\\.')}>([^<]{1,128})<\\/${tag.replaceAll('.', '\\.')}>`).exec(xml)?.[1].trim()

async function inspectJavaBuild(root) {
  const [pom, groovy, kotlin] = await Promise.all(['pom.xml', 'build.gradle', 'build.gradle.kts'].map(name => readSmall(root, name)))
  const xml = pom.replace(/<!--[\s\S]*?-->/g, '')
  const gradle = `${groovy}\n${kotlin}`.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const mavenEncoding = xmlValue(xml, 'maven.compiler.encoding') ?? xmlValue(xml, 'encoding') ?? xmlValue(xml, 'project.build.sourceEncoding')
  const propertyName = /^\$\{([a-zA-Z0-9._-]+)\}$/.exec(mavenEncoding ?? '')?.[1]
  const explicit = (propertyName ? xmlValue(xml, propertyName) : mavenEncoding) ??
    /\boptions\.encoding\s*(?:=\s*|\.set\(\s*)["']([^"']+)["']/.exec(gradle)?.[1]
  const dependency = name => new RegExp(`<artifactId>\\s*${name}\\s*<\\/artifactId>|["'][^"'\\s]+:${name}(?::[^"']+)?["']`).test(`${xml}\n${gradle}`)
  return { encoding: explicit && /^[a-zA-Z0-9._-]+$/.test(explicit) ? explicit : 'UTF-8',
    lombok: dependency('lombok'), devtools: dependency('spring-boot-devtools') }
}

async function manifestClassPath(jar) {
  const manifest = await new Promise((resolve, reject) => {
    yauzl.open(jar, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error)
      zip.once('error', reject)
      zip.once('end', () => resolve(''))
      zip.on('entry', entry => {
        if (entry.fileName.toUpperCase() !== 'META-INF/MANIFEST.MF') return zip.readEntry()
        if (entry.uncompressedSize > BUILD_BYTES) { zip.close(); return resolve('') }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { zip.close(); return reject(streamError) }
          const chunks = []
          stream.on('data', chunk => chunks.push(chunk))
          stream.on('error', failure => { zip.close(); reject(failure) })
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')) })
        })
      })
      zip.readEntry()
    })
  }).catch(() => '')
  const header = manifest.replace(/(?:\r\n|\n|\r) /g, '').split(/(?:\r?\n){2}/, 1)[0]
  const tokens = /^Class-Path:\s*([^\r\n]+)/im.exec(header)?.[1].trim().split(/\s+/) ?? []
  return tokens.flatMap(token => {
    try {
      const url = new URL(token, pathToFileURL(jar))
      return url.protocol === 'file:' && !url.hostname ? [fileURLToPath(url)] : []
    } catch { return [] }
  })
}

async function javaLayout({ baseDir, classpaths }, worktree) {
  const canonical = async paths => (await Promise.all(paths.map(async entry => {
    if (typeof entry !== 'string' || !entry || (!path.isAbsolute(entry) && !path.isAbsolute(baseDir ?? ''))) return null
    return resolveLocalPreviewPath(path.resolve(baseDir || worktree, entry)).catch(() => null)
  }))).filter(Boolean)
  let entries = await canonical(classpaths ?? [])
  if (entries.length === 1 && entries[0].stat.isFile() && /\.jar$/i.test(entries[0].path)) {
    entries = [...entries, ...await canonical(await manifestClassPath(entries[0].path))]
  }
  const roots = []
  for (const entry of new Map(entries.map(item => [item.path, item])).values()) {
    if (!entry.stat.isDirectory() || !sameOrInside(worktree, entry.path)) continue
    const suffix = /[\\/](?:target[\\/]classes|build[\\/]classes[\\/]java[\\/]main)$/i.exec(entry.path)
    if (!suffix) continue
    const moduleRoot = entry.path.slice(0, -suffix[0].length)
    const source = await resolveLocalPreviewPath(path.join(moduleRoot, 'src', 'main', 'java')).catch(() => null)
    if (!source?.stat.isDirectory() || !sameOrInside(worktree, source.path)) continue
    roots.push({ source: source.path, output: entry.path, moduleRoot })
  }
  return { roots, classpath: [...new Set(entries.map(entry => entry.path))] }
}

function javaTool(name, env, platform = process.platform) {
  const javaHome = Object.entries(env).find(([key]) => (platform === 'win32' ? key.toUpperCase() : key) === 'JAVA_HOME')?.[1]
  const binary = platform === 'win32' ? `${name}.exe` : name
  return javaHome ? path.join(javaHome, 'bin', binary) : binary
}

function childJava(pid, processes) {
  return [...processes].flatMap(([child, proc]) => {
    if (!/^javaw?(?:\.exe)?$/i.test(path.basename(proc.name))) return []
    const visited = new Set([child])
    let parent = proc.parent
    while (parent > 0 && !visited.has(parent)) {
      if (parent === pid) return [child]
      visited.add(parent)
      parent = processes.get(parent)?.parent
    }
    return []
  }).reverse()
}

function javaProperties(stdout) {
  const read = key => stdout.split(/\r?\n/).find(line => line.startsWith(`${key}=`))?.slice(key.length + 1)
    ?.replace(/\\u([0-9a-f]{4})|\\([:=#! \\])/gi, (_, hex, char) => char ?? String.fromCharCode(parseInt(hex, 16)))
  return { baseDir: read('user.dir'), classpaths: read('java.class.path')?.split(path.delimiter) ?? [] }
}

async function devtoolsLayout({ pid, cwd, env, worktree, signal, run = exec, processes = processList }) {
  if (!Number.isInteger(pid) || pid < 1) return null
  const tree = await processes({ run: (file, args, options, callback) => execFile(file, args, { ...options, signal }, callback) })
  for (const child of childJava(pid, tree)) {
    signal.throwIfAborted()
    const result = await run(javaTool('jcmd', env), [String(child), 'VM.system_properties'], {
      cwd, env, signal, windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024
    }).catch(() => null)
    if (!result) continue
    const layout = await javaLayout(javaProperties(result.stdout), worktree)
    if (layout.roots.length && layout.classpath.some(entry => /spring-boot-devtools[\w.-]*\.jar$/i.test(entry))) return layout
  }
  return null
}

async function existingRelease(output) {
  const pending = [output]
  for (let count = 0; pending.length && count < 160; count++) {
    const directory = pending.shift()
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(file)
      if (!entry.isFile() || !entry.name.endsWith('.class')) continue
      const handle = await fs.open(file, 'r')
      try {
        const header = Buffer.alloc(8)
        if ((await handle.read(header, 0, header.length)).bytesRead === header.length && header.readUInt32BE(0) === 0xcafebabe) {
          const release = header.readUInt16BE(6) - 44
          if (release >= 6) return release
        }
      } finally { await handle.close() }
    }
  }
  return undefined
}

async function lombokJar(env, home = os.homedir()) {
  const m2 = path.join(home, '.m2', 'repository', 'org', 'projectlombok', 'lombok')
  const gradle = path.join(env.GRADLE_USER_HOME || path.join(home, '.gradle'), 'caches', 'modules-2', 'files-2.1', 'org.projectlombok', 'lombok')
  const versions = async root => {
    const directory = await resolveLocalPreviewPath(root).catch(() => null)
    if (!directory?.stat.isDirectory()) return []
    return (await fs.readdir(directory.path, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && /^[\w.-]+$/.test(entry.name)).map(entry => entry.name)
  }
  const candidates = [...(await versions(m2)).map(version => ({ root: m2, version })), ...(await versions(gradle)).map(version => ({ root: gradle, version }))]
  for (const { root, version } of candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))) {
    const directory = path.join(root, version)
    const parents = root === m2 ? [directory] : (await versions(directory)).map(hash => path.join(directory, hash))
    for (const parent of parents) {
      const jar = await resolveLocalPreviewPath(path.join(parent, `lombok-${version}.jar`)).catch(() => null)
      if (jar?.stat.isFile()) return jar.path
    }
  }
  return null
}

const quoteArgument = value => `"${value.replace(/[\\"]/g, '\\$&')}"`

function javacArguments({ output, classpath, encoding, release, compilerVersion, processor, sources }) {
  const version = !release ? [] : compilerVersion <= 8 ? ['-source', release <= 8 ? `1.${release}` : String(release), '-target', release <= 8 ? `1.${release}` : String(release)]
    : ['--release', String(release)]
  return ['-d', output, '-cp', classpath.join(path.delimiter), ...JAVA_OPTIONS, '-encoding', encoding, ...version,
    ...(processor ? ['-processorpath', processor] : []), ...sources].map(quoteArgument).join('\n') + '\n'
}

async function stagedClasses(directory, readClassInfo, signal) {
  const classes = []
  let total = 0
  async function visit(current) {
    signal.throwIfAborted()
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(file)
      if (!entry.isFile() || !entry.name.endsWith('.class')) continue
      const { size } = await fs.stat(file)
      total += size
      if (classes.length >= MAX_CLASSES || size > MAX_CLASS_BYTES || total > 32 * 1024 * 1024) throw new Error('컴파일한 클래스가 너무 많거나 큽니다.')
      const bytes = await fs.readFile(file)
      const { name } = readClassInfo(bytes)
      classes.push({ relative: path.relative(directory, file), name, bytes })
    }
  }
  await visit(directory)
  return classes
}

async function publishClasses(root, classes, signal) {
  signal.throwIfAborted()
  // Finish a started batch so an outer class and its inner classes stay in sync on disk.
  for (const { relative, bytes } of classes) {
    const target = path.join(root, relative)
    const directory = path.dirname(target)
    // Existing directory links must stay inside the confirmed class output root.
    let parent = directory
    for (;;) {
      const entry = await fs.lstat(parent).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (entry) {
        if (!sameOrInside(root, await fs.realpath(parent))) throw new Error('컴파일 출력 폴더가 바뀌었습니다.')
        break
      }
      if (parent === root) throw new Error('컴파일 출력 폴더를 찾을 수 없습니다.')
      parent = path.dirname(parent)
    }
    await fs.mkdir(directory, { recursive: true })
    if (!sameOrInside(root, await fs.realpath(directory))) throw new Error('컴파일 출력 폴더가 바뀌었습니다.')
    const temporary = path.join(directory, `.ezshell-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx' })
      await fs.rename(temporary, target)
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }
}

function createJavac({ env, signal, readClassInfo, run = exec, tempRoot = os.tmpdir(), home }) {
  const javac = javaTool('javac', env)
  let version
  const releases = new Map()
  async function invoke(args, cwd, timeout) {
    try { return await run(javac, args, { cwd, env, signal, timeout, windowsHide: true, maxBuffer: 1024 * 1024 }) }
    catch (error) {
      signal.throwIfAborted()
      if (error.code === 'ENOENT') throw new Error('선택한 JDK에서 javac를 찾을 수 없습니다.')
      throw error
    }
  }
  return async ({ root, sources, classpath }) => {
    if (!version) {
      const { stdout, stderr } = await invoke(['-version'], root.moduleRoot, 10_000)
      version = Number(/\bjavac\s+(?:1\.)?(\d+)/.exec(`${stdout}\n${stderr}`)?.[1])
      if (!version) throw new Error('javac 버전을 확인하지 못했습니다.')
    }
    const build = await inspectJavaBuild(root.moduleRoot)
    const lombok = classpath.find(file => /[\\/]lombok(?:-[^\\/]+)?\.jar$/i.test(file))
    let processor = build.lombok && version >= 23 ? lombok : undefined
    if (build.lombok && !lombok) {
      processor = await lombokJar(env, home)
      if (!processor) throw new Error('Lombok을 Maven 또는 Gradle 캐시에서 찾을 수 없습니다.')
    }
    if (!releases.has(root.output)) releases.set(root.output, await existingRelease(root.output))
    const staging = await fs.mkdtemp(path.join(tempRoot, 'ezshell-javac-'))
    try {
      const output = path.join(staging, 'classes')
      const args = path.join(staging, 'javac.args')
      await fs.mkdir(output)
      await fs.writeFile(args, javacArguments({ output, classpath: processor && !lombok ? [...classpath, processor] : classpath, encoding: build.encoding,
        release: releases.get(root.output), compilerVersion: version, processor, sources }), { mode: 0o600, signal })
      await invoke(['-J-Dfile.encoding=UTF-8', `@${args}`], root.moduleRoot, 60_000)
      const classes = await stagedClasses(output, readClassInfo, signal)
      await publishClasses(root.output, classes, signal)
      return classes
    } finally { await fs.rm(staging, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 }) }
  }
}

module.exports = { inspectJavaBuild, javaLayout, javacArguments, createJavac, javaTool, devtoolsLayout, lombokJar }
