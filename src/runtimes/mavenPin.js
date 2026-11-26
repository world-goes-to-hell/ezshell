const fs = require('node:fs/promises')
const { createReadStream, createWriteStream, constants } = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { pathToFileURL } = require('node:url')
const { resolveLocalPreviewPath, sameEntry } = require('../agentChat/localPreview.js')
const { parseXml } = require('../sessionImport/filezilla.js')

const PRESET = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const SNAPSHOT = /^repo-[a-f\d-]{36}$/i
const RUN_FOLDER = /^run-([1-9]\d{0,9})-[a-z\d]{6}$/i
const REMOTE_METADATA = /^maven-metadata-(?!local\.xml$)[\w.-]{1,160}\.xml$/i
const ARTIFACT_PART = /^[a-z\d][a-z\d._+-]{0,179}$/i
const MAX_BYTES = 1024 ** 3
const MAX_ARTIFACTS = 12_000
const MAX_ENTRIES = 100_000
const MAX_TRACKING_BYTES = 64 * 1024
const MAX_METADATA_BYTES = 256 * 1024
const serial = new Map()
const activeRuns = new Set()

const equalPath = (a, b) => path.relative(a, b) === ''
const xml = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])
const settings = body => `<?xml version="1.0" encoding="UTF-8"?>\n<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">${body}</settings>\n`
const local = value => resolveLocalPreviewPath(value).catch(() => null)

async function realDirectory(folder) {
  const entry = await local(folder)
  if (!entry?.stat.isDirectory()) throw new Error('Maven 보관 폴더를 확인할 수 없습니다.')
  return entry.path
}

async function childDirectory(parent, name) {
  const directory = path.join(parent, name)
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (!(await fs.lstat(directory)).isDirectory() || !equalPath(directory, await fs.realpath(directory))) {
    throw new Error('Maven 보관 폴더에 다른 폴더를 가리키는 링크를 사용할 수 없습니다.')
  }
  return directory
}

async function presetRoot(userData, id, create = true) {
  if (typeof id !== 'string' || !PRESET.test(id)) throw new Error('Maven 보관의 실행 구성 ID를 확인해 주세요.')
  let directory = await realDirectory(userData)
  for (const part of ['runtimes', 'maven-pinned', id]) {
    if (create) directory = await childDirectory(directory, part)
    else {
      directory = path.join(directory, part)
      const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (!stat) return null
      if (!stat.isDirectory() || !equalPath(directory, await fs.realpath(directory))) throw new Error('Maven 보관 폴더를 확인할 수 없습니다.')
    }
  }
  return directory
}

async function removeOwned(root, directory) {
  const stat = await fs.lstat(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (stat?.isDirectory() && equalPath(path.dirname(directory), root) && equalPath(directory, await fs.realpath(directory))) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 })
  }
}

async function cleanAbandonedRuns(root, includeIdle = false) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const match = RUN_FOLDER.exec(entry.name)
    if (!match || !entry.isDirectory()) continue
    const pid = Number(match[1])
    const directory = path.join(root, entry.name)
    if (pid === process.pid) {
      if (includeIdle && !activeRuns.has(directory)) await removeOwned(root, directory).catch(() => {})
      continue
    }
    if (pid > 2147483647) continue
    try { process.kill(pid, 0) }
    catch (error) { if (error.code === 'ESRCH') await removeOwned(root, directory).catch(() => {}) }
  }
}

function exclusive(root, operation) {
  const current = (serial.get(root) ?? Promise.resolve()).catch(() => {}).then(operation)
  serial.set(root, current)
  return current.finally(() => { if (serial.get(root) === current) serial.delete(root) })
}

async function currentSnapshot(root) {
  const file = path.join(root, 'current.json')
  const stat = await fs.lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!stat) return null
  if (!stat.isFile() || stat.size > 512) throw new Error('Maven 보관 기록을 읽을 수 없습니다.')
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
  if (typeof manifest.repository !== 'string' || !SNAPSHOT.test(manifest.repository)) throw new Error('Maven 보관 기록을 읽을 수 없습니다.')
  const directory = path.join(root, manifest.repository)
  if (!equalPath(directory, await realDirectory(directory))) throw new Error('Maven 보관 폴더가 이동했습니다.')
  return directory
}

