// The server side of the MCP transfer tools, over SFTP (ssh2's wrapper is passed in).
// An upload goes to a partial file next to the target and replaces the target only when it is
// complete and the target is still what the user saw: a transfer can take minutes, and a file
// overwritten in place and then cut off could not be put back.
const path = require('path').posix
const crypto = require('crypto')
const { RemoteFileError } = require('./remoteFile.js')

const PART_MODE = 0o600
const MODE_BITS = 0o7777
// SFTP status codes (ssh2 puts them on err.code)
const END_OF_FILE = 1
const NO_SUCH_FILE = 2
const PERMISSION_DENIED = 3

const MESSAGES = {
  noParent: '서버에 상위 폴더가 없습니다.',
  parentNotFolder: '서버의 상위 경로가 폴더가 아닙니다.',
  denied: '서버의 경로에 접근할 권한이 없습니다.',
  noFile: '서버에 파일이 없습니다.',
  folder: '서버의 경로가 폴더입니다. 파일 하나만 전송할 수 있습니다.',
  special: '서버의 일반 파일이 아닙니다 (장치, 소켓 등).',
  brokenLink: '끊어진 심볼릭 링크입니다.',
  unreadable: '서버의 파일을 확인하지 못했습니다.',
  readDenied: '서버의 파일을 읽을 권한이 없습니다.',
  tooLarge: (limit) => `파일이 너무 큽니다 (${limit}까지).`,
  sourceChanged: '서버의 파일이 바뀌어 전송하지 않았습니다. 다시 요청하세요.',
  targetChanged: '서버의 받는 파일이 바뀌어 덮어쓰지 않았습니다. 다시 요청하세요.',
  cannotCreate: '서버에 파일을 만들 수 없습니다 (폴더에 쓸 권한이 있는지 확인하세요).',
  notVerified: '올린 뒤 파일 크기가 맞지 않아 제자리에 놓지 않았습니다.',
  cannotFinish: '올린 파일을 제자리에 놓지 못했습니다.',
  noReplace: '이 서버는 기존 파일을 바꿔치기하는 기능(posix-rename)이 없어 덮어쓸 수 없습니다. 다른 이름으로 올리세요.'
}

const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  try {
    sftp[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
  } catch (err) {
    reject(err)
  }
})
const quietly = (promise) => promise.then(() => true, () => false)
const isMissing = (err) => Boolean(err) && err.code === NO_SUCH_FILE
const isDenied = (err) => Boolean(err) && err.code === PERMISSION_DENIED
const fail = (message, err) => new RemoteFileError(message, err && err.message)
const formatLimit = (bytes) => (bytes >= 1024 * 1024 ? `${Math.floor(bytes / (1024 * 1024))}MB` : `${bytes}바이트`)

/**
 * What is at `requestedPath` (absolute, normalised), without reading it: the real path behind
 * links and the stats of what is there. `refusePath(path)` returns a message for a path that must
 * not be touched at all; it is asked for the requested path and for the real one.
 */
async function locate(sftp, requestedPath, refusePath) {
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
    if (isMissing(err)) return { requestedPath, path: candidate, exists: false, isSymlink: false, stats: null }
    throw fail(isDenied(err) ? MESSAGES.denied : MESSAGES.unreadable, err)
  }
  if (!entry.isSymbolicLink()) return { requestedPath, path: candidate, exists: true, isSymlink: false, stats: entry }
  try {
    const target = await call(sftp, 'realpath', candidate)
    guard(target)
    return { requestedPath, path: target, exists: true, isSymlink: true, stats: await call(sftp, 'stat', target) }
  } catch (err) {
    if (err instanceof RemoteFileError) throw err
    throw fail(isMissing(err) ? MESSAGES.brokenLink : MESSAGES.unreadable, err)
  }
}

function assertRegularFile(stats) {
  if (stats.isDirectory()) throw new RemoteFileError(MESSAGES.folder)
  if (!stats.isFile()) throw new RemoteFileError(MESSAGES.special)
}

/** Where an upload would go: { requestedPath, path, exists, isSymlink, size, mtime, mode, uid }. */
async function inspectRemoteTarget(sftp, requestedPath, { refusePath = () => null } = {}) {
  const found = await locate(sftp, requestedPath, refusePath)
  const { stats, ...where } = found
  if (!found.exists) return { ...where, size: null, mtime: null, mode: null, uid: null }
  assertRegularFile(stats)
  return { ...where, size: stats.size, mtime: stats.mtime, mode: stats.mode, uid: stats.uid }
}

/** The file to download: { requestedPath, path, isSymlink, size, mtime }. */
async function inspectRemoteSource(sftp, requestedPath, { refusePath = () => null, maxBytes }) {
  const found = await locate(sftp, requestedPath, refusePath)
  if (!found.exists) throw new RemoteFileError(MESSAGES.noFile)
  assertRegularFile(found.stats)
  if (found.stats.size > maxBytes) throw new RemoteFileError(MESSAGES.tooLarge(formatLimit(maxBytes)))
  return { requestedPath, path: found.path, isSymlink: found.isSymlink, size: found.stats.size, mtime: found.stats.mtime }
}

