// What an update hands to the next app for the agents that outlive it in the session host
// (docs/plan/2026-11-26-sessions-survive-update.md, agentMessages.js exportHandoff / importHandoff).
//
// Two files in userData:
// - the endpoint (pipe name and file folder), in the clear: the next app listens on the same pipe before the
//   unlock, since the agents' CLIs keep the old name in their environment. It is no credential by itself.
// - the record (registrations, inboxes, credential digests), sealed with the master password like the
//   restore-tabs record: messages can hold secrets. It is opened once after the unlock and removed.

const fs = require('fs')
const { randomUUID } = require('node:crypto')
const cryptoUtil = require('../crypto.js')

const FORMAT = 'ezshell-agent-handoff-file'
/** A password typed late after an update still finds the agents (same span as the restore-tabs record) */
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 500 messages of 8,000 characters and the registrations fit well under this */
const MAX_TEXT_LENGTH = 8 * 1024 * 1024

function writeAtomic(file, text, io) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    io.writeFileSync(temporary, text, { mode: 0o600, flush: true })
    io.renameSync(temporary, file)
    return true
  } catch {
    try { io.unlinkSync(temporary) } catch { /* not created */ }
    return false
  }
}

function removeHandoff({ file, endpointFile, io = fs }) {
  for (const path of [file, endpointFile]) {
    try { io.unlinkSync(path) } catch { /* already gone */ }
  }
}

/** On quitting to install an update, after the shells went to the session host. False: nothing kept. */
function saveAgentHandoff({ file, endpointFile, record, masterPassword, now = Date.now(), io = fs }) {
  removeHandoff({ file, endpointFile, io })
  if (!record?.endpoint || !masterPassword) return false
  let text
  try { text = JSON.stringify(record) } catch { return false }
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return false
  let data
  try { data = cryptoUtil.encrypt(text, masterPassword) } catch { return false }
  const sealed = JSON.stringify({ format: FORMAT, savedAt: now, data })
  const endpoint = JSON.stringify({ format: FORMAT, savedAt: now, pipe: record.endpoint.pipe, directory: record.endpoint.directory })
  // The record first: an endpoint without its record would only hold requests back until the unlock
  if (!writeAtomic(file, sealed, io) || !writeAtomic(endpointFile, endpoint, io)) {
    removeHandoff({ file, endpointFile, io })
    return false
  }
  return true
}

/** At start, before the unlock: the pipe and folder to listen on again, or null (agentMessages checks them) */
function readHandoffEndpoint({ file, endpointFile, now = Date.now(), io = fs }) {
  try {
    const value = JSON.parse(io.readFileSync(endpointFile, 'utf8'))
    if (value?.format !== FORMAT || !Number.isFinite(value.savedAt) || now - value.savedAt > MAX_AGE_MS || value.savedAt > now + 60_000 ||
        typeof value.pipe !== 'string' || typeof value.directory !== 'string' || !io.existsSync(file)) throw new Error('stale')
    return { pipe: value.pipe, directory: value.directory }
  } catch {
    removeHandoff({ file, endpointFile, io })
    return null
  }
}

/** After the unlock, once: the record, or null. Both files are removed whatever they hold. */
function takeAgentHandoff({ file, endpointFile, masterPassword, now = Date.now(), io = fs }) {
  let raw
  try { raw = io.readFileSync(file, 'utf8') } catch { raw = null }
  removeHandoff({ file, endpointFile, io })
  if (!raw || !masterPassword || raw.length > MAX_TEXT_LENGTH * 2) return null
  try {
    const sealed = JSON.parse(raw)
    if (sealed?.format !== FORMAT || !Number.isFinite(sealed.savedAt) || now - sealed.savedAt > MAX_AGE_MS || sealed.savedAt > now + 60_000) return null
    return JSON.parse(cryptoUtil.decrypt(sealed.data, masterPassword))
  } catch {
    return null
  }
}

module.exports = { saveAgentHandoff, readHandoffEndpoint, takeAgentHandoff, removeHandoff, MAX_AGE_MS }
