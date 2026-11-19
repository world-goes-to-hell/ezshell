// Reading and writing a file on this PC for the file window, with the same rules as a server file
// (src/remoteFiles/remoteRead.js): up to 5MB of UTF-8 to edit, a text preview of the whole file up to
// 5MB (else the last 1MB), images and PDFs up to 50MB. A save only overwrites the file when it is still
// exactly what the window was shown, through one handle (compare, then write in place).
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const fs = require('fs')

const MB = 1024 * 1024
const EDIT_MAX_BYTES = 5 * MB
const MEDIA_MAX_BYTES = 50 * MB
const TEXT_WHOLE_MAX_BYTES = 5 * MB
const TEXT_TAIL_BYTES = 1 * MB

const MESSAGES = {
  notFile: '일반 파일이 아닙니다.',
  notText: '텍스트(UTF-8) 파일이 아닙니다.',
  editTooLarge: `편집할 수 있는 파일은 ${EDIT_MAX_BYTES / MB}MB 까지입니다.`,
  mediaTooLarge: `미리보기할 수 있는 파일은 ${MEDIA_MAX_BYTES / MB}MB 까지입니다.`,
  unreadable: '파일을 읽지 못했습니다.',
  changed: '연 뒤에 파일이 바뀌어 저장하지 않았습니다.'
}

class LocalFileError extends Error {
  constructor(userMessage) {
    super(userMessage)
    this.userMessage = userMessage
  }
}

async function statFile(target) {
  let stats
  try {
    stats = await fs.promises.stat(target)
  } catch {
    throw new LocalFileError(MESSAGES.unreadable)
  }
  if (!stats.isFile()) throw new LocalFileError(MESSAGES.notFile)
  return stats
}

async function readRange(target, start, length) {
  const handle = await fs.promises.open(target, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** Strict UTF-8 (a NUL byte means binary); null when it is not text */
function decodeStrict(data) {
  if (data.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
  } catch {
    return null
  }
}
const decodeLoosely = (data) => (data.includes(0) ? null : new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(data))

async function canWrite(target) {
  try {
    const handle = await fs.promises.open(target, 'r+')
    await handle.close()
    return true
  } catch {
    return false
  }
}

/** `seen` is what a save compares the file with; `canWrite` false opens the window read-only */
async function readForEdit(target, { maxBytes = EDIT_MAX_BYTES } = {}) {
  const stats = await statFile(target)
  if (stats.size > maxBytes) throw new LocalFileError(MESSAGES.editTooLarge)
  const content = decodeStrict(await readRange(target, 0, stats.size))
  if (content === null) throw new LocalFileError(MESSAGES.notText)
  return { seen: { path: target, content, exists: true }, canWrite: await canWrite(target) }
}

async function readTextPreview(target) {
  const stats = await statFile(target)
  const truncated = stats.size > TEXT_WHOLE_MAX_BYTES
  const start = truncated ? stats.size - TEXT_TAIL_BYTES : 0
  let data = await readRange(target, start, stats.size - start)
  if (truncated) {
    const firstBreak = data.indexOf(0x0a)
    if (firstBreak >= 0) data = data.subarray(firstBreak + 1)
  }
  const text = decodeLoosely(data)
  if (text === null) throw new LocalFileError(MESSAGES.notText)
  return { path: target, size: stats.size, text, truncated }
}

async function readMedia(target) {
  const stats = await statFile(target)
  if (stats.size > MEDIA_MAX_BYTES) throw new LocalFileError(MESSAGES.mediaTooLarge)
  return { path: target, size: stats.size, data: await readRange(target, 0, stats.size) }
}

/**
 * Overwrite `seen.path` with `content` when it still holds exactly `seen.content`: one handle opened
 * for reading and writing, compared, then truncated and written. The file keeps its identity (links,
 * permissions). Returns { ok: false, conflict: true } when it changed.
 */
async function writeIfUnchanged(seen, content, { maxBytes = EDIT_MAX_BYTES } = {}) {
  const handle = await fs.promises.open(seen.path, 'r+')
  try {
    const { size } = await handle.stat()
    const expected = Buffer.from(seen.content, 'utf8')
    if (size !== expected.length) return { ok: false, conflict: true }
    const current = Buffer.alloc(Math.min(size, maxBytes + 1))
    const { bytesRead } = await handle.read(current, 0, current.length, 0)
    if (!current.subarray(0, bytesRead).equals(expected)) return { ok: false, conflict: true }
    const next = Buffer.from(content, 'utf8')
    await handle.truncate(0)
    await handle.write(next, 0, next.length, 0)
    await handle.sync().catch(() => {})
    return { ok: true }
  } finally {
    await handle.close()
  }
}

module.exports = { readForEdit, readTextPreview, readMedia, writeIfUnchanged, LocalFileError, MESSAGES, EDIT_MAX_BYTES }
