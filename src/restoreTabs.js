// The tabs that were open at exit or before an update, encrypted with the master password.
// Read once and removed. Records from an update expire in case the update did not finish.

const fs = require('fs')
const cryptoUtil = require('./crypto.js')

const FORMAT = 'ezshell-restore-tabs'
/** A file older than this is from an update that never finished, or long ago: not used */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** The record is a list of tabs; anything larger is not one */
const MAX_TEXT_LENGTH = 256 * 1024

/** Seal a snapshot while the app still has the master password. */
function sealRestoreTabs(record, masterPassword, { now = Date.now(), source = 'update' } = {}) {
  if (!masterPassword) return { success: false, error: '앱 잠금을 해제하세요.' }
  let text
  try {
    text = JSON.stringify(record)
  } catch {
    return { success: false, error: '탭 정보를 저장하지 못했습니다.' }
  }
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return { success: false, error: '탭 정보가 너무 큽니다.' }
  try {
    const file = { format: FORMAT, savedAt: now, source, data: cryptoUtil.encrypt(text, masterPassword) }
    return { success: true, sealed: JSON.stringify(file) }
  } catch {
    return { success: false, error: '탭 정보를 암호화하지 못했습니다.' }
  }
}

function writeRestoreTabs(filePath, sealed, io = fs) {
  try {
    io.writeFileSync(filePath, sealed, { mode: 0o600 })
    return { success: true }
  } catch {
    return { success: false, error: '탭 정보를 저장하지 못했습니다.' }
  }
}

/** The window's record is checked when it is read back. */
function saveRestoreTabs(filePath, record, masterPassword, options = {}) {
  const result = sealRestoreTabs(record, masterPassword, options)
  return result.success ? writeRestoreTabs(filePath, result.sealed, options.io) : result
}

/**
 * The record, once: the file is removed whatever is in it.
 */
function takeRestoreTabs(filePath, masterPassword, now = Date.now(), io = fs) {
  let raw
  try {
    raw = io.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  try { io.unlinkSync(filePath) } catch { /* removed already */ }
  if (!masterPassword || raw.length > MAX_TEXT_LENGTH * 4) return null
  try {
    const file = JSON.parse(raw)
    if (!file || file.format !== FORMAT || typeof file.savedAt !== 'number') return null
    const fromClose = file.source === 'close'
    if ((!fromClose && now - file.savedAt > MAX_AGE_MS) || file.savedAt - now > 60 * 1000) return null
    const record = JSON.parse(cryptoUtil.decrypt(file.data, masterPassword))
    return { savedAt: file.savedAt, record, ...(fromClose ? { source: 'close' } : {}) }
  } catch {
    return null
  }
}

module.exports = { saveRestoreTabs, takeRestoreTabs, sealRestoreTabs, writeRestoreTabs, MAX_AGE_MS }
