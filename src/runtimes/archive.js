const fs = require('node:fs/promises')
const path = require('node:path')
const tar = require('tar')
const { extractZip, safeTarget, claimArchivePath } = require('../dbClient/unzip.js')

const FILES = new Set(['File', 'OldFile', 'ContiguousFile'])
const MAX_ENTRIES = 20_000
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
const isRootDirectory = entry => entry.type === 'Directory' && /^\.(?:\/)?$/.test(entry.path)
const invalidPath = () => new Error('압축 파일에 보관함을 벗어나거나 지원하지 않는 경로가 있습니다.')

function archivePath(root, name) {
  if (name.includes('\\')) return null
  return safeTarget(root, name)
}

async function extractTar(archive, root, signal, allowRepeatedDirectories) {
  const entries = new Map()
  const paths = new Map()
  let expanded = 0
  let count = 0
  let problem = null
  let rootSeen = false
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    if (problem) return
    if (isRootDirectory(entry)) {
      if (rootSeen) problem = invalidPath()
      rootSeen = true
      return
    }
    if (signal?.aborted) { problem = signal.reason; return }
    const target = archivePath(root, entry.path)
    if (!target || ++count > MAX_ENTRIES || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      problem = invalidPath()
      return
    }
    expanded += entry.size
    if (expanded > MAX_EXPANDED_BYTES) { problem = new Error('JDK 압축을 푼 크기가 너무 큽니다.'); return }
    const type = FILES.has(entry.type) ? 'file' : entry.type
    const previous = entries.get(target)
    if (allowRepeatedDirectories && type === 'Directory' && previous?.type === 'Directory'
      && previous.name === entry.path && previous.mode === entry.mode && previous.size === 0 && entry.size === 0) return
    if (!['file', 'Directory', 'SymbolicLink', 'Link'].includes(type) || !claimArchivePath(paths, root, target, type === 'Directory')) {
      problem = invalidPath()
      return
    }
    entries.set(target, { type, name: entry.path, link: entry.linkpath, mode: entry.mode, size: entry.size })
  } })
  if (problem) throw problem
  signal?.throwIfAborted()

  const links = []
  for (const [target, entry] of entries) {
    if (entry.type === 'file' || entry.type === 'Directory') continue
    const link = entry.link
    if (!link || link.includes('\\') || path.posix.isAbsolute(link) || /^[A-Za-z]:/.test(link)) throw invalidPath()
    const relative = entry.type === 'SymbolicLink' ? path.posix.join(path.posix.dirname(entry.name), link) : link
    const source = archivePath(root, relative)
    const sourceType = entries.get(source)?.type
    // Don't follow chains or let a symlink change the meaning of another path.
    if (!source || (sourceType !== 'file' && !(entry.type === 'SymbolicLink' && sourceType === 'Directory'))) throw invalidPath()
    if (sourceType === 'Directory' && target.startsWith(source + path.sep)) throw invalidPath()
    links.push({ target, source, type: entry.type, sourceType })
  }

  await fs.mkdir(root, { recursive: true })
  const writtenDirectories = new Set()
  await tar.x({ file: archive, cwd: root, strict: true, preserveOwner: false, filter(_name, entry) {
    if (signal?.aborted || isRootDirectory(entry)) return false
    if (allowRepeatedDirectories && entry.type === 'Directory') {
      if (writtenDirectories.has(entry.path)) return false
      writtenDirectories.add(entry.path)
    }
    entry.mode &= 0o777
    return entry.type === 'Directory' || FILES.has(entry.type)
  } })
  signal?.throwIfAborted()
  for (const { target, source, type, sourceType } of links) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    if (type === 'Link') await fs.link(source, target)
    else await fs.symlink(path.relative(path.dirname(target), source), target, sourceType === 'Directory' ? 'dir' : 'file')
  }
}

function extractArchive(file, root, archive, signal, { allowRepeatedDirectories = false } = {}) {
  return archive === 'zip' ? extractZip(file, root, { signal }) : extractTar(file, root, signal, allowRepeatedDirectories)
}

module.exports = { extractArchive }
