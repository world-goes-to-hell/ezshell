// Saved SSH host keys (userData/known-hosts.json), one per host and port.
// Server addresses are stored as HMAC-SHA256 with a per-file salt, like OpenSSH's HashKnownHosts:
// sessions.json is encrypted, so this file must not list the servers in plain text.
const nodeFs = require('fs')
const crypto = require('crypto')

const FILE_VERSION = 1
const DEFAULT_SSH_PORT = 22
const MAX_KEY_TYPE_LENGTH = 64
const KEY_TYPE_PATTERN = /^[\x21-\x7e]+$/

/** Key type from the SSH wire format blob (string type, then key data), and its OpenSSH SHA256 fingerprint */
function describeHostKey(key) {
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  let keyType = 'unknown'
  if (key.length >= 4) {
    const length = key.readUInt32BE(0)
    const type = length > 0 && length <= MAX_KEY_TYPE_LENGTH && length <= key.length - 4
      ? key.subarray(4, 4 + length).toString('latin1')
      : ''
    if (KEY_TYPE_PATTERN.test(type)) keyType = type
  }
  return { keyType, fingerprint }
}

const isEntry = (entry) => Boolean(entry) && typeof entry === 'object'
  && typeof entry.keyType === 'string' && typeof entry.fingerprint === 'string'

/** Parsed file contents, or null when the file is not ours to trust */
function parseFile(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || typeof data.salt !== 'string' || !data.salt
    || !data.hosts || typeof data.hosts !== 'object') {
    return null
  }
  const hosts = Object.fromEntries(Object.entries(data.hosts).filter(([, entry]) => isEntry(entry)))
  return { salt: data.salt, hosts }
}

function createHostKeyStore({ filePath, fs = nodeFs, now = () => new Date() }) {
  let state = null

  function setAsideCorruptFile() {
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    try {
      fs.renameSync(filePath, `${filePath}.corrupt-${stamp}`)
    } catch (err) {
      console.error('Failed to move the corrupt host key file aside:', err.message)
    }
  }

  /**
   * The saved keys, or null when the file exists but cannot be read right now (locked by another program,
   * for example). That case is not cached and nothing is saved over the file: starting empty would replace
   * every saved key, and a later key change would then look like a new server instead of a changed key.
   */
  function load() {
    if (state) return state
    let text = null
    try {
      text = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Failed to read the host key file:', err.message)
        return null
      }
    }
    const parsed = text === null ? null : parseFile(text)
    if (text !== null && !parsed) setAsideCorruptFile()
    state = parsed || { salt: crypto.randomBytes(32).toString('base64'), hosts: {} }
    return state
  }

  /** Write to a temporary file, flush it to disk, then rename over the old file */
  function save(next) {
    const body = JSON.stringify({ version: FILE_VERSION, salt: next.salt, hosts: next.hosts }, null, 2)
    const tempPath = `${filePath}.tmp-${process.pid}`
    try {
      const fd = fs.openSync(tempPath, 'w', 0o600)
      try {
        fs.writeSync(fd, body)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tempPath, filePath)
    } catch (err) {
      try { fs.unlinkSync(tempPath) } catch { /* never created */ }
      throw err
    }
  }

  const hostId = (salt, host, port) => crypto
    .createHmac('sha256', Buffer.from(salt, 'base64'))
    .update(`${String(host).trim().toLowerCase()}:${Number(port) || DEFAULT_SSH_PORT}`)
    .digest('hex')

  /** 'trusted' when the key matches the saved one, 'unknown' for a new server, 'changed' otherwise */
  function check(host, port, key) {
    const current = load()
    const described = describeHostKey(key)
    // Unreadable file: the key cannot be confirmed, and trust() refuses to save, so the connection fails
    if (!current) return { status: 'unknown', ...described }
    const saved = current.hosts[hostId(current.salt, host, port)]
    if (!saved) return { status: 'unknown', ...described }
    if (saved.keyType === described.keyType && saved.fingerprint === described.fingerprint) {
      return { status: 'trusted', ...described }
    }
    return { status: 'changed', ...described, previous: { keyType: saved.keyType, fingerprint: saved.fingerprint } }
  }

  /** Save (or replace) the key for this host and port */
  function trust(host, port, key) {
    const current = load()
    if (!current) throw new Error('The host key file could not be read; not saving over it')
    const described = describeHostKey(key)
    const next = {
      salt: current.salt,
      hosts: { ...current.hosts, [hostId(current.salt, host, port)]: { ...described, addedAt: now().toISOString() } }
    }
    save(next)
    state = next
  }

  return { check, trust }
}

module.exports = { createHostKeyStore, describeHostKey }
