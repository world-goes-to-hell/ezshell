// Follows the end of a server log for the file window ("실시간 보기"), like `tail -f` but without a
// command on the server: a stat each time, and when the file grew, a read of the added part only.
// Kind to a production server: nothing is written, the file is opened only to read and closed at once
// (a handle kept open would keep a rotated-away file's disk space in use), and one read is at most 1MB.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const read = require('./remoteRead.js')
const { readRemote } = require('../mcp/remoteTransfer.js')

const MB = 1024 * 1024
const TAIL_READ_MAX_BYTES = 1 * MB
const TAIL_PENDING_MAX_BYTES = 1 * MB
// The start of the file, to tell a new file of the same name (logrotate `create`) from the old one
const HEAD_BYTES = 256
const NO_SUCH_FILE = 2
const NEWLINE = 0x0a
const EMPTY = Buffer.alloc(0)

const MESSAGES = { ...read.MESSAGES }

const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (err, value) => (err ? reject(err) : resolve(value)))
})

/** Where following starts: after the `size` bytes the window already shows. */
function startTail({ requestedPath, path, size }) {
  return { requestedPath, path, offset: size, head: null, pending: EMPTY, missing: false }
}

/** Text of the bytes, without NUL bytes (copytruncate can leave a run of them); invalid UTF-8 shows as replacement characters. */
function decodeLog(bytes) {
  const clean = bytes.includes(0) ? Buffer.from(bytes.filter(byte => byte !== 0)) : bytes
  return new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(clean)
}

/** Complete lines to send now, and the unfinished rest to hold (sent anyway once it is too long). */
function splitLines(chunk, maxPendingBytes) {
  const lastBreak = chunk.lastIndexOf(NEWLINE)
  const complete = lastBreak < 0 ? EMPTY : chunk.subarray(0, lastBreak + 1)
  const rest = chunk.subarray(lastBreak + 1)
  if (rest.length > maxPendingBytes) return { complete: chunk, pending: EMPTY }
  return { complete, pending: Buffer.from(rest) }
}

/** The stats of the followed path; null while it is missing (renamed away and not made again yet). */
async function statOrMissing(sftp, target) {
  try {
    return await call(sftp, 'stat', target)
  } catch (err) {
    if (err && err.code === NO_SUCH_FILE) return null
    throw err
  }
}

/** Whether the file is no longer the one followed so far: shorter, starting differently, another file behind the link, or back after missing. */
function isNewFile(state, realPath, size, headNow) {
  if (state.missing || realPath !== state.path || size < state.offset) return true
  return Boolean(state.head) && !headNow.subarray(0, state.head.length).equals(state.head)
}

async function readAdded(sftp, handle, state, { realPath, size, maxBytes, maxPendingBytes }) {
  const headNow = await readRemote(sftp, handle, 0, Math.min(size, HEAD_BYTES))
  const rotated = isNewFile(state, realPath, size, headNow)
  const from = rotated ? 0 : state.offset
  const beyond = Math.max(0, size - from - maxBytes)
  const data = await read.readRange(sftp, handle, from + beyond, size - from - beyond)
  let chunk
  let skippedBytes = 0
  if (beyond > 0) {
    // The cut falls inside a line: begin after its end (the held piece belongs to skipped text too)
    const firstBreak = data.indexOf(NEWLINE)
    chunk = firstBreak >= 0 ? data.subarray(firstBreak + 1) : data
    skippedBytes = size - from - chunk.length
  } else {
    chunk = rotated ? data : Buffer.concat([state.pending, data])
  }
  const { complete, pending } = splitLines(chunk, maxPendingBytes)
  const text = decodeLog(complete)
  const status = rotated ? 'rotated' : skippedBytes > 0 ? 'skipped' : text ? 'append' : 'same'
  const result = status === 'same' ? { status } : { status, ...(skippedBytes > 0 ? { skippedBytes } : {}), text }
  const next = { ...state, path: realPath, offset: size, head: Buffer.from(headNow), pending, missing: false }
  return { result, state: next }
}

/**
 * One look at the file. `result.status`: 'same' (nothing new), 'append' (lines added), 'skipped'
 * (more than one read: the first `skippedBytes` left out), 'rotated' (a new file, read from its start)
 * or 'missing'. The given state is kept; the next one comes back.
 */
async function pollTail(sftp, state, { maxBytes = TAIL_READ_MAX_BYTES, maxPendingBytes = TAIL_PENDING_MAX_BYTES } = {}) {
  const stats = await statOrMissing(sftp, state.requestedPath)
  if (!stats) return { result: { status: 'missing' }, state: { ...state, missing: true } }
  if (!stats.isFile()) throw new read.RemoteReadError(stats.isDirectory() ? MESSAGES.folder : MESSAGES.special)
  if (stats.size === state.offset && state.head && !state.missing) return { result: { status: 'same' }, state }

  // Something changed: see which file is behind the path now (a link may point elsewhere after rotation)
  const realPath = await call(sftp, 'realpath', state.requestedPath)
  const refused = read.refuseSystemPath(realPath)
  if (refused) throw new read.RemoteReadError(refused)
  try {
    return await read.withHandle(sftp, realPath, (handle) => readAdded(sftp, handle, state, { realPath, size: stats.size, maxBytes, maxPendingBytes }))
  } catch (err) {
    // Cut short while reading: the next look sees the shorter file and starts over
    if (err instanceof read.RemoteReadError && err.userMessage === MESSAGES.changedWhileReading) return { result: { status: 'same' }, state }
    throw err
  }
}

module.exports = { pollTail, startTail, MESSAGES, TAIL_READ_MAX_BYTES }