const sameTarget = (a, b) => a.path === b.path && a.exists === b.exists && a.size === b.size && a.mtime === b.mtime

/** Whether the file being replaced belongs to another account than the one logged in (null when unknown). */
async function remoteOwnerDiffers(sftp, home, uid) {
  if (!home || typeof uid !== 'number') return null
  try {
    return (await call(sftp, 'stat', home)).uid !== uid
  } catch {
    return null
  }
}

/** Open the file `seen` describes for reading; it must still have the size and time the user was shown. */
async function openRemoteSource(sftp, seen) {
  const entry = await call(sftp, 'lstat', seen.path).catch((err) => { throw fail(MESSAGES.sourceChanged, err) })
  if (entry.isSymbolicLink() || !entry.isFile()) throw new RemoteFileError(MESSAGES.sourceChanged)
  let handle
  try {
    handle = await call(sftp, 'open', seen.path, 'r', {})
  } catch (err) {
    throw fail(isDenied(err) ? MESSAGES.readDenied : MESSAGES.sourceChanged, err)
  }
  if (!(await isRemoteSourceUnchanged(sftp, handle, seen))) {
    await quietly(call(sftp, 'close', handle))
    throw new RemoteFileError(MESSAGES.sourceChanged)
  }
  return handle
}

async function isRemoteSourceUnchanged(sftp, handle, seen) {
  try {
    const stats = await call(sftp, 'fstat', handle)
    return stats.isFile() && stats.size === seen.size && stats.mtime === seen.mtime
  } catch {
    return false
  }
}

/** Read `length` bytes at `position` from the open file (fewer when the file ends early). */
async function readRemote(sftp, handle, position, length) {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    let bytesRead
    try {
      bytesRead = await call(sftp, 'read', handle, buffer, filled, length - filled, position + filled)
    } catch (err) {
      if (err && err.code === END_OF_FILE) break
      throw err
    }
    if (!bytesRead) break
    filled += bytesRead
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

const writeRemote = (sftp, handle, buffer, position) => call(sftp, 'write', handle, buffer, 0, buffer.length, position)
const closeRemote = (sftp, handle) => quietly(call(sftp, 'close', handle))

/** A new, empty partial file beside the target, readable by the account only: { path, handle }. */
async function createRemotePart(sftp, targetPath) {
  const name = `.${path.basename(targetPath)}.ezshell-part-${crypto.randomBytes(4).toString('hex')}`
  const partPath = path.join(path.dirname(targetPath), name)
  try {
    // 'wx' is exclusive: it fails for a file, or a link, that already has this name
    return { path: partPath, handle: await call(sftp, 'open', partPath, 'wx', { mode: PART_MODE }) }
  } catch (err) {
    throw fail(MESSAGES.cannotCreate, err)
  }
}

/**
 * Put the finished partial file in the target's place, if the target is still what `seen`
 * describes. `mode` is what the file ends up with, `bytes` what it must hold.
 */
async function commitRemotePart(sftp, part, seen, { mode, bytes }) {
  try {
    await call(sftp, 'fsetstat', part.handle, { mode: mode & MODE_BITS })
    await call(sftp, 'close', part.handle)
  } catch (err) {
    throw fail(MESSAGES.cannotFinish, err)
  }
  const written = await call(sftp, 'stat', part.path).catch(() => null)
  if (!written || written.size !== bytes) throw new RemoteFileError(MESSAGES.notVerified)

  const current = await call(sftp, 'lstat', seen.path).then(
    (stats) => ({ path: seen.path, exists: true, size: stats.size, mtime: stats.mtime, isPlainFile: stats.isFile() && !stats.isSymbolicLink() }),
    (err) => (isMissing(err) ? { path: seen.path, exists: false, size: null, mtime: null, isPlainFile: true } : null)
  )
  if (!current || !current.isPlainFile || !sameTarget(current, seen)) throw new RemoteFileError(MESSAGES.targetChanged)

  if (!seen.exists) {
    // Plain rename refuses a name that is taken, so a file that appeared just now is not replaced
    await call(sftp, 'rename', part.path, seen.path).catch((err) => { throw fail(MESSAGES.targetChanged, err) })
    return
  }
  if (typeof sftp.ext_openssh_rename !== 'function') throw new RemoteFileError(MESSAGES.noReplace)
  try {
    await call(sftp, 'ext_openssh_rename', part.path, seen.path)
  } catch (err) {
    // ssh2 throws (no status code) when the server does not offer the extension
    throw fail(typeof (err && err.code) === 'number' ? MESSAGES.cannotFinish : MESSAGES.noReplace, err)
  }
}

async function discardRemotePart(sftp, part) {
  await closeRemote(sftp, part.handle)
  await quietly(call(sftp, 'unlink', part.path))
}

module.exports = {
  inspectRemoteTarget, inspectRemoteSource, remoteOwnerDiffers, openRemoteSource, isRemoteSourceUnchanged,
  readRemote, writeRemote, closeRemote, createRemotePart, commitRemotePart, discardRemotePart, sameTarget, MESSAGES
}