async function walk(root, visit, signal) {
  const pending = ['']
  let count = 0
  while (pending.length) {
    signal?.throwIfAborted()
    const relative = pending.pop()
    const directory = path.join(root, relative)
    if (!equalPath(directory, await realDirectory(directory))) throw new Error('Maven 결과 폴더가 이동했습니다.')
    const entries = await fs.readdir(directory, { withFileTypes: true })
    if ((count += entries.length) > MAX_ENTRIES) throw new Error('Maven 보관에서 검사할 파일이 너무 많습니다.')
    await visit(relative, entries)
    for (const entry of entries) if (entry.isDirectory() && ARTIFACT_PART.test(entry.name)) pending.push(path.join(relative, entry.name))
  }
}

const child = (node, name) => node?.children.find(entry => entry.name === name)
const value = (node, name) => child(node, name)?.text
const metadataXml = body => `<?xml version="1.0" encoding="UTF-8"?>\n<metadata>${body}</metadata>\n`

async function readMetadata(file) {
  if (!equalPath(file, await fs.realpath(file))) return null
  const handle = await fs.open(file, 'r')
  try {
    if (!(await handle.stat()).isFile()) return null
    const input = Buffer.alloc(MAX_METADATA_BYTES + 1)
    const { bytesRead } = await handle.read(input, 0, input.length, 0)
    if (bytesRead > MAX_METADATA_BYTES) return null
    const root = parseXml(input.toString('utf8', 0, bytesRead))
    return root.name === 'metadata' ? root : null
  } catch { return null }
  finally { await handle.close() }
}

function metadataForArtifacts(parts, versions, sources) {
  if (!versions?.size || !sources.some(source => child(source, 'versioning'))) return ''
  const matchHint = key => {
    const recorded = new Set(sources.map(source => value(child(source, 'versioning'), key)).filter(version => versions.has(version)))
    if (recorded.size === 1) return [...recorded][0]
    return versions.size === 1 ? [...versions][0] : undefined
  }
  const hint = key => { const match = matchHint(key); return match ? `<${key}>${xml(match)}</${key}>` : '' }
  const available = [...versions].sort().map(version => `<version>${xml(version)}</version>`).join('')
  const group = parts.slice(0, -1).join('.')
  return `<groupId>${xml(group)}</groupId><artifactId>${xml(parts.at(-1))}</artifactId><versioning>${hint('latest')}${hint('release')}<versions>${available}</versions></versioning>`
}

function metadataForPlugins(artifacts, sources) {
  if (!artifacts?.size) return ''
  const prefixes = new Map()
  for (const source of sources) {
    for (const plugin of child(source, 'plugins')?.children ?? []) {
      const prefix = value(plugin, 'prefix')
      const artifact = value(plugin, 'artifactId')
      if (plugin.name !== 'plugin' || !ARTIFACT_PART.test(prefix ?? '') || !artifacts.has(artifact)) continue
      const candidate = prefixes.get(prefix)
      prefixes.set(prefix, candidate === undefined || candidate === artifact ? artifact : null)
    }
  }
  const entries = [...prefixes].filter(([, artifact]) => artifact)
  return entries.length ? `<plugins>${entries.map(([prefix, artifact]) => `<plugin><prefix>${xml(prefix)}</prefix><artifactId>${xml(artifact)}</artifactId></plugin>`).join('')}</plugins>` : ''
}

async function collectedMetadata(repo, artifacts, signal) {
  const versionsOf = new Map()
  const pluginsOf = new Map()
  for (const artifact of artifacts) {
    const parts = artifact.relative.split(path.sep)
    const group = parts.slice(0, -3).join(path.sep)
    const name = parts.at(-3)
    const directory = path.join(group, name)
    if (!versionsOf.has(directory)) versionsOf.set(directory, new Set())
    versionsOf.get(directory).add(parts.at(-2))
    if (/\.jar$/i.test(parts.at(-1))) {
      if (!pluginsOf.has(group)) pluginsOf.set(group, new Set())
      pluginsOf.get(group).add(name)
    }
  }
  const metadata = []
  for (const relative of new Set([...versionsOf.keys(), ...pluginsOf.keys()])) {
    signal?.throwIfAborted()
    const directory = path.join(repo, relative)
    const names = await fs.readdir(directory, { withFileTypes: true })
    const sources = []
    for (const entry of names) {
      if (!entry.isFile() || !REMOTE_METADATA.test(entry.name)) continue
      const contents = await readMetadata(path.join(directory, entry.name))
      if (contents) sources.push(contents)
    }
    const plugins = metadataForPlugins(pluginsOf.get(relative), sources)
    const body = metadataForArtifacts(relative.split(path.sep), versionsOf.get(relative), sources) + plugins
    if (body) metadata.push({ relative: path.join(relative, 'maven-metadata.xml'), text: metadataXml(body),
      ...(plugins && { pluginGroup: relative.split(path.sep).join('.') }) })
  }
  return metadata
}

