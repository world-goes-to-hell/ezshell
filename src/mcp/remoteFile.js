// Looks at a remote text file over SFTP and writes it, for the MCP file tools.
// No shell is involved, so quoting cannot change what is written. A write only happens when the
// file is still exactly what the user was shown. The SFTP object is passed in (ssh2's wrapper).
const path = require('path').posix

const MAX_FILE_BYTES = 256 * 1024
const NEW_FILE_MODE = 0o644
const READ_CHUNK_BYTES = 32 * 1024
// SFTP status codes (ssh2 puts them on err.code)
const END_OF_FILE = 1
const NO_SUCH_FILE = 2
const PERMISSION_DENIED = 3

const LIMIT_LABEL = `${MAX_FILE_BYTES / 1024}KB까지`
const MESSAGES = {
  noParent: '상위 폴더가 없습니다.',
  parentNotFolder: '상위 경로가 폴더가 아닙니다.',
  denied: '접근할 권한이 없습니다.',
  readDenied: '파일을 읽을 권한이 없습니다.',
  folder: '폴더에는 쓸 수 없습니다.',
  special: '일반 파일이 아닙니다 (장치, 소켓 등).',
  brokenLink: '끊어진 심볼릭 링크입니다.',
  tooLarge: `파일이 너무 큽니다 (${LIMIT_LABEL}).`,
  contentTooLarge: `내용이 너무 큽니다 (${LIMIT_LABEL}).`,
  notText: '텍스트(UTF-8) 파일이 아닙니다.',
  unreadable: '파일을 확인하지 못했습니다.',
  changed: '파일이 바뀌어 쓰지 않았습니다. 다시 요청하세요.',
  cancelled: '요청이 취소되어 쓰지 않았습니다.',
  cannotCreate: '파일을 만들 수 없습니다.',
  cannotOpen: '파일을 쓰기용으로 열 수 없습니다.',
  writeFailedNew: '파일을 쓰는 중 오류가 발생했습니다.',
  restored: '쓰는 중 오류가 발생해 이전 내용으로 되돌렸습니다.',
  notRestored: '쓰는 중 오류가 발생했고 이전 내용으로 되돌리지 못했습니다. 파일을 확인하세요.',
  notVerified: '쓴 뒤 파일 크기가 맞지 않습니다. 파일을 확인하세요.'
}

/** `userMessage` is safe to show to Claude and the user; `detail` (the SFTP error) is for logs only. */
class RemoteFileError extends Error {
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
const isMissing = (err) => Boolean(err) && err.code === NO_SUCH_FILE
const isDenied = (err) => Boolean(err) && err.code === PERMISSION_DENIED
const fail = (message, err) => new RemoteFileError(message, err && err.message)

/** The bytes as text, or null when they are not UTF-8 text. A byte order mark stays part of the text. */
function decodeText(data) {
  if (data.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
  } catch {
    return null
  }
}

/**
 * Read an open file to its end, but never more than the limit: a file can be larger than its
 * reported size (files under /proc report 0), or grow, or be swapped after the size was checked.
 */
async function readBounded(sftp, handle, maxBytes) {
  const chunks = []
  let total = 0
  for (;;) {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES)
    let bytesRead
    try {
      bytesRead = await call(sftp, 'read', handle, buffer, 0, READ_CHUNK_BYTES, total)
    } catch (err) {
      if (err && err.code === END_OF_FILE) break
      throw err
    }
    if (!bytesRead) break
    total += bytesRead
    if (total > maxBytes) throw new RemoteFileError(MESSAGES.tooLarge)
    chunks.push(buffer.subarray(0, bytesRead))
  }
  return Buffer.concat(chunks)
}

/** The content behind an open handle, after checking the handle itself is a regular file within the limit. */
async function readHandle(sftp, handle, maxBytes) {
  const stats = await call(sftp, 'fstat', handle)
  if (stats.isDirectory()) throw new RemoteFileError(MESSAGES.folder)
  if (!stats.isFile()) throw new RemoteFileError(MESSAGES.special)
  if (stats.size > maxBytes) throw new RemoteFileError(MESSAGES.tooLarge)
  return { stats, data: await readBounded(sftp, handle, maxBytes) }
}

/**
 * What is at `requestedPath` (absolute, normalised): the real path behind links, whether a file
 * exists there, and its text. Throws RemoteFileError for anything that cannot be written as a text file.
 * `refusePath(path)` returns a message for a path that must not be touched at all (or null); it is
 * asked for the requested path and for the real one, before anything is read.
 */
