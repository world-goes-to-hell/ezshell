const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { validateRole } = require('./agentRole.js')
const { sessionIdOf } = require('./agentUsage.js')

const MAX_ENTRIES = 500
const MAX_BYTES = 256 * 1024
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PROVIDERS = new Set(['claude', 'codex', 'antigravity'])

function roleSessionKey(kind, sessionId, claudeProfileId) {
  const id = sessionIdOf(sessionId)
  if (!id || !PROVIDERS.has(kind)) return null
  if (claudeProfileId === undefined) return `${kind}:${id}`
  const profile = sessionIdOf(claudeProfileId)
  return kind === 'claude' && profile ? `claude:${profile}:${id}` : null
}

function readRole(value, source) {
  try { return validateRole(value, source) } catch { return '' }
}

const record = (user, agent, usedAt) => ({ ...(user ? { user } : {}), ...(agent ? { agent } : {}), usedAt })

function recentEntries(entries, now) {
  return new Map([...entries].filter(([, entry]) => entry.usedAt > now - RETENTION_MS)
    .sort(([, a], [, b]) => b.usedAt - a.usedAt).slice(0, MAX_ENTRIES))
}

function readEntries(file, now) {
  const empty = { entries: new Map(), needsCleanup: false }
  let stat
  try { stat = fs.lstatSync(file) } catch (error) {
    if (error.code === 'ENOENT') return empty
    throw error
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return empty
  const contents = fs.readFileSync(file, 'utf8')
  let data
  try { data = JSON.parse(contents) } catch { return empty }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return empty
  const saved = Object.entries(data)
  const entries = new Map()
  let needsCleanup = false
  for (const [key, entry] of saved) {
    const [kind, first, second] = key.split(':', 3)
    if (roleSessionKey(kind, second ?? first, second === undefined ? undefined : first) !== key ||
        !Number.isSafeInteger(entry?.usedAt)) continue
    const user = readRole(entry.user, 'user')
    const agent = readRole(entry.agent, 'agent')
    if (!user && !agent) continue
    const clean = record(user, agent, Math.min(entry.usedAt, now))
    entries.set(key, clean)
    if (Object.keys(entry).length !== Object.keys(clean).length ||
        entry.user !== clean.user || entry.agent !== clean.agent || entry.usedAt !== clean.usedAt) needsCleanup = true
  }
  const recent = recentEntries(entries, now)
  return { entries: recent, needsCleanup: needsCleanup || recent.size !== saved.length }
}

function writeEntries(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(entries)) + '\n', { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function createAgentRoleStore(file, now = Date.now) {
  let entries = new Map()
  if (file) {
    try {
      const saved = readEntries(file, now())
      entries = saved.entries
      if (saved.needsCleanup) writeEntries(file, entries)
    } catch { /* Continue with any roles that could be read. */ }
  }

  return {
    get: key => entries.get(key),
    update(key, patch = {}, inherit) {
      const usedAt = now()
      const saved = file ? readEntries(file, usedAt) : { entries }
      const next = new Map(saved.entries)
      entries = saved.entries
      const previous = next.get(key)
      const roles = previous ?? inherit
      const user = patch.user ?? roles?.user ?? ''
      const agent = patch.agent ?? roles?.agent ?? ''
      next.delete(key)
      const updated = user || agent ? [[key, record(user, agent, usedAt)], ...next] : next
      const recent = recentEntries(updated, usedAt)
      if (file && (saved.needsCleanup || previous || user || agent)) writeEntries(file, recent)
      entries = recent
    }
  }
}

module.exports = { createAgentRoleStore, roleSessionKey }
