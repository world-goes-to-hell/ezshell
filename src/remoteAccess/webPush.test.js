import { describe, it, expect, vi } from 'vitest'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import ece from 'http_ece'
import webPush from './webPush.js'

const { generateVapidKeys, vapidAuthorization, encrypt, send, readSubscription, isAllowedEndpoint } = webPush

/** A browser's side of a subscription: its key pair and secret */
function browser(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const keys = crypto.createECDH('prime256v1')
  keys.generateKeys()
  const auth = crypto.randomBytes(16)
  return { keys, auth, subscription: { endpoint, keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } }
}

describe('encrypt (RFC 8291)', () => {
  it('produces a message the reference implementation of the standard decrypts', () => {
    const { keys, auth, subscription } = browser()
    const body = encrypt(Buffer.from('{"title":"ezShell","body":"확인 요청"}'), readSubscription(subscription))
    const plain = ece.decrypt(body, { version: 'aes128gcm', privateKey: keys, authSecret: auth.toString('base64url') })
    expect(plain.toString()).toBe('{"title":"ezShell","body":"확인 요청"}')
  })

  it('matches the example of the standard byte for byte', () => {
    // RFC 8291, section 5 / appendix A
    const receiverPublic = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
    const authSecret = 'BTBZMqHH6r4Tts7J_aSIgg'
    const sender = crypto.createECDH('prime256v1')
    sender.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'))
    const body = encrypt(Buffer.from('When I grow up, I want to be a watermelon'), { p256dh: receiverPublic, auth: authSecret }, {
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      ephemeral: sender
    })
    expect(body.toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN')
  })

  it('uses a new key and salt for every message', () => {
    const { subscription } = browser()
    const ready = readSubscription(subscription)
    expect(encrypt(Buffer.from('same'), ready).equals(encrypt(Buffer.from('same'), ready))).toBe(false)
  })

  it('refuses a message that does not fit one record', () => {
    const { subscription } = browser()
    expect(() => encrypt(Buffer.alloc(5000), readSubscription(subscription))).toThrow()
  })
})

describe('vapidAuthorization (RFC 8292)', () => {
  it('signs who the message is for and until when, verifiable with the public key', () => {
    const vapid = generateVapidKeys()
    const now = 1_800_000_000_000
    const header = vapidAuthorization({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', vapid, now })
    const [, token, key] = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header)
    expect(key).toBe(vapid.publicKey)
    const [head, claims, signature] = token.split('.')
    expect(JSON.parse(Buffer.from(head, 'base64url'))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(Buffer.from(claims, 'base64url'))).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:noreply@ezshell.invalid' })
    const point = Buffer.from(vapid.publicKey, 'base64url')
    expect(point).toHaveLength(65)
    const publicKey = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } })
    expect(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true)
  })
})

describe('which addresses a device may register', () => {
  it('takes the push services of the browser vendors over https', () => {
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://web.push.apple.com/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x'
    ]) expect(isAllowedEndpoint(url), url).toBe(true)
  })

  it('takes nothing else: the PC would be sending requests wherever a device says', () => {
    for (const url of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evil.example/fcm.googleapis.com',
      'https://user@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://127.0.0.1/x',
      'https://192.168.0.1/admin',
      'https://localhost/x',
      'file:///etc/passwd',
      '',
      null
    ]) expect(isAllowedEndpoint(url), String(url)).toBe(false)
  })

  it('checks the shape of a subscription', () => {
    const { subscription } = browser()
    expect(readSubscription(subscription)).toEqual({ endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth })
    expect(readSubscription({ ...subscription, endpoint: 'https://evil.example/x' })).toBeNull()
    expect(readSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: 'AAAA' } })).toBeNull()
    expect(readSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'AAAA' } })).toBeNull()
    expect(readSubscription({ endpoint: subscription.endpoint })).toBeNull()
    expect(readSubscription(null)).toBeNull()
  })
})

describe('send', () => {
  /** An https.request stand-in that answers with `status` */
  function fakeRequest(status) {
    const calls = []
    const request = vi.fn((url, options, onResponse) => {
      const req = new EventEmitter()
      req.destroy = vi.fn()
      req.end = (body) => {
        calls.push({ url, options, body })
        if (status === 'error') return queueMicrotask(() => req.emit('error', new Error('offline')))
        const res = new EventEmitter()
        res.statusCode = status
        res.resume = () => {}
        queueMicrotask(() => onResponse(res))
      }
      return req
    })
    return { request, calls }
  }

  it('posts the encrypted message with the headers the service needs', async () => {
    const { keys, auth, subscription } = browser()
    const { request, calls } = fakeRequest(201)
    const result = await send({ subscription: readSubscription(subscription), payload: { title: 'ezShell', body: 'MCP 확인 요청' }, vapid: generateVapidKeys(), request })
    expect(result).toEqual({ ok: true, status: 201, gone: false })
    expect(calls[0].url).toBe(subscription.endpoint)
    expect(calls[0].options.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '300', Urgency: 'high', Authorization: expect.stringMatching(/^vapid t=/) })
    const plain = ece.decrypt(calls[0].body, { version: 'aes128gcm', privateKey: keys, authSecret: auth.toString('base64url') })
    expect(JSON.parse(plain.toString())).toEqual({ title: 'ezShell', body: 'MCP 확인 요청' })
  })

  it('says when the browser no longer has the subscription, and never rejects', async () => {
    const { subscription } = browser()
    const ready = readSubscription(subscription)
    const vapid = generateVapidKeys()
    expect(await send({ subscription: ready, payload: {}, vapid, request: fakeRequest(410).request })).toEqual({ ok: false, status: 410, gone: true })
    expect(await send({ subscription: ready, payload: {}, vapid, request: fakeRequest(500).request })).toEqual({ ok: false, status: 500, gone: false })
    expect(await send({ subscription: ready, payload: {}, vapid, request: fakeRequest('error').request })).toEqual({ ok: false, status: 0, gone: false })
  })

  it('sends nothing to an address that is not a push service', async () => {
    const { subscription } = browser()
    const { request } = fakeRequest(201)
    const result = await send({ subscription: { ...readSubscription(subscription), endpoint: 'https://192.168.0.1/admin' }, payload: {}, vapid: generateVapidKeys(), request })
    expect(result.ok).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
})
