// Read-only previews for paths already authorized by the conversation's link list.
const fs = require('node:fs')
const path = require('node:path')
const { isLocalFilePath } = require('../localKeyPath.js')
const { previewKind } = require('../remoteFiles/fileKind.js')

const MB = 1024 * 1024
const TEXT_HEAD_BYTES = MB
const TEXT_MAX_BYTES = 2 * MB
const MEDIA_MAX_BYTES = 32 * MB
const DIRECTORY_LIMIT = 60
const MAX_LINK_HOPS = 24
const READ_FLAGS = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0
  : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])$/i

function isPreviewLocalPath(value, platform = process.platform) {
  if (!isLocalFilePath(value)) return false
  if (platform !== 'win32') return value.startsWith('/')
  if (!/^[a-z]:[\\/]/i.test(value)) return false
  return value.slice(3).split(/[\\/]/).every(part => {
    const stem = part.split('.')[0].trimEnd()
    return !/[:<>"|?*]|[ .]$/.test(part) && !WINDOWS_DEVICE.test(stem)
  })
}

function localLinkDestination(link, parent) {
  if (/^[\\/]{2}/.test(link) || (process.platform === 'win32' && /^[a-z]:(?![\\/])/i.test(link))) {
    throw new Error('Non-local link')
  }
  return path.resolve(parent, link)
}

/** Check a symlink or junction before resolving its target, including links in parent folders. */
async function resolveLocalPreviewPath(requested) {
  if (!isPreviewLocalPath(requested)) throw new Error('Non-local path')
  let pending = path.normalize(requested)
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops++) {
    if (!isPreviewLocalPath(pending)) throw new Error('Non-local link destination')
    let current = path.parse(pending).root
    const parts = pending.slice(current.length).split(path.sep).filter(Boolean)
    let stat = await fs.promises.lstat(current)
    let next
    for (let index = 0; index < parts.length; index++) {
      if (!stat.isDirectory()) throw new Error('Invalid parent')
      current = path.join(current, parts[index])
      stat = await fs.promises.lstat(current)
      if (stat.isSymbolicLink()) {
        const target = localLinkDestination(await fs.promises.readlink(current), path.dirname(current))
        if (!isPreviewLocalPath(target)) throw new Error('Non-local link destination')
        next = path.join(target, ...parts.slice(index + 1))
        break
      }
    }
    if (!next) return { path: current, stat }
    pending = next
  }
  throw new Error('Too many symbolic links')
}

function sameEntry(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.birthtimeMs === second.birthtimeMs
}

async function confirmEntry(entry, permitted) {
  const current = await resolveLocalPreviewPath(entry.path)
  if (!permitted() || current.path !== entry.path || !sameEntry(current.stat, entry.stat)) throw new Error('Preview changed')
}

async function readPrefix(entry, length, permitted) {
  const handle = await fs.promises.open(entry.path, READ_FLAGS)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameEntry(opened, entry.stat)) throw new Error('Preview changed')
    await confirmEntry(entry, permitted)
    const data = Buffer.alloc(length)
    let offset = 0
    while (offset < length && permitted()) {
      const { bytesRead } = await handle.read(data, offset, length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return data.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

async function listDirectory(entry, permitted) {
  const directory = await fs.promises.opendir(entry.path)
  try {
    await confirmEntry(entry, permitted)
    const entries = []
    while (entries.length < DIRECTORY_LIMIT && permitted()) {
      const child = await directory.read()
      if (!child) return { entries, truncated: false }
      const kind = child.isDirectory() ? 'directory' : child.isSymbolicLink() ? 'link' : child.isFile() ? 'file' : 'other'
      entries.push({ name: child.name, kind })
    }
    return { entries, truncated: permitted() && Boolean(await directory.read()) }
  } finally {
    await directory.close()
  }
}

function textOf(data, truncated = false) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: truncated })
    return /[\x00-\x08\x0b\x0e-\x1f\x7f-\x9f]/.test(text) ? null : text
  } catch { return null }
}

function matchesMedia(data, mime) {
  switch (mime) {
    case 'application/pdf': return data.subarray(0, 5).toString() === '%PDF-'
    case 'image/png': return data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    case 'image/jpeg': return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    case 'image/gif': return /^GIF8[79]a$/.test(data.subarray(0, 6).toString())
    case 'image/webp': return data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'
    case 'image/bmp': return data.subarray(0, 2).toString() === 'BM'
    case 'image/x-icon': return data.length >= 4 && data.readUInt32LE(0) === 0x00010000
    case 'image/svg+xml': return /<svg[\s>]/i.test(textOf(data.subarray(0, 8192), data.length > 8192) ?? '')
    default: return false
  }
}

async function readLinkPreview(target, permitted = () => true) {
  if (!permitted()) throw new Error('Preview no longer requested')
  const entry = await resolveLocalPreviewPath(target.path)
  if (!permitted()) throw new Error('Preview no longer requested')
  const { stat } = entry
  // Keep the resolved location in main. The chat displays and copies the requested path.
  const metadata = {
    path: target.path,
    name: path.basename(target.path) || target.path,
    linked: path.relative(target.path, entry.path) !== '',
    size: stat.isDirectory() ? null : stat.size,
    modifiedAt: stat.mtimeMs, line: target.line ?? null
  }
  if (stat.isDirectory()) {
    const listing = await listDirectory(entry, permitted)
    if (!permitted()) throw new Error('Preview no longer requested')
    return { ...metadata, kind: 'directory', ...listing }
  }
  if (!stat.isFile()) return { ...metadata, kind: 'unavailable', reason: 'unsupported' }

  const { kind, mime } = previewKind(path.basename(entry.path))
  const limit = kind === 'text' ? TEXT_MAX_BYTES : MEDIA_MAX_BYTES
  if (stat.size > limit) return { ...metadata, kind: 'unavailable', reason: 'too-large' }
  const length = kind === 'text' ? Math.min(stat.size, TEXT_HEAD_BYTES) : stat.size
  const data = await readPrefix(entry, length, permitted)
  if (!permitted()) throw new Error('Preview no longer requested')
  if (kind !== 'text') {
    return matchesMedia(data, mime) ? { ...metadata, kind, mime, data } : { ...metadata, kind: 'unavailable', reason: 'unsupported' }
  }
  const truncated = length < stat.size
  const text = textOf(data, truncated)
  return text === null ? { ...metadata, kind: 'unavailable', reason: 'unsupported' } : { ...metadata, kind, text, truncated }
}

module.exports = { isPreviewLocalPath, readLinkPreview, resolveLocalPreviewPath, TEXT_HEAD_BYTES, TEXT_MAX_BYTES, MEDIA_MAX_BYTES, DIRECTORY_LIMIT }
