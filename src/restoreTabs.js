// The tabs that were open when an update was installed, kept until the app starts again so they can be
// opened again (docs/plan/2026-11-18-restore-tabs-after-update.md). Encrypted with the master
// password like the session file: it names saved sessions, folders on servers and quick-connect
// logins (no passwords). Read once and removed; an old file is not used.

const fs = require('fs')
const cryptoUtil = require('./crypto.js')

const FORMAT = 'ezshell-restore-tabs'
/** A file older than this is from an update that never finished, or long ago: not used */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** The record is a list of tabs; anything larger is not one */
const MAX_TEXT_LENGTH = 256 * 1024

/**
 * Writes the record. `record` is what the window sent: it is checked when it is read back.
 * @returns {{ success: boolean, error?: string }}
 */
function saveRestoreTabs(filePath, record, masterPassword, now = Date.now(), io = fs) {
  if (!masterPassword) return { success: false, error: '앱 잠금을 해제하세요.' }
  let text
  try {
    text = JSON.stringify(record)
  } catch {
    return { success: false, error: '탭 정보를 저장하지 못했습니다.' }
  }
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return { success: false, error: '탭 정보가 너무 큽니다.' }
  const file = { format: FORMAT, savedAt: now, data: cryptoUtil.encrypt(text, masterPassword) }
  try {
    io.writeFileSync(filePath, JSON.stringify(file), { mode: 0o600 })
    return { success: true }
  } catch {
    return { success: false, error: '탭 정보를 저장하지 못했습니다.' }
  }
}

/**
 * The record, once: the file is removed whatever is in it. Null when there is none, it is too old,
 * or it cannot be read with this password.
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
    if (now - file.savedAt > MAX_AGE_MS || file.savedAt - now > 60 * 1000) return null
    return { savedAt: file.savedAt, record: JSON.parse(cryptoUtil.decrypt(file.data, masterPassword)) }
  } catch {
    return null
  }
}

module.exports = { saveRestoreTabs, takeRestoreTabs, MAX_AGE_MS }
