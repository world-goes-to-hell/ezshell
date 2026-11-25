// The last recorded tabs, encrypted with the master password.
// Read once and removed. Records from an update expire in case the update did not finish.

const fs = require('fs')
const { randomUUID } = require('node:crypto')
const cryptoUtil = require('./crypto.js')

const FORMAT = 'ezshell-restore-tabs'
/** A file older than this is from an update that never finished, or long ago: not used */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** The record is a list of tabs; anything larger is not one */
const MAX_TEXT_LENGTH = 256 * 1024

function serializeRestoreTabs(record) {
  let text
  try {
    text = JSON.stringify(record)
  } catch {
    return { success: false, error: '탭 정보를 저장하지 못했습니다.' }
  }
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return { success: false, error: '탭 정보가 너무 큽니다.' }
  return { success: true, text }
}

function sealResult(data, { now = Date.now(), source = 'update' } = {}) {
  return { success: true, sealed: JSON.stringify({ format: FORMAT, savedAt: now, source, data }) }
}

/** Seal the already validated text on a lock or an exit signal. */
function sealRestoreTabsText(text, masterPassword, options) {
  if (!masterPassword) return { success: false, error: '앱 잠금을 해제하세요.' }
  try {
    return sealResult(cryptoUtil.encrypt(text, masterPassword), options)
  } catch {
    return { success: false, error: '탭 정보를 암호화하지 못했습니다.' }
  }
}

/** Keep the PBKDF2 work off the main thread during ordinary use. */
async function sealRestoreTabsTextAsync(text, masterPassword, options) {
  if (!masterPassword) return { success: false, error: '앱 잠금을 해제하세요.' }
  try {
    return sealResult(await cryptoUtil.encryptAsync(text, masterPassword), options)
  } catch {
    return { success: false, error: '탭 정보를 암호화하지 못했습니다.' }
  }
}

function sealRestoreTabs(record, masterPassword, options) {
  if (!masterPassword) return { success: false, error: '앱 잠금을 해제하세요.' }
  const result = serializeRestoreTabs(record)
  return result.success ? sealRestoreTabsText(result.text, masterPassword, options) : result
}

function writeRestoreTabs(filePath, sealed, io = fs) {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    io.writeFileSync(temporary, sealed, { mode: 0o600, flush: true })
    io.renameSync(temporary, filePath)
    return { success: true }
  } catch {
    try { io.unlinkSync(temporary) } catch { /* file was not created */ }
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

module.exports = { saveRestoreTabs, takeRestoreTabs, sealRestoreTabs, serializeRestoreTabs, sealRestoreTabsText, sealRestoreTabsTextAsync, writeRestoreTabs, MAX_AGE_MS }