async function inspectTarget(sftp, requestedPath, { maxBytes = MAX_FILE_BYTES, refusePath = () => null } = {}) {
  const guard = (target) => {
    const message = refusePath(target)
    if (message) throw new RemoteFileError(message)
  }
  guard(requestedPath)

  let realParent
  try {
    realParent = await call(sftp, 'realpath', path.dirname(requestedPath))
    const parent = await call(sftp, 'stat', realParent)
    if (!parent.isDirectory()) throw new RemoteFileError(MESSAGES.parentNotFolder)
  } catch (err) {
    if (err instanceof RemoteFileError) throw err
    if (isMissing(err)) throw fail(MESSAGES.noParent, err)
    throw fail(isDenied(err) ? MESSAGES.denied : MESSAGES.parentNotFolder, err)
  }

  const candidate = path.join(realParent, path.basename(requestedPath))
  guard(candidate)
  let entry
  try {
    entry = await call(sftp, 'lstat', candidate)
  } catch (err) {
    if (isMissing(err)) return { requestedPath, path: candidate, exists: false, isSymlink: false, content: null, mode: null }
    throw fail(isDenied(err) ? MESSAGES.denied : MESSAGES.unreadable, err)
  }

  const isSymlink = entry.isSymbolicLink()
  let target = candidate
  let stats = entry
  if (isSymlink) {
    try {
      target = await call(sftp, 'realpath', candidate)
      stats = await call(sftp, 'stat', target)
    } catch (err) {
      throw fail(isMissing(err) ? MESSAGES.brokenLink : MESSAGES.unreadable, err)
    }
    guard(target)
  }
  if (stats.isDirectory()) throw new RemoteFileError(MESSAGES.folder)
  if (!stats.isFile()) throw new RemoteFileError(MESSAGES.special)
  if (stats.size > maxBytes) throw new RemoteFileError(MESSAGES.tooLarge)

  let handle
  try {
    handle = await call(sftp, 'open', target, 'r', {})
  } catch (err) {
    throw fail(isDenied(err) ? MESSAGES.readDenied : MESSAGES.unreadable, err)
  }
  let read
  try {
    read = await readHandle(sftp, handle, maxBytes)
  } catch (err) {
    throw err instanceof RemoteFileError ? err : fail(MESSAGES.unreadable, err)
  } finally {
    await quietly(call(sftp, 'close', handle))
  }
  const content = decodeText(read.data)
  if (content === null) throw new RemoteFileError(MESSAGES.notText)
  return { requestedPath, path: target, exists: true, isSymlink, content, mode: read.stats.mode }
}

/** Create the file (never replacing one that appeared meanwhile) and write all of it. */
async function createFile(sftp, target, data, mode, { signal, onWriteStart }) {
  const appeared = await call(sftp, 'lstat', target).then(() => true, (err) => !isMissing(err))
  if (appeared) throw new RemoteFileError(MESSAGES.changed)
  if (signal && signal.aborted) throw new RemoteFileError(MESSAGES.cancelled)
  onWriteStart()
  let handle
  try {
    // 'wx' is exclusive: it fails for a file, or a link, that exists by now
    handle = await call(sftp, 'open', target, 'wx', { mode })
  } catch (err) {
    throw fail(MESSAGES.cannotCreate, err)
  }
  try {
    if (data.length > 0) await call(sftp, 'write', handle, data, 0, data.length, 0)
    await call(sftp, 'close', handle)
    const written = await call(sftp, 'stat', target)
    if (written.size !== data.length) throw new Error('size mismatch after write')
  } catch (err) {
    await quietly(call(sftp, 'close', handle))
    // The file is ours (created just now); do not leave a partial one behind
    await quietly(call(sftp, 'unlink', target))
    throw fail(MESSAGES.writeFailedNew, err)
  }
}

/** Put `data` into the open file from the start and cut the file to that length. */
async function fillHandle(sftp, handle, data) {
  if (data.length > 0) await call(sftp, 'write', handle, data, 0, data.length, 0)
  await call(sftp, 'fsetstat', handle, { size: data.length })
}

/**
 * Overwrite the existing file in place (owner, mode, ACLs and labels stay). The file is opened once;
 * what is behind that handle is compared with what the user saw, and the same handle is written,
 * so a path swapped in between is never followed. If writing fails halfway the previous content is
 * put back through the same handle.
 */
async function overwriteFile(sftp, seen, data, maxBytes, { signal, onWriteStart }) {
  const entry = await call(sftp, 'lstat', seen.path).catch((err) => { throw fail(MESSAGES.changed, err) })
  if (entry.isSymbolicLink() || !entry.isFile()) throw new RemoteFileError(MESSAGES.changed)

  let handle
  try {
    handle = await call(sftp, 'open', seen.path, 'r+', {})
  } catch (err) {
    throw fail(isDenied(err) ? MESSAGES.cannotOpen : MESSAGES.changed, err)
  }
  const previous = Buffer.from(seen.content, 'utf8')
  let hasStarted = false
  try {
    const current = await readHandle(sftp, handle, maxBytes).catch((err) => { throw fail(MESSAGES.changed, err) })
    if (!current.data.equals(previous)) throw new RemoteFileError(MESSAGES.changed)
    if (signal && signal.aborted) throw new RemoteFileError(MESSAGES.cancelled)
    onWriteStart()
    hasStarted = true
    await fillHandle(sftp, handle, data)
    await call(sftp, 'close', handle)
  } catch (err) {
    if (!hasStarted) {
      await quietly(call(sftp, 'close', handle))
      throw err instanceof RemoteFileError ? err : fail(MESSAGES.changed, err)
    }
    const restored = await quietly(fillHandle(sftp, handle, previous))
    await quietly(call(sftp, 'close', handle))
    throw fail(restored ? MESSAGES.restored : MESSAGES.notRestored, err)
  }
  const written = await call(sftp, 'stat', seen.path).catch(() => null)
  if (!written || written.size !== data.length) throw new RemoteFileError(MESSAGES.notVerified)
}

/**
 * Write `content` to the file described by `seen` (the result of inspectTarget the user approved),
 * only if the file is still the same. A cancel is honoured until the write starts; after that the
 * write runs to the end. `onWriteStart` is called at that point (the caller extends its time limit).
 */
async function writeIfUnchanged(sftp, seen, content, { signal, maxBytes = MAX_FILE_BYTES, newFileMode = NEW_FILE_MODE, onWriteStart = () => {} } = {}) {
  const data = Buffer.from(content, 'utf8')
  if (data.length > maxBytes) throw new RemoteFileError(MESSAGES.contentTooLarge)
  if (seen.exists) await overwriteFile(sftp, seen, data, maxBytes, { signal, onWriteStart })
  else await createFile(sftp, seen.path, data, newFileMode, { signal, onWriteStart })
  return { path: seen.path, bytes: data.length, created: !seen.exists }
}

module.exports = { inspectTarget, writeIfUnchanged, RemoteFileError, MAX_FILE_BYTES }
