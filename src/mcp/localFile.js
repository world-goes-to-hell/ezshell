// The PC side of the MCP transfer tools: read a file to upload, and write a downloaded one.
// The path given here has already passed localPath.js (it lies in a registered folder).
// A file to upload is opened once and only that handle is read, so a path swapped for a link after
// the user was asked is not followed. A download goes to a partial file next to the target and
// takes the target's name only when it is complete and the target is still what the user saw.
const nodePath = require('path')
const crypto = require('crypto')

const MESSAGES = {
  noFile: 'PC 에 파일이 없습니다.',
  folder: 'PC 경로가 폴더입니다. 파일 하나만 전송할 수 있습니다.',
  special: 'PC 의 일반 파일이 아닙니다.',
  link: 'PC 의 받는 파일이 링크입니다. 링크에는 내려받을 수 없습니다.',
  unreadable: 'PC 의 파일을 열 수 없습니다.',
  tooLarge: (limit) => `파일이 너무 큽니다 (${limit}까지).`,
  sourceChanged: 'PC 의 파일이 바뀌어 전송하지 않았습니다. 다시 요청하세요.',
  hardLink: '다른 이름으로도 연결된 파일(하드 링크)은 올릴 수 없습니다. 파일을 복사한 뒤 복사본을 올리세요.',
  unverifiable: '이 드라이브의 파일은 같은 파일인지 확인할 수 없어 올릴 수 없습니다.',
  targetChanged: 'PC 의 받는 파일이 바뀌어 덮어쓰지 않았습니다. 다시 요청하세요.',
  cannotCreate: 'PC 에 파일을 만들 수 없습니다.',
  cannotFinish: '내려받은 파일을 제자리에 놓지 못했습니다.'
}

/** `userMessage` is safe to show to Claude and the user; `detail` is for logs only. */
class LocalFileError extends Error {
  constructor(userMessage, detail) {
    super(userMessage)
    this.userMessage = userMessage
    this.detail = detail
  }
}

const fail = (message, err) => new LocalFileError(message, err && err.message)
const isMissing = (err) => Boolean(err) && err.code === 'ENOENT'
const quietly = (promise) => promise.then(() => true, () => false)
const formatLimit = (bytes) => (bytes >= 1024 * 1024 ? `${Math.floor(bytes / (1024 * 1024))}MB` : `${bytes}바이트`)
const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev

/**
 * Open the file to upload. Resolves with { handle, size, mtimeNs, ino, dev }; the caller closes the handle.
 * `filePath` is a real path, so finding a link there means it was put there just now.
 * A file with a second name (hard link) is refused: it passes every check on its path while its
 * content may belong to a file anywhere on the drive.
 */
async function openLocalSource(filePath, { fsp, maxBytes }) {
  let entry
  try {
    entry = await fsp.lstat(filePath, { bigint: true })
  } catch (err) {
    throw fail(isMissing(err) ? MESSAGES.noFile : MESSAGES.unreadable, err)
  }
  if (entry.isSymbolicLink()) throw new LocalFileError(MESSAGES.sourceChanged)
  if (entry.isDirectory()) throw new LocalFileError(MESSAGES.folder)
  if (!entry.isFile()) throw new LocalFileError(MESSAGES.special)
  let handle
  try {
    handle = await fsp.open(filePath, 'r')
  } catch (err) {
    throw fail(MESSAGES.unreadable, err)
  }
  try {
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile()) throw new LocalFileError(MESSAGES.special)
    // Without a file id nothing below could tell this file from another one
    if (stats.ino === 0n) throw new LocalFileError(MESSAGES.unverifiable)
    if (!sameFile(stats, entry)) throw new LocalFileError(MESSAGES.sourceChanged)
    if (stats.nlink > 1n) throw new LocalFileError(MESSAGES.hardLink)
    if (stats.size > BigInt(maxBytes)) throw new LocalFileError(MESSAGES.tooLarge(formatLimit(maxBytes)))
    return { handle, size: Number(stats.size), mtimeNs: stats.mtimeNs, ino: stats.ino, dev: stats.dev }
  } catch (err) {
    await quietly(handle.close())
    throw err instanceof LocalFileError ? err : fail(MESSAGES.unreadable, err)
  }
}

/** Whether `filePath` (resolved again after the file was opened) is the very file behind the handle. */
async function isSameLocalFile(source, filePath, { fsp }) {
  try {
    return sameFile(await fsp.stat(filePath, { bigint: true }), source)
  } catch {
    return false
  }
}

/** Whether the open file still has the size and time the user was shown. */
async function isLocalSourceUnchanged(source) {
  try {
    const stats = await source.handle.stat({ bigint: true })
    return Number(stats.size) === source.size && stats.mtimeNs === source.mtimeNs
  } catch {
    return false
  }
}

/** Read `length` bytes at `position` from the open file (fewer when the file ends early). */
async function readLocal(handle, position, length) {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (!bytesRead) break
    filled += bytesRead
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

/** What is where a download would go: { exists, size, mtimeNs }. */
async function inspectLocalTarget(filePath, { fsp }) {
  let entry
  try {
    entry = await fsp.lstat(filePath, { bigint: true })
  } catch (err) {
    if (isMissing(err)) return { exists: false, size: null, mtimeNs: null }
    throw fail(MESSAGES.unreadable, err)
  }
  if (entry.isSymbolicLink()) throw new LocalFileError(MESSAGES.link)
  if (entry.isDirectory()) throw new LocalFileError(MESSAGES.folder)
  if (!entry.isFile()) throw new LocalFileError(MESSAGES.special)
  return { exists: true, size: Number(entry.size), mtimeNs: entry.mtimeNs }
}

const sameTarget = (a, b) => a.exists === b.exists && a.size === b.size && a.mtimeNs === b.mtimeNs

/** A new, empty partial file beside the target: { path, handle }. Fails rather than reuse a name. */
async function createLocalPart(targetPath, { fsp }) {
  const name = `.${nodePath.basename(targetPath)}.ezshell-part-${crypto.randomBytes(4).toString('hex')}`
  const partPath = nodePath.join(nodePath.dirname(targetPath), name)
  try {
    return { path: partPath, handle: await fsp.open(partPath, 'wx') }
  } catch (err) {
    throw fail(MESSAGES.cannotCreate, err)
  }
}

/** Give the finished partial file the target's name, if the target is still what `seen` describes. */
async function commitLocalPart(part, targetPath, seen, { fsp }) {
  try {
    await part.handle.close()
  } catch (err) {
    throw fail(MESSAGES.cannotFinish, err)
  }
  const current = await inspectLocalTarget(targetPath, { fsp }).catch(() => null)
  if (!current || !sameTarget(current, seen)) throw new LocalFileError(MESSAGES.targetChanged)
  try {
    await fsp.rename(part.path, targetPath)
  } catch (err) {
    throw fail(MESSAGES.cannotFinish, err)
  }
}

async function discardLocalPart(part, { fsp }) {
  await quietly(part.handle.close())
  await quietly(fsp.unlink(part.path))
}

module.exports = {
  openLocalSource, isSameLocalFile, isLocalSourceUnchanged, readLocal, inspectLocalTarget, createLocalPart, commitLocalPart, discardLocalPart,
  LocalFileError, MESSAGES
}
