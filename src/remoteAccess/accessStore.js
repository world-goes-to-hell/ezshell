// Who may use remote access: the devices registered with a one-time code, the authenticator secret,
// and the limit on failed attempts. Kept in userData/remote-access.json; device tokens are stored
// only as hashes, and the authenticator secret is sealed by the OS when a sealer is given (a copy
// of the file alone, such as a backup, does not give the secret away). Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const crypto = require('crypto')
const fs = require('fs')
const totp = require('./totp.js')
const webPush = require('./webPush.js')

const PAIRING_MS = 2 * 60 * 1000
const MAX_DEVICES = 5
const MAX_FAILURES = 5
const LOCKOUT_MS = 5 * 60 * 1000
const DEFAULT_PORT = 8722

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')
/**
 * Whether two secrets are the same, in constant time. Their hashes are compared: timingSafeEqual
 * throws on inputs of different byte length, and what a device sends can be any text.
 */
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string'
  && crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest())
const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40) || '휴대폰'

/**
 * @param {object} options
 * @param {string} options.filePath
 * @param {() => number} [options.now]
 * @param {{ seal: (text: string) => string | null, unseal: (sealed: string) => string | null }} [options.sealer]
 *   keeps the authenticator secret unreadable in the file; both may answer null when they cannot
 */
