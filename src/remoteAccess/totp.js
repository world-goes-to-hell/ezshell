// Time-based one-time codes (RFC 6238, the 6 digits of an authenticator app) for remote access.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const crypto = require('crypto')

const STEP_SECONDS = 30
const DIGITS = 6
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function toBase32(buffer) {
  let bits = ''
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0')
  let out = ''
  for (let i = 0; i < bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  return out
}

function fromBase32(text) {
  let bits = ''
  for (const ch of String(text).toUpperCase().replace(/[=\s]/g, '')) {
    const value = BASE32.indexOf(ch)
    if (value < 0) throw new Error('bad base32')
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** A new secret (160 bits), as the base32 text authenticator apps take */
const generateSecret = () => toBase32(crypto.randomBytes(20))

const counterAt = (timeMs) => Math.floor(timeMs / 1000 / STEP_SECONDS)

function codeFor(secret, counter) {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = crypto.createHmac('sha1', fromBase32(secret)).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS
  return String(number).padStart(DIGITS, '0')
}

/**
 * The counter a code belongs to, or null when it is wrong. One step before and after is accepted
 * (clocks differ a little). `afterCounter`: codes of that step and earlier are refused, so a code
 * that was seen once cannot be used again.
 */
function verify(secret, code, { now = Date.now(), afterCounter = -1 } = {}) {
  const text = String(code ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(text)) return null
  const current = counterAt(now)
  for (const counter of [current, current - 1, current + 1]) {
    if (counter <= afterCounter) continue
    const expected = Buffer.from(codeFor(secret, counter))
    if (crypto.timingSafeEqual(expected, Buffer.from(text))) return counter
  }
  return null
}

/** What an authenticator app reads from the QR code */
function otpauthUrl(secret, { account = 'ezShell', issuer = 'ezShell' } = {}) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
}

module.exports = { generateSecret, codeFor, counterAt, verify, otpauthUrl, toBase32, fromBase32 }
