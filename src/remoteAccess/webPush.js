// Web Push for remote access: tells a registered phone that an MCP question is waiting, even when
// its browser is closed. The message goes through the browser vendor's push service, encrypted for
// the browser alone (RFC 8291, aes128gcm) and signed with this app's key (VAPID, RFC 8292); the
// service sees that a message was sent, not what it says. Node's crypto only, no package.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const crypto = require('crypto')
const https = require('https')

const RECORD_SIZE = 4096
const VAPID_LIFETIME_S = 12 * 60 * 60
const SEND_TIMEOUT_MS = 10 * 1000
/** A message that was not delivered within this is dropped by the push service (the question is over by then) */
const DEFAULT_TTL_S = 5 * 60
/** Contact in the signed header: required by the standard; it names nobody */
const DEFAULT_SUBJECT = 'mailto:noreply@ezshell.invalid'

// The device chooses the address this PC then posts to, so only the push services of the browser
// vendors are accepted: anything else would let a device make the PC send requests where it likes.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9.-]+\.notify\.windows\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/
]

const base64url = (data) => Buffer.from(data).toString('base64url')
const fromBase64url = (text) => Buffer.from(String(text), 'base64url')

/** Whether `endpoint` is an https address of a known push service */
function isAllowedEndpoint(endpoint) {
  let url
  try {
    url = new URL(String(endpoint))
  } catch {
    return false
  }
  return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443') && PUSH_HOSTS.some((host) => host.test(url.hostname))
}

/** A subscription as the browser gives it (PushSubscription.toJSON()), checked; null when it is not usable */
function readSubscription(value) {
  const endpoint = value && typeof value.endpoint === 'string' ? value.endpoint : ''
  const p256dh = value && value.keys && typeof value.keys.p256dh === 'string' ? value.keys.p256dh : ''
  const auth = value && value.keys && typeof value.keys.auth === 'string' ? value.keys.auth : ''
  if (endpoint.length > 2048 || !isAllowedEndpoint(endpoint)) return null
  // An uncompressed P-256 point and a 16-byte secret
  const point = fromBase64url(p256dh)
  if (point.length !== 65 || point[0] !== 4 || fromBase64url(auth).length !== 16) return null
  return { endpoint, p256dh, auth }
}

/** A new signing key pair: the public half goes to the browser (applicationServerKey), the private half stays here */
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: base64url(ecdh.getPublicKey()), privateKey: base64url(ecdh.getPrivateKey()) }
}

function privateKeyObject({ publicKey, privateKey }) {
  const point = fromBase64url(publicKey)
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: base64url(fromBase64url(privateKey)), x: base64url(point.subarray(1, 33)), y: base64url(point.subarray(33, 65)) }
  })
}

/** The Authorization header that proves the message comes from this app's key, for the service at `endpoint` */
function vapidAuthorization({ endpoint, vapid, subject = DEFAULT_SUBJECT, now = Date.now() }) {
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = base64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_LIFETIME_S, sub: subject }))
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyObject(vapid), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${vapid.publicKey}`
}

/**
 * Encrypts `payload` for one subscription (RFC 8291). `salt` and `ephemeral` are random for every
 * message; they are parameters only so a test can check the result against the standard.
 */
function encrypt(payload, { p256dh, auth }, { salt = crypto.randomBytes(16), ephemeral = null } = {}) {
  const receiverKey = fromBase64url(p256dh)
  const sender = ephemeral || crypto.createECDH('prime256v1')
  if (!ephemeral) sender.generateKeys()
  const senderKey = sender.getPublicKey()
  const shared = sender.computeSecret(receiverKey)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverKey, senderKey])
  const material = Buffer.from(crypto.hkdfSync('sha256', shared, fromBase64url(auth), keyInfo, 32))
  const contentKey = Buffer.from(crypto.hkdfSync('sha256', material, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', material, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  // One record: the text, then the mark of the last record
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])])
  if (plain.length + 16 > RECORD_SIZE - 86) throw new Error('The push message is too long')
  const cipher = crypto.createCipheriv('aes-128-gcm', contentKey, nonce)
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(RECORD_SIZE)
  return Buffer.concat([salt, recordSize, Buffer.from([senderKey.length]), senderKey, sealed])
}

/**
 * Sends one message. Resolves with { ok, status, gone }: `gone` means the browser no longer has
 * this subscription (it should be forgotten). Never rejects.
 */
function send({ subscription, payload, vapid, ttl = DEFAULT_TTL_S, request = https.request, now = Date.now() }) {
  return new Promise((resolve) => {
    if (!isAllowedEndpoint(subscription && subscription.endpoint)) return resolve({ ok: false, status: 0, gone: true })
    let body
    let authorization
    try {
      body = encrypt(Buffer.from(JSON.stringify(payload)), subscription)
      authorization = vapidAuthorization({ endpoint: subscription.endpoint, vapid, now })
    } catch {
      return resolve({ ok: false, status: 0, gone: false })
    }
    const req = request(subscription.endpoint, {
      method: 'POST',
      timeout: SEND_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': body.length,
        TTL: String(ttl),
        Urgency: 'high',
        Authorization: authorization
      }
    }, (res) => {
      res.resume()
      const status = res.statusCode || 0
      resolve({ ok: status >= 200 && status < 300, status, gone: status === 404 || status === 410 })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve({ ok: false, status: 0, gone: false }))
    req.end(body)
  })
}

module.exports = { generateVapidKeys, vapidAuthorization, encrypt, send, readSubscription, isAllowedEndpoint, DEFAULT_TTL_S }