function createAccessStore({ filePath, now = Date.now, randomBytes = crypto.randomBytes, sealer = null }) {
  // answerMcp: MCP questions are also sent to signed-in devices and wait longer for an answer
  // vapid: the key pair notifications are signed with ({ publicKey, privateKeySealed | privateKey })
  let state = { enabled: false, port: DEFAULT_PORT, answerMcp: true, totpSecret: null, vapid: null, devices: [] }
  // The private half, opened (memory only)
  let vapidPrivate = null
  // The secret as it is in the file. Opened on first use: the OS cannot open it before the app is ready.
  let sealedSecret = null
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    if (saved && typeof saved === 'object') {
      state = {
        enabled: saved.enabled === true,
        answerMcp: saved.answerMcp !== false,
        vapid: saved.vapid && typeof saved.vapid.publicKey === 'string' ? saved.vapid : null,
        port: Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535 ? saved.port : DEFAULT_PORT,
        totpSecret: typeof saved.totpSecret === 'string' ? saved.totpSecret : null,
        devices: Array.isArray(saved.devices) ? saved.devices.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string') : []
      }
      if (typeof saved.totpSecretSealed === 'string') sealedSecret = saved.totpSecretSealed
    }
  } catch {
    // No file yet, or unreadable: remote access starts switched off with no devices
  }
  // One-time registration code (memory only): gone after use, a restart or two minutes
  let pairing = null
  // Wrong authenticator codes, per device (memory only): Map<deviceId, { count, lockedUntil }>.
  // Counted per device and only for a known token: a count for everyone would let any device on the
  // tailnet lock the owner out, and without the token nobody gets as far as the code anyway.
  const failures = new Map()

  /** The authenticator secret, or null when there is none (or the OS cannot open it) */
  function secret() {
    if (!state.totpSecret && sealedSecret && sealer) {
      let opened = null
      try {
        opened = sealer.unseal(sealedSecret)
      } catch {
        // Sealed by another Windows account, or the OS store is not available
      }
      if (typeof opened === 'string' && opened) state = { ...state, totpSecret: opened }
    }
    return state.totpSecret
  }

  const save = () => {
    const { totpSecret, ...rest } = state
    if (totpSecret && sealer) {
      try {
        sealedSecret = sealer.seal(totpSecret) || null
      } catch {
        sealedSecret = null
      }
    }
    // A secret that was never opened in this run stays as it was in the file. With a sealer the
    // secret is never written in plain: if it cannot be sealed it is not saved (and is asked for again).
    const kept = sealedSecret ? { totpSecretSealed: sealedSecret } : sealer ? {} : { totpSecret }
    fs.writeFileSync(filePath, JSON.stringify({ ...rest, ...kept }, null, 2), { encoding: 'utf-8', mode: 0o600 })
  }

  /**
   * The key pair notifications are signed with, made on first use. The private half is sealed like
   * the authenticator secret. New keys (first use, or the old ones cannot be opened) end every
   * subscription: a browser subscribes to one public key.
   */
  function vapidKeys() {
    if (state.vapid && !vapidPrivate) {
      if (sealer && typeof state.vapid.privateKeySealed === 'string') {
        try {
          vapidPrivate = sealer.unseal(state.vapid.privateKeySealed) || null
        } catch {
          vapidPrivate = null
        }
      } else if (!sealer && typeof state.vapid.privateKey === 'string') {
        vapidPrivate = state.vapid.privateKey
      }
    }
    if (!state.vapid || !vapidPrivate) {
      const made = webPush.generateVapidKeys()
      let sealed = null
      if (sealer) {
        try {
          sealed = sealer.seal(made.privateKey) || null
        } catch {
          sealed = null
        }
      }
      vapidPrivate = made.privateKey
      const kept = sealer ? (sealed ? { privateKeySealed: sealed } : {}) : { privateKey: made.privateKey }
      state = { ...state, vapid: { publicKey: made.publicKey, ...kept }, devices: state.devices.map(({ push, ...device }) => device) }
      save()
    }
    return { publicKey: state.vapid.publicKey, privateKey: vapidPrivate }
  }

  /** Where to notify a device ({ endpoint, p256dh, auth }), or null to stop notifying it */
  function setPush(deviceId, subscription) {
    state = {
      ...state,
      devices: state.devices.map((device) => {
        if (device.id !== deviceId) return device
        const { push, ...rest } = device
        return subscription ? { ...rest, push: { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth } } : rest
      })
    }
    save()
  }

  const isLockedOut = (deviceId) => now() < (failures.get(deviceId)?.lockedUntil ?? 0)
  function failed(deviceId) {
    const count = (failures.get(deviceId)?.count ?? 0) + 1
    failures.set(deviceId, count >= MAX_FAILURES ? { count: 0, lockedUntil: now() + LOCKOUT_MS } : { count, lockedUntil: 0 })
  }

  function setEnabled(enabled) {
    state = { ...state, enabled: enabled === true }
    // The secret is made when remote access is first switched on
    if (state.enabled && !secret()) state = { ...state, totpSecret: totp.generateSecret() }
    save()
  }

  function setAnswerMcp(isOn) {
    state = { ...state, answerMcp: isOn === true }
    save()
  }

  /** A new one-time code for registering a device; the one before stops working */
  function startPairing() {
    pairing = { code: randomBytes(18).toString('base64url'), expiresAt: now() + PAIRING_MS }
    return { ...pairing }
  }

  /**
   * Registers a device with the one-time code. Returns { deviceId, token } (the token is shown to
   * the device once and never stored) or { error }.
   */
  function redeemPairing(code, name) {
    // No limit of its own: the code is 144 random bits and lives two minutes (the server limits attempts per address)
    const isValid = pairing !== null && now() < pairing.expiresAt && sameSecret(code, pairing.code)
    if (!isValid) return { error: 'bad-code' }
    pairing = null
    if (state.devices.length >= MAX_DEVICES) return { error: 'too-many' }
    const token = randomBytes(32).toString('base64url')
    const device = { id: randomBytes(8).toString('hex'), name: cleanName(name), tokenHash: hashOf(token), createdAt: now(), lastSeenAt: null, lastCounter: -1 }
    state = { ...state, devices: [...state.devices, device] }
    save()
    return { deviceId: device.id, name: device.name, token }
  }

  /**
   * A device signing in: its token and the authenticator's code. Returns { device } or { error }.
   * A code is accepted once per device (the step it belongs to is remembered).
   */
  function signIn(token, code) {
    const hash = hashOf(token)
    const device = state.devices.find((d) => sameSecret(d.tokenHash, hash))
    if (!device) return { error: 'unknown-device' }
    if (isLockedOut(device.id)) return { error: 'locked' }
    const key = secret()
    const counter = key ? totp.verify(key, code, { now: now(), afterCounter: device.lastCounter ?? -1 }) : null
    if (counter === null) {
      failed(device.id)
      return { error: 'bad-code' }
    }
    failures.delete(device.id)
    const updated = { ...device, lastSeenAt: now(), lastCounter: counter }
    state = { ...state, devices: state.devices.map((d) => (d.id === device.id ? updated : d)) }
    save()
    return { device: { id: updated.id, name: updated.name } }
  }

  function revoke(deviceId) {
    state = { ...state, devices: state.devices.filter((d) => d.id !== deviceId) }
    failures.delete(deviceId)
    save()
  }

  return {
    setEnabled,
    setAnswerMcp,
    get answerMcp() { return state.answerMcp },
    startPairing,
    redeemPairing,
    signIn,
    revoke,
    isLockedOut,
    get enabled() { return state.enabled },
    get port() { return state.port },
    get totpSecret() { return secret() },
    vapidKeys,
    setPush,
    /** The devices that asked for notifications, with where to send them */
    pushTargets: () => state.devices.filter((d) => d.push && typeof d.push.endpoint === 'string').map((d) => ({ deviceId: d.id, name: d.name, subscription: d.push })),
    /** Without the token hashes and without where notifications go */
    devices: () => state.devices.map(({ id, name, createdAt, lastSeenAt, push }) => ({ id, name, createdAt, lastSeenAt, hasPush: Boolean(push) })),
    hasDevice: (deviceId) => state.devices.some((d) => d.id === deviceId)
  }
}

module.exports = { createAccessStore, PAIRING_MS, MAX_DEVICES, MAX_FAILURES, LOCKOUT_MS, DEFAULT_PORT }
