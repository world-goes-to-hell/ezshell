// Reads server files for the file window: text to edit, text to look at (the end of a large log),
// and the bytes of an image or PDF. Everything goes over SFTP with the login account's rights.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const remoteFile = require('../mcp/remoteFile.js')
const { readRemote } = require('../mcp/remoteTransfer.js')
const { copyRange, SourceShrank } = require('../mcp/transferCopy.js')

const MB = 1024 * 1024
const EDIT_MAX_BYTES = 5 * MB
const MEDIA_MAX_BYTES = 50 * MB
const TEXT_WHOLE_MAX_BYTES = 5 * MB
const TEXT_TAIL_BYTES = 1 * MB
// Kernel and device interfaces: their "files" are switches or never end
const SYSTEM_ROOTS = ['/proc', '/sys', '/dev']
const PERMISSION_DENIED = 3
const NO_SUCH_FILE = 2

const MESSAGES = {
  system: '시스템 경로(/proc, /sys, /dev)의 파일은 열 수 없습니다.',
  notFound: '파일이 없습니다.',
  denied: '파일을 읽을 권한이 없습니다.',
  folder: '폴더는 열 수 없습니다.',
  special: '일반 파일이 아닙니다 (장치, 소켓 등).',
  editTooLarge: `편집할 수 있는 파일은 ${EDIT_MAX_BYTES / MB}MB 까지입니다.`,
  mediaTooLarge: `미리볼 수 있는 파일은 ${MEDIA_MAX_BYTES / MB}MB 까지입니다.`,
  notText: '텍스트(UTF-8) 파일이 아닙니다.',
  changedWhileReading: '읽는 중에 파일이 바뀌었습니다. 다시 열어 주세요.',
  unreadable: '파일을 읽지 못했습니다.'
}

class RemoteReadError extends Error {
  constructor(userMessage, detail) {
    super(userMessage)
    this.userMessage = userMessage
    this.detail = detail
  }
}

const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
})
const quietly = (promise) => promise.then(() => true, () => false)

/** A message when the path must not be opened at all, otherwise null. */
function refuseSystemPath(target) {
  return SYSTEM_ROOTS.some(root => target === root || target.startsWith(`${root}/`)) ? MESSAGES.system : null
}

/** The message to show for an SFTP error while finding or opening a file. */
function messageFor(err) {
  if (err instanceof RemoteReadError || err instanceof remoteFile.RemoteFileError) return err.userMessage
  if (err && err.code === NO_SUCH_FILE) return MESSAGES.notFound
  if (err && err.code === PERMISSION_DENIED) return MESSAGES.denied
  return MESSAGES.unreadable
}

const refuse = (target) => {
  const message = refuseSystemPath(target)
  if (message) throw new RemoteReadError(message)
}

/** The real path behind links and its stats, after refusing system paths (the requested one and the real one). */
async function locateFile(sftp, requestedPath) {
  refuse(requestedPath)
  const realPath = await call(sftp, 'realpath', requestedPath)
  refuse(realPath)
  const stats = await call(sftp, 'stat', realPath)
  if (stats.isDirectory()) throw new RemoteReadError(MESSAGES.folder)
  if (!stats.isFile()) throw new RemoteReadError(MESSAGES.special)
  return { path: realPath, stats }
}

/** `length` bytes from `start`, a few pieces at a time (one at a time is slow on a distant server). */
async function readRange(sftp, handle, start, length) {
  const result = Buffer.alloc(length)
  try {
    await copyRange({
      size: length,
      readAt: (position, size) => readRemote(sftp, handle, start + position, size),
      writeAt: async (buffer, position) => { buffer.copy(result, position) },
      hash: { update() {} }
    })
  } catch (err) {
    if (err instanceof SourceShrank) throw new RemoteReadError(MESSAGES.changedWhileReading)
    throw err
  }
  return result
}

async function withHandle(sftp, target, work) {
  const handle = await call(sftp, 'open', target, 'r', {})
  try {
    return await work(handle)
  } finally {
    await quietly(call(sftp, 'close', handle))
  }
}

/** The bytes of an image or PDF, up to 50MB. */
async function readMedia(sftp, requestedPath, { maxBytes = MEDIA_MAX_BYTES } = {}) {
  const { path, stats } = await locateFile(sftp, requestedPath)
  if (stats.size > maxBytes) throw new RemoteReadError(MESSAGES.mediaTooLarge)
  const data = await withHandle(sftp, path, (handle) => readRange(sftp, handle, 0, stats.size))
  return { path, size: stats.size, data }
}

/**
 * Text as it is, with invalid UTF-8 shown as replacement characters; null when it holds NUL bytes
 * (binary), or without them when `dropNul` (a followed log: copytruncate can leave a run of NULs).
 */
function decodeLoosely(data, { dropNul = false } = {}) {
  let bytes = data
  if (bytes.includes(0)) {
    if (!dropNul) return null
    bytes = Buffer.from(bytes.filter(byte => byte !== 0))
  }
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(bytes)
}

/**
 * Text to look at: all of it up to 5MB, otherwise the last 1MB starting at a whole line.
 * `truncated` tells the window that the start is left out.
 */
async function readTextPreview(sftp, requestedPath, { wholeMaxBytes = TEXT_WHOLE_MAX_BYTES, tailBytes = TEXT_TAIL_BYTES, dropNul = false } = {}) {
  const { path, stats } = await locateFile(sftp, requestedPath)
  const truncated = stats.size > wholeMaxBytes
  const start = truncated ? stats.size - tailBytes : 0
  let data = await withHandle(sftp, path, (handle) => readRange(sftp, handle, start, stats.size - start))
  if (truncated) {
    // The cut may fall inside a line (or a character): begin after the first line break
    const firstBreak = data.indexOf(0x0a)
    if (firstBreak >= 0) data = data.subarray(firstBreak + 1)
  }
  const text = decodeLoosely(data, { dropNul })
  if (text === null) throw new RemoteReadError(MESSAGES.notText)
  return { path, size: stats.size, text, truncated, mtime: stats.mtime }
}

/** Whether the login account may write the file: opened for writing and closed at once, nothing written. */
async function canWriteFile(sftp, target) {
  try {
    const handle = await call(sftp, 'open', target, 'r+', {})
    await quietly(call(sftp, 'close', handle))
    return true
  } catch {
    return false
  }
}

/**
 * Text to edit, up to 5MB of UTF-8: `seen` is what a save compares the server file with.
 * `canWrite` false opens the window read-only.
 */
async function readForEdit(sftp, requestedPath, { maxBytes = EDIT_MAX_BYTES } = {}) {
  let seen
  try {
    seen = await remoteFile.inspectTarget(sftp, requestedPath, { maxBytes, refusePath: refuseSystemPath })
  } catch (err) {
    if (err instanceof remoteFile.RemoteFileError && err.userMessage === remoteFile.MESSAGES.tooLarge) {
      throw new RemoteReadError(MESSAGES.editTooLarge)
    }
    throw err
  }
  if (!seen.exists) throw new RemoteReadError(MESSAGES.notFound)
  return { seen, canWrite: await canWriteFile(sftp, seen.path) }
}

module.exports = {
  readMedia, readTextPreview, readForEdit, readRange, withHandle, refuseSystemPath, messageFor, RemoteReadError, MESSAGES,
  EDIT_MAX_BYTES, MEDIA_MAX_BYTES, TEXT_WHOLE_MAX_BYTES, TEXT_TAIL_BYTES
}
