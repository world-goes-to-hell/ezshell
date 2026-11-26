const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { sameOrInside } = require('../localFiles/roots.js')
const { readClassInfo } = require('../runtimes/classFile.js')
const { createJavac, javaTool, eclipseCompilerEnvironment } = require('./hotReloadJava.js')

const MAX_INPUTS = 50_000
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const BYTE_LIMIT = 4 * 1024 * 1024
const OMIT = new Set(['.git', '.svn', '.hg', 'cvs', '.metadata', '.settings', '.classpath', '.project'])
const fileIdentity = stat => `${stat.size}:${stat.mtimeMs}`
const shellLine = text => `${text}\r\n`
const safeRelative = value => typeof value === 'string' && value.length > 0 &&
  !/[\x00-\x1f\x7f]/.test(value) && !path.isAbsolute(value) && !/^[a-z]:/i.test(value) &&
  !value.split(/[\\/]/).some(part => part === '..' || part === '.' || !part)

async function browse(root, visit, signal, excluded = []) {
  const pending = ['']
  let count = 0
  while (pending.length) {
    signal.throwIfAborted()
    const folder = pending.pop()
    for (const entry of await fs.readdir(path.join(root, folder), { withFileTypes: true })) {
      if (++count > MAX_INPUTS) throw new Error('이클립스 빌드의 파일 수가 너무 많습니다.')
      const name = path.join(folder, entry.name)
      if (!safeRelative(name) || OMIT.has(entry.name.toLowerCase())) continue
      if (entry.isDirectory() && !excluded.includes(path.join(root, name))) pending.push(name)
      if (entry.isFile()) await visit(name)
    }
  }
}

async function collectInputs(roots, worktree, signal) {
  const java = new Map()
  const resources = new Map()
  for (const { source: root, excluded } of roots) {
    if (!sameOrInside(worktree, await fs.realpath(root))) throw new Error('이클립스 소스 폴더가 바뀌었습니다.')
    await browse(root, async relative => {
      const file = path.join(root, relative)
      const stat = await fs.lstat(file)
      if (!stat.isFile() || await fs.realpath(file) !== file) return
      if (java.size + resources.size >= MAX_INPUTS) throw new Error('이클립스 빌드의 파일 수가 너무 많습니다.')
      if (relative.endsWith('.java')) java.set(file, { relative, identity: fileIdentity(stat) })
      else if (!resources.has(relative)) resources.set(relative, { file, identity: fileIdentity(stat) })
    }, signal, excluded)
  }
  return { java, resources }
}

async function outputHome(userData, id, worktreeKey, worktree) {
  const profile = await fs.realpath(userData)
  if (sameOrInside(worktree, profile) || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('이클립스 빌드 출력 폴더를 확인할 수 없습니다.')
  const key = createHash('sha256').update(worktreeKey).digest('hex')
  let folder = profile
  for (const part of ['runtimes', 'tomcat-classes', id, key]) {
    folder = path.join(folder, part)
    await fs.mkdir(folder, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    if (!(await fs.lstat(folder)).isDirectory() || await fs.realpath(folder) !== folder) throw new Error('이클립스 빌드 출력 폴더에 링크를 사용할 수 없습니다.')
  }
  return folder
}

async function readSnapshot(directory, fingerprint, jarDirectory) {
  try {
    for (const folder of [directory, path.join(directory, 'classes'), ...(jarDirectory ? [jarDirectory] : [])]) {
      if (!(await fs.lstat(folder)).isDirectory() || await fs.realpath(folder) !== folder) return null
    }
    const file = path.join(directory, 'inputs.json')
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return null
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    if (saved.fingerprint !== fingerprint) return null
    const java = new Map(saved.java)
    const resources = new Map(saved.resources)
    if (java.size + resources.size > MAX_INPUTS || [...resources.keys()].some(name => !safeRelative(name))) return null
    return { java, resources }
  } catch { return null }
}

function changedEntries(next, previous, equal) {
  return [...next].filter(([name, entry]) => !equal(entry, previous?.get(name)))
}

async function removeResource(output, relative) {
  const file = path.join(output, relative)
  await fs.rm(file, { force: true })
  for (let parent = path.dirname(file); parent !== output; parent = path.dirname(parent)) {
    try { await fs.rmdir(parent) }
    catch (error) {
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') break
      if (error.code !== 'ENOENT') throw error
    }
  }
}

async function removeOldClasses(output, records, dirty, signal) {
  if (!dirty.size) return
  const sources = new Map()
  for (const [file, record] of records) {
    if (!safeRelative(record?.relative)) continue
    const name = path.basename(record.relative)
    const entries = sources.get(name) ?? []
    entries.push({ file, relative: record.relative })
    sources.set(name, entries)
  }
  await browse(output, async relative => {
    if (!relative.endsWith('.class')) return
    const file = path.join(output, relative)
    if ((await fs.stat(file)).size > BYTE_LIMIT) return
    let classInfo
    try { classInfo = readClassInfo(await fs.readFile(file), { includeSource: true }) } catch { return }
    const candidates = sources.get(classInfo.sourceFile)
    const source = candidates?.length === 1 ? candidates[0] : candidates?.find(entry => path.dirname(entry.relative) === path.dirname(relative))
    if (source && dirty.has(source.file)) await fs.unlink(file)
  }, signal)
}

async function replaceSnapshot(current, next, previous) {
  const moved = await fs.rename(current, previous).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error
    return false
  })
  try { await fs.rename(next, current) }
  catch (error) {
    if (moved) await fs.rename(previous, current)
    throw error
  }
}

