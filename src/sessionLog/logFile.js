// File naming and the fixed text of a session log.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const fs = require('fs')
const path = require('path')

const MAX_NAME_LENGTH = 80
const FALLBACK_NAME = 'session'
// Path separators, characters Windows refuses in a file name, and control characters
const UNSAFE_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f]/g
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * A session name as one file name component: it can never contain a path separator or "..",
 * so a log always lands in the log folder.
 */
function safeFileName(name) {
  const cleaned = (typeof name === 'string' ? name : '')
    .replace(UNSAFE_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, MAX_NAME_LENGTH)
    .trim()
  return cleaned === '' || WINDOWS_RESERVED.test(cleaned) ? FALLBACK_NAME : cleaned
}

const pad = (value) => String(value).padStart(2, '0')

/** Local time for a file name: 20261002-090507 */
function formatStamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Local time for reading: 2026-10-02 09:05:07 */
function formatClock(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `attempt` above 1 adds a counter, for a second log of the same name started in the same second. */
function buildLogPath(dir, sessionName, date, attempt = 1) {
  const suffix = attempt > 1 ? `-${attempt}` : ''
  return path.join(dir, `${safeFileName(sessionName)}_${formatStamp(date)}${suffix}.log`)
}

const oneLine = (text) => (typeof text === 'string' ? text : '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim()

function headerText(sessionName, date) {
  return `=== ezShell 세션 로그: ${oneLine(sessionName) || FALLBACK_NAME} | 시작 ${formatClock(date)} ===`
}

function footerText(date) {
  return `=== 종료 ${formatClock(date)} ===`
}

/** A new file opened for writing; fails when it already exists. Writes are synchronous. */
function openLogFile(filePath) {
  const fd = fs.openSync(filePath, 'wx')
  return {
    write: (text) => { fs.writeSync(fd, text) },
    close: () => { fs.closeSync(fd) }
  }
}

module.exports = { safeFileName, buildLogPath, formatStamp, formatClock, headerText, footerText, openLogFile }
