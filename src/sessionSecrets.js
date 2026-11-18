// Which fields of a saved session are secret, and how they are kept in sessions.json: together in one
// blob encrypted with the master password. Everything else (name, host, folder...) stays readable so
// the list can be shown before anything is decrypted.
//
// Before 2026-11-18 only password, passphrase and privateKeyPath went into the blob; the root switch
// password, the jump host's secrets and the saved database accounts (with their passwords) were
// written in plain text. Such a file still opens, and `needsResealing` tells that it should be
// written again (main does that right after unlocking).

const cryptoUtil = require('./crypto.js')

const SECRET_FIELDS = [
  'password', 'passphrase', 'privateKeyPath',
  'suPassword',
  'jumpPassword', 'jumpPassphrase', 'jumpPrivateKeyPath',
  // Database accounts as a whole: host, user and password of each
  'dbConnections'
]

// Written by older versions or the app itself, never kept in the file
const TRANSIENT_FIELDS = ['needsMigration', 'decryptionFailed']

const isPresent = (value) => value !== undefined && value !== null && value !== ''

/** The session as it is written to the file: secrets only inside `encrypted` */
function sealSession(session, masterPassword) {
  const secrets = {}
  const rest = {}
  for (const [key, value] of Object.entries(session)) {
    if (SECRET_FIELDS.includes(key)) {
      if (isPresent(value)) secrets[key] = value
    } else if (!TRANSIENT_FIELDS.includes(key) && key !== 'encrypted' && key !== 'encryptedVersion') {
      rest[key] = value
    }
  }
  return { ...rest, encrypted: cryptoUtil.encrypt(JSON.stringify(secrets), masterPassword), encryptedVersion: 1 }
}

/**
 * The session as the app uses it. A session never encrypted is marked `needsMigration`; one that
 * cannot be decrypted is marked `decryptionFailed` and given as it is (its secrets stay unknown).
 */
function openSession(stored, masterPassword) {
  if (!stored.encrypted && !stored.encryptedVersion) return { ...stored, needsMigration: true }
  try {
    const secrets = JSON.parse(cryptoUtil.decrypt(stored.encrypted, masterPassword))
    const { encrypted: _encrypted, encryptedVersion: _version, ...rest } = stored
    const opened = { ...rest }
    // Older blobs hold `null` for an empty secret; a secret still in plain text next to the blob
    // (written before it moved into it) is kept unless the blob has a value
    for (const [key, value] of Object.entries(secrets)) {
      if (isPresent(value) || !isPresent(opened[key])) opened[key] = value
    }
    return opened
  } catch {
    return { ...stored, decryptionFailed: true }
  }
}

/** Whether a stored session holds a secret outside its encrypted blob */
function needsResealing(stored) {
  if (!stored || typeof stored !== 'object') return false
  if (!stored.encrypted && !stored.encryptedVersion) return true
  return SECRET_FIELDS.some(key => {
    const value = stored[key]
    return Array.isArray(value) ? value.length > 0 : isPresent(value)
  })
}

/**
 * The file's sessions written again with every secret in the blob. A session that does not open with
 * this password is left exactly as it was. Null when nothing needs writing.
 */
function resealAll(storedSessions, masterPassword) {
  if (!Array.isArray(storedSessions) || !storedSessions.some(needsResealing)) return null
  return storedSessions.map((stored) => {
    if (!needsResealing(stored)) return stored
    const opened = openSession(stored, masterPassword)
    return opened.decryptionFailed ? stored : sealSession(opened, masterPassword)
  })
}

module.exports = { SECRET_FIELDS, sealSession, openSession, needsResealing, resealAll }