async function buildEclipse({ eclipse, libs, webLibs = [], externalJars = [], userData, id, worktreeKey, worktree, cwd, env, signal, log, makeCompiler = createJavac }) {
  if (!eclipse.sources.length) throw new Error('이클립스 .classpath에서 빌드할 Java 소스 폴더를 찾을 수 없습니다.')
  const parent = await outputHome(userData, id, worktreeKey, worktree)
  const current = path.join(parent, 'current')
  const output = path.join(current, 'classes')
  const jarDirectory = externalJars.length ? path.join(current, 'lib') : undefined
  const compilerOptions = { encoding: eclipse.encoding, release: eclipse.release, noProcessors: true }
  const roots = eclipse.sources.map(source => ({ source, output, moduleRoot: cwd, compilerOptions,
    excluded: [...eclipse.sources, ...eclipse.excludedSources].filter(other => other !== source && sameOrInside(source, other)) }))
  for (const warning of eclipse.warnings) log(shellLine(`WARN ${warning}`))
  if ([output, ...libs].some(file => file.includes(path.delimiter))) throw new Error('Java 클래스패스에 사용할 수 없는 경로가 있습니다.')
  const compilerEnv = eclipseCompilerEnvironment(env)
  const executable = javaTool('javac', compilerEnv)
  const executableStamp = path.isAbsolute(executable) ? fileIdentity(await fs.stat(executable)) : compilerEnv.PATH ?? compilerEnv.Path
  const fingerprint = JSON.stringify([2, executable, executableStamp, compilerOptions, eclipse.sources, webLibs, externalJars,
    await Promise.all(libs.map(async file => [file, fileIdentity(await fs.stat(file))]))])
  const existing = await readSnapshot(current, fingerprint, jarDirectory)
  const inputs = await collectInputs(roots, worktree, signal)
  const changedJava = changedEntries(inputs.java, existing?.java, (a, b) => a.identity === b?.identity).map(([name]) => name)
  const changedResources = changedEntries(inputs.resources, existing?.resources, (a, b) => a.file === b?.file && a.identity === b.identity)
  const removedJava = [...(existing?.java.keys() ?? [])].filter(file => !inputs.java.has(file))
  const removedResources = [...(existing?.resources.keys() ?? [])].filter(file => !inputs.resources.has(file))
  const layout = { classpath: [output, ...libs], roots }
  if (existing && !changedJava.length && !changedResources.length && !removedJava.length && !removedResources.length) {
    log(shellLine('이클립스식 빌드 · 변경된 파일이 없습니다.'))
    return { output, layout, jarDirectory }
  }

  const scratch = await fs.mkdtemp(path.join(parent, `.build-${process.pid}-`))
  const next = path.join(scratch, 'next')
  const classes = path.join(next, 'classes')
  try {
    await fs.mkdir(classes, { recursive: true })
    if (existing) {
      await fs.cp(output, classes, { recursive: true, filter: async file => !(await fs.lstat(file)).isSymbolicLink() })
      await removeOldClasses(classes, new Map([...existing.java, ...inputs.java]), new Set([...changedJava, ...removedJava]), signal)
    }
    if (jarDirectory) {
      const targetLib = path.join(next, 'lib')
      await fs.mkdir(targetLib)
      const names = new Set(webLibs.map(file => path.basename(file).toLowerCase()))
      for (const jar of externalJars) {
        signal.throwIfAborted()
        if (await fs.realpath(jar) !== jar || !sameOrInside(worktree, jar)) throw new Error('이클립스 라이브러리의 경로가 바뀌었습니다.')
        let name = path.basename(jar).replace(/\.jar$/i, '.jar')
        for (let suffix = names.size; names.has(name.toLowerCase()); suffix++) name = `ezshell-library-${suffix}.jar`
        names.add(name.toLowerCase())
        await fs.copyFile(jar, path.join(targetLib, name))
      }
    }
    for (const name of removedResources) await removeResource(classes, name)
    for (const [name, { file }] of changedResources) {
      signal.throwIfAborted()
      const target = path.join(classes, name)
      await fs.mkdir(path.dirname(target), { recursive: true })
      if (await fs.realpath(file) !== file || !sameOrInside(worktree, file)) throw new Error('이클립스 리소스의 경로가 바뀌었습니다.')
      await fs.copyFile(file, target)
    }
    if (changedJava.length) {
      for (const file of changedJava) {
        signal.throwIfAborted()
        if (await fs.realpath(file) !== file || !sameOrInside(worktree, file)) throw new Error('이클립스 소스 파일의 경로가 바뀌었습니다.')
      }
      log(shellLine(`이클립스식 빌드 · Java ${changedJava.length}개 컴파일`))
      const compile = makeCompiler({ env: compilerEnv, signal, readClassInfo, isolatedOutput: true })
      try { await compile({ root: { output: classes, moduleRoot: cwd, compilerOptions }, sources: changedJava, classpath: [classes, ...libs] }) }
      catch (error) {
        if (eclipse.warnings.length && typeof error.stderr === 'string') error.stderr = [...eclipse.warnings, error.stderr].join('\n')
        throw error
      }
    }
    signal.throwIfAborted()
    await fs.writeFile(path.join(next, 'inputs.json'), JSON.stringify({ fingerprint, java: [...inputs.java], resources: [...inputs.resources] }), { mode: 0o600 })
    signal.throwIfAborted()
    await replaceSnapshot(current, next, path.join(scratch, 'previous'))
    log(shellLine('이클립스식 빌드 완료'))
    return { output, layout, jarDirectory }
  } finally { await fs.rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 }) }
}

module.exports = { buildEclipse }