async function remoteFiles(repo, limit, signal) {
  const artifacts = []
  let bytes = 0
  let skippedSnapshots = 0
  await walk(repo, async (relative, entries) => {
    const coordinate = relative.split(path.sep)
    if (coordinate.length < 3 || !entries.some(entry => entry.name === '_remote.repositories' && entry.isFile())) return
    const [artifact, version] = coordinate.slice(-2)
    const tracker = path.join(repo, relative, '_remote.repositories')
    const tracking = await fs.lstat(tracker)
    if (!tracking.isFile() || tracking.size > MAX_TRACKING_BYTES || !equalPath(tracker, await fs.realpath(tracker))) return
    const text = await fs.readFile(tracker, 'utf8')
    // A blank repository ID (file>=) is Maven install's local artifact, not a download.
    const remote = new Set()
    const installed = new Set()
    for (const [, filename, origin] of text.matchAll(/^([^#>\s]+)>([^=\r\n]*)=[ \t]*\r?$/gm)) {
      (origin ? remote : installed).add(filename)
    }
    const prefix = `${artifact}-${version}`
    for (const entry of entries) {
      const { name } = entry
      if (!entry.isFile() || !remote.has(name) || installed.has(name) || !ARTIFACT_PART.test(name) || !name.startsWith(prefix) ||
          !/^(?:\.|-).+\.[a-z\d]+$|^\.[a-z\d]+$/i.test(name.slice(prefix.length)) || /\.(?:lastUpdated|sha1|sha256|sha512|md5)$/i.test(name)) continue
      if (/-SNAPSHOT$/i.test(version)) { skippedSnapshots++; continue }
      const file = path.join(repo, relative, name)
      const stat = await fs.lstat(file)
      if (!stat.isFile() || !equalPath(file, await fs.realpath(file))) throw new Error('Maven 빌드 결과 파일이 이동했습니다.')
      if ((bytes += stat.size) > limit || artifacts.length >= MAX_ARTIFACTS) throw new Error('Maven 보관의 파일 수나 용량 한도를 넘었습니다.')
      artifacts.push({ file, relative: path.join(relative, name), size: stat.size })
    }
  }, signal)
  const metadata = await collectedMetadata(repo, artifacts, signal)
  bytes += metadata.reduce((total, item) => total + Buffer.byteLength(item.text), 0)
  if (bytes > limit || artifacts.length + metadata.length > MAX_ARTIFACTS) throw new Error('Maven 보관의 파일 수나 용량 한도를 넘었습니다.')
  return { artifacts, metadata, bytes, skippedSnapshots }
}

async function copyArtifact(artifact, root, signal) {
  const target = path.join(root, artifact.relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  if (!equalPath(artifact.file, await fs.realpath(artifact.file))) throw new Error('Maven 빌드 결과 파일이 이동했습니다.')
  const checksum = createHash('sha1')
  let copied = 0
  const count = new Transform({ transform(chunk, _encoding, done) {
    copied += chunk.length
    if (copied > artifact.size) return done(new Error('Maven 빌드 결과가 복사 중에 바뀌었습니다.'))
    checksum.update(chunk)
    done(null, chunk)
  } })
  await pipeline(createReadStream(artifact.file), count, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal })
  if (copied !== artifact.size) throw new Error('Maven 빌드 결과가 복사 중에 바뀌었습니다.')
  await fs.writeFile(`${target}.sha1`, `${checksum.digest('hex')}\n`, { flag: 'wx', mode: 0o600 })
}

async function publish(root, scratch, result, signal) {
  const previous = await currentSnapshot(root)
  const directory = path.join(root, `repo-${randomUUID()}`)
  const staging = path.join(scratch, 'publish')
  const marker = path.join(scratch, 'current.json')
  await fs.mkdir(staging, { mode: 0o700 })
  for (const artifact of result.artifacts) await copyArtifact(artifact, staging, signal)
  for (const { relative, text } of result.metadata) {
    signal?.throwIfAborted()
    const file = path.join(staging, relative)
    const checksum = createHash('sha1').update(text).digest('hex')
    await Promise.all([fs.writeFile(file, text, { flag: 'wx', mode: 0o600 }), fs.writeFile(`${file}.sha1`, `${checksum}\n`, { flag: 'wx', mode: 0o600 })])
  }
  const pluginGroups = result.metadata.map(item => item.pluginGroup).filter(Boolean)
  if (pluginGroups.length) await fs.writeFile(path.join(staging, '.plugin-groups.json'), JSON.stringify(pluginGroups), { flag: 'wx', mode: 0o600 })
  signal?.throwIfAborted()
  await fs.writeFile(marker, JSON.stringify({ repository: path.basename(directory) }), { flag: 'wx', mode: 0o600 })
  await fs.rename(staging, directory)
  try { await fs.rename(marker, path.join(root, 'current.json')) }
  catch (error) { await removeOwned(root, directory); throw error }
  if (previous) await removeOwned(root, previous).catch(() => {})
  return directory
}

async function copySnapshot(source, target, signal) {
  await walk(source, async (relative, entries) => {
    await fs.mkdir(path.join(target, relative), { recursive: true, mode: 0o700 })
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (!entry.isFile() || !ARTIFACT_PART.test(entry.name)) continue
      const from = path.join(source, relative, entry.name)
      const to = path.join(target, relative, entry.name)
      if (!equalPath(from, await fs.realpath(from))) throw new Error('Maven 보관 파일이 이동했습니다.')
      await fs.copyFile(from, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
    }
  }, signal)
}

async function prepareReplay(root, scratch, signal) {
  const mirror = path.join(scratch, 'mirror')
  const pluginGroups = await exclusive(root, async () => {
    const published = await currentSnapshot(root)
    if (!published) throw new Error('먼저 성공한 Maven 빌드의 의존성을 보관해 주세요.')
    await copySnapshot(published, mirror, signal)
    const groups = path.join(published, '.plugin-groups.json')
    const stat = await fs.lstat(groups).catch(() => null)
    if (!stat?.isFile() || stat.size > MAX_TRACKING_BYTES) return []
    const values = JSON.parse(await fs.readFile(groups, 'utf8'))
    return Array.isArray(values) ? values.filter(group => typeof group === 'string' && group.split('.').every(part => ARTIFACT_PART.test(part))) : []
  })
  const mirrorSettings = path.join(scratch, 'pinned-settings.xml')
  const globalSettings = path.join(scratch, 'empty-settings.xml')
  const url = pathToFileURL(mirror + path.sep).href
  const groups = pluginGroups.length ? `<pluginGroups>${pluginGroups.map(group => `<pluginGroup>${xml(group)}</pluginGroup>`).join('')}</pluginGroups>` : ''
  const body = `${groups}<mirrors><mirror><id>ezshell-pinned</id><mirrorOf>*</mirrorOf><url>${xml(url)}</url></mirror></mirrors>`
  await Promise.all([fs.writeFile(mirrorSettings, settings(body), { mode: 0o600 }), fs.writeFile(globalSettings, settings(''), { mode: 0o600 })])
  return { args: ['-s', mirrorSettings, '-gs', globalSettings], mirrorSettings, globalSettings, url }
}

/** Prepare a per-process Maven local repository. Call finish with the original process exit code once it exits. */
async function createMavenPinSession({ userData, presetId, mode = 'capture', maxBytes = MAX_BYTES, signal } = {}) {
  if (!['capture', 'replay'].includes(mode) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error('Maven 보관 설정을 확인해 주세요.')
  const root = await presetRoot(userData, presetId)
  await cleanAbandonedRuns(root)
  const scratch = await fs.mkdtemp(path.join(root, `run-${process.pid}-`))
  activeRuns.add(scratch)
  const repository = path.join(scratch, 'local')
  const cleanup = async () => {
    try { await removeOwned(root, scratch) } finally { activeRuns.delete(scratch) }
  }
  let completion
  try {
    await fs.mkdir(repository, { mode: 0o700 })
    const replay = mode === 'replay' ? await prepareReplay(root, scratch, signal) : null
    return { repository, args: [`-Dmaven.repo.local=${repository}`, ...(replay?.args ?? [])], replay,
      finish(exitCode, processSignal = signal) {
        return completion ??= (async () => {
          const finishing = signal && processSignal && signal !== processSignal ? AbortSignal.any([signal, processSignal]) : processSignal
          try {
            if (exitCode !== 0 || mode === 'replay' || finishing?.aborted) return { status: 'skipped' }
            return await exclusive(root, async () => {
              const result = await remoteFiles(repository, maxBytes, finishing)
              if (!result.artifacts.length) return { status: 'empty', skippedSnapshots: result.skippedSnapshots }
              const pinned = await publish(root, scratch, result, finishing)
              return { status: 'pinned', repository: pinned, artifacts: result.artifacts.length, metadata: result.metadata.length,
                bytes: result.bytes, skippedSnapshots: result.skippedSnapshots }
            })
          } finally { await cleanup() }
        })()
      }
    }
  } catch (error) { await cleanup(); throw error }
}

async function inspectMavenPin({ userData, presetId }) {
  const root = await presetRoot(userData, presetId, false)
  return root ? exclusive(root, async () => Boolean(await currentSnapshot(root))) : false
}

async function cleanMavenPinRuns({ userData, presetId }) {
  const root = await presetRoot(userData, presetId, false)
  if (root) await exclusive(root, () => cleanAbandonedRuns(root, true))
}

async function deleteMavenPin({ userData, presetId, approved = false, authorize = () => {} }) {
  if (approved !== true) throw new Error('먼저 Maven 보관본 삭제를 확인해 주세요.')
  const root = await presetRoot(userData, presetId, false)
  if (!root) return
  await exclusive(root, async () => {
    const pinned = await currentSnapshot(root)
    authorize()
    if (!pinned) return
    await fs.unlink(path.join(root, 'current.json'))
    await removeOwned(root, pinned)
  })
}

async function mavenExportDestination(worktree) {
  const destination = await local(worktree)
  if (!destination?.stat.isDirectory() || !equalPath(destination.path, worktree)) throw new Error('내보낼 워크트리 폴더를 다시 확인해 주세요.')
  return destination
}

async function exportMavenPin({ userData, presetId, worktree, expectedWorktree, approved = false, signal, authorize = () => {} } = {}) {
  if (approved !== true) throw new Error('먼저 프로젝트의 .mvn-repo로 내보내기를 확인해 주세요.')
  const destination = await mavenExportDestination(worktree)
  if (expectedWorktree && !sameEntry(expectedWorktree, destination.stat)) throw new Error('내보낼 워크트리 폴더가 바뀌었습니다.')
  const root = await presetRoot(userData, presetId)
  const folder = destination.path
  const target = path.join(folder, '.mvn-repo')
  const confirms = async (directory, expected) => {
    const entry = await local(directory)
    return entry?.stat.isDirectory() && equalPath(entry.path, directory) && sameEntry(entry.stat, expected)
  }
  const checkWorktree = async () => {
    if (!await confirms(folder, destination.stat)) throw new Error('내보낼 워크트리 폴더가 바뀌었습니다.')
  }
  return exclusive(root, async () => {
    const pinned = await currentSnapshot(root)
    if (!pinned) throw new Error('먼저 성공한 Maven 빌드의 의존성을 보관해 주세요.')
    signal?.throwIfAborted()
    authorize()
    await checkWorktree()
    signal?.throwIfAborted()
    authorize()
    const targetStat = await fs.mkdir(target, { mode: 0o700 }).then(() => fs.lstat(target)).catch(error => {
      if (error.code !== 'EEXIST') throw error
      throw new Error('이미 프로젝트에 .mvn-repo 폴더가 있습니다.')
    })
    const checkTarget = async () => {
      await checkWorktree()
      if (!await confirms(target, targetStat)) throw new Error('Maven 보관본을 내보낼 폴더가 바뀌었습니다.')
    }
    try {
      await checkTarget()
      authorize()
      await copySnapshot(pinned, target, signal)
      await checkTarget()
      signal?.throwIfAborted()
      authorize()
      return target
    } catch (error) {
      await checkTarget().then(() => removeOwned(folder, target)).catch(() => {})
      throw error
    }
  })
}

module.exports = { createMavenPinSession, exportMavenPin, mavenExportDestination, inspectMavenPin, deleteMavenPin, cleanMavenPinRuns }
