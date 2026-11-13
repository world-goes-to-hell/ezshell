import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createAccessStore, PAIRING_MS, LOCKOUT_MS, MAX_DEVICES } from './accessStore.js'
import totp from './totp.js'
import { isTailnetAddress, findTailnetAddress } from './tailnet.js'

describe('totp', () => {
  // RFC 6238 test secret "12345678901234567890" (SHA-1), 8-digit vectors cut to the last 6 digits
  const secret = totp.toBase32(Buffer.from('12345678901234567890'))

  it('gives the codes of the standard', () => {
    expect(totp.codeFor(secret, totp.counterAt(59 * 1000))).toBe('287082')
    expect(totp.codeFor(secret, totp.counterAt(1111111109 * 1000))).toBe('081804')
    expect(totp.codeFor(secret, totp.counterAt(1234567890 * 1000))).toBe('005924')
  })

  it('accepts the current code and its neighbours, and nothing else', () => {
    const now = 1234567890 * 1000
    const counter = totp.counterAt(now)
    expect(totp.verify(secret, '005924', { now })).toBe(counter)
    expect(totp.verify(secret, totp.codeFor(secret, counter - 1), { now })).toBe(counter - 1)
    expect(totp.verify(secret, totp.codeFor(secret, counter - 2), { now })).toBeNull()
    expect(totp.verify(secret, '000000', { now })).toBeNull()
    expect(totp.verify(secret, 'abcdef', { now })).toBeNull()
    expect(totp.verify(secret, '00592', { now })).toBeNull()
  })

  it('refuses a code of a step that was already used', () => {
    const now = 1234567890 * 1000
    const counter = totp.counterAt(now)
    expect(totp.verify(secret, '005924', { now, afterCounter: counter })).toBeNull()
    expect(totp.verify(secret, '005924', { now, afterCounter: counter - 1 })).toBe(counter)
  })

  it('round-trips base32 and writes the authenticator link', () => {
    const made = totp.generateSecret()
    expect(made).toMatch(/^[A-Z2-7]{32}$/)
    expect(totp.toBase32(totp.fromBase32(made))).toBe(made)
    expect(totp.otpauthUrl(made)).toBe(`otpauth://totp/ezShell:ezShell?secret=${made}&issuer=ezShell&algorithm=SHA1&digits=6&period=30`)
  })
})

describe('tailnet', () => {
  it('knows Tailscale addresses', () => {
    for (const address of ['100.64.0.1', '100.121.5.9', '100.127.255.254', '::ffff:100.101.102.103', 'fd7a:115c:a1e0::1']) expect(isTailnetAddress(address), address).toBe(true)
    for (const address of ['100.63.0.1', '100.128.0.1', '192.168.0.5', '127.0.0.1', '10.0.0.1', '::1', '', null, '100.64.0.999', '8.8.8.8']) expect(isTailnetAddress(address), String(address)).toBe(false)
  })

  it('finds this PC\'s Tailscale address', () => {
    expect(findTailnetAddress({ Ethernet: [{ address: '192.168.0.5', family: 'IPv4', internal: false }], Tailscale: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '100.121.5.9', family: 'IPv4', internal: false }] }, 'win32')).toBe('100.121.5.9')
    expect(findTailnetAddress({ Ethernet: [{ address: '192.168.0.5', family: 'IPv4', internal: false }] }, 'win32')).toBeNull()
    expect(findTailnetAddress({ tailscale0: [{ address: '100.70.1.2', family: 'IPv4', internal: false }] }, 'linux')).toBe('100.70.1.2')
    expect(findTailnetAddress({ utun4: [{ address: '100.70.1.2', family: 'IPv4', internal: false }] }, 'darwin')).toBe('100.70.1.2')
    expect(findTailnetAddress(null)).toBeNull()
  })

  it('does not take a carrier\'s address in the same range for Tailscale', () => {
    // 100.64.0.0/10 is also carrier NAT: tethering or an ISP can put it on an ordinary interface
    const carrier = [{ address: '100.72.3.4', family: 'IPv4', internal: false }]
    expect(findTailnetAddress({ Ethernet: carrier, 'Wi-Fi': carrier }, 'win32')).toBeNull()
    expect(findTailnetAddress({ wwan0: carrier }, 'linux')).toBeNull()
    expect(findTailnetAddress({ en0: carrier }, 'darwin')).toBeNull()
    expect(findTailnetAddress({ Ethernet: carrier, Tailscale: [{ address: '100.121.5.9', family: 'IPv4', internal: false }] }, 'win32')).toBe('100.121.5.9')
  })
})

describe('createAccessStore', () => {
  let filePath
  let clock
  const make = () => createAccessStore({ filePath, now: () => clock })
  const codeNow = (store) => totp.codeFor(store.totpSecret, totp.counterAt(clock))

  beforeEach(() => {
    filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-access-')), 'remote-access.json')
    clock = 1_800_000_000_000
  })

  it('starts switched off, and makes the secret when first switched on', () => {
    const store = make()
    expect(store.enabled).toBe(false)
    expect(store.totpSecret).toBeNull()
    store.setEnabled(true)
    expect(store.totpSecret).toMatch(/^[A-Z2-7]{32}$/)
    expect(make().enabled).toBe(true)
    expect(make().totpSecret).toBe(store.totpSecret)
  })

  it('registers a device with the one-time code, once', () => {
    const store = make()
    store.setEnabled(true)
    const { code } = store.startPairing()
    const first = store.redeemPairing(code, '  내 폰\n ')
    expect(first.token).toMatch(/^[\w-]{43}$/)
    expect(store.devices()).toEqual([{ id: first.deviceId, name: '내 폰', createdAt: clock, lastSeenAt: null, hasPush: false }])
    expect(store.redeemPairing(code, 'again')).toEqual({ error: 'bad-code' })
    // The token itself is not in the file
    expect(fs.readFileSync(filePath, 'utf-8')).not.toContain(first.token)
  })

  it('refuses a late, wrong or missing code', () => {
    const store = make()
    store.setEnabled(true)
    expect(store.redeemPairing('anything', 'x')).toEqual({ error: 'bad-code' })
    const { code } = store.startPairing()
    // The last character changed (to one it is not: the code is random and may end in any of them)
    expect(store.redeemPairing(`${code.slice(0, -1)}${code.endsWith('x') ? 'y' : 'x'}`, 'x')).toEqual({ error: 'bad-code' })
    clock += PAIRING_MS + 1
    expect(store.redeemPairing(code, 'x')).toEqual({ error: 'bad-code' })
  })

  it('signs a device in with its token and the code, and takes a code only once', () => {
    const store = make()
    store.setEnabled(true)
    const { token, deviceId } = store.redeemPairing(store.startPairing().code, 'phone')
    const code = codeNow(store)
    expect(store.signIn(token, code)).toEqual({ device: { id: deviceId, name: 'phone' } })
    expect(store.signIn(token, code)).toEqual({ error: 'bad-code' })
    clock += 30_000
    expect(store.signIn(token, codeNow(store))).toEqual({ device: { id: deviceId, name: 'phone' } })
    expect(store.signIn('not-a-token', codeNow(store))).toEqual({ error: 'unknown-device' })
  })

  it('stops answering a device for a while after five wrong codes, and only that device', () => {
    const store = make()
    store.setEnabled(true)
    const first = store.redeemPairing(store.startPairing().code, 'phone')
    const second = store.redeemPairing(store.startPairing().code, 'tablet')
    for (let i = 0; i < 5; i++) expect(store.signIn(first.token, '000000').error).toBe('bad-code')
    expect(store.isLockedOut(first.deviceId)).toBe(true)
    expect(store.signIn(first.token, codeNow(store))).toEqual({ error: 'locked' })
    // The other device, and registering a new one, go on
    expect(store.signIn(second.token, codeNow(store)).device).toBeTruthy()
    expect(store.redeemPairing(store.startPairing().code, 'x').token).toBeTruthy()
    clock += LOCKOUT_MS + 1
    expect(store.signIn(first.token, codeNow(store)).device).toBeTruthy()
  })

  it('lets nobody lock the owner out with wrong tokens or registration codes', () => {
    const store = make()
    store.setEnabled(true)
    const { token, deviceId } = store.redeemPairing(store.startPairing().code, 'phone')
    store.startPairing()
    for (let i = 0; i < 50; i++) {
      expect(store.signIn(`guess-${i}`, '000000')).toEqual({ error: 'unknown-device' })
      expect(store.redeemPairing(`guess-${i}`, 'x')).toEqual({ error: 'bad-code' })
    }
    expect(store.isLockedOut(deviceId)).toBe(false)
    expect(store.signIn(token, codeNow(store)).device).toBeTruthy()
  })

  it('answers any text as a code or token without throwing', () => {
    const store = make()
    store.setEnabled(true)
    const { code } = store.startPairing()
    // As many characters as the real code, more bytes: comparing the bytes directly throws
    const sameLength = '한'.repeat(code.length)
    expect(sameLength).toHaveLength(code.length)
    for (const value of [sameLength, 'é'.repeat(code.length), '', null, undefined, 42, {}, ['x']]) {
      expect(store.redeemPairing(value, 'x')).toEqual({ error: 'bad-code' })
      expect(store.signIn(value, value)).toEqual({ error: 'unknown-device' })
    }
    const { token } = store.redeemPairing(code, 'phone')
    for (const value of ['한글코드', '', null, 123456, {}]) expect(store.signIn(token, value).error).toMatch(/bad-code|locked/)
  })

  it('forgets a revoked device and limits how many there are', () => {
    const store = make()
    store.setEnabled(true)
    const made = []
    for (let i = 0; i < MAX_DEVICES; i++) made.push(store.redeemPairing(store.startPairing().code, `d${i}`))
    expect(store.redeemPairing(store.startPairing().code, 'one more')).toEqual({ error: 'too-many' })
    store.revoke(made[0].deviceId)
    expect(store.hasDevice(made[0].deviceId)).toBe(false)
    expect(store.signIn(made[0].token, codeNow(store))).toEqual({ error: 'unknown-device' })
    expect(make().devices()).toHaveLength(MAX_DEVICES - 1)
  })

  it('survives a broken file', () => {
    fs.writeFileSync(filePath, '{ not json')
    expect(make().enabled).toBe(false)
    fs.writeFileSync(filePath, JSON.stringify({ enabled: true, port: 80, devices: [{ id: 1 }, null] }))
    const store = make()
    expect(store.port).toBe(8722)
    expect(store.devices()).toEqual([])
  })
})

describe('createAccessStore with a sealer', () => {
  let filePath
  const clock = 1_800_000_000_000
  // Stands in for the OS: reversible, and never the plain text
  const sealer = {
    seal: (text) => Buffer.from(`sealed:${text}`).toString('base64'),
    unseal: (sealed) => Buffer.from(sealed, 'base64').toString().replace(/^sealed:/, '')
  }
  const make = (options = {}) => createAccessStore({ filePath, now: () => clock, sealer, ...options })

  beforeEach(() => {
    filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-access-')), 'remote-access.json')
  })

  it('never writes the secret in plain, and reads it back', () => {
    const store = make()
    store.setEnabled(true)
    const secret = store.totpSecret
    const file = fs.readFileSync(filePath, 'utf-8')
    expect(file).not.toContain(secret)
    expect(JSON.parse(file).totpSecret).toBeUndefined()
    expect(make().totpSecret).toBe(secret)
  })

  it('keeps the sealed secret when the file is saved before it was opened', () => {
    const first = make()
    first.setEnabled(true)
    const secret = first.totpSecret
    // A new run that saves (a device is unregistered) without ever needing the secret
    make().revoke('nobody')
    expect(make().totpSecret).toBe(secret)
  })

  it('seals a secret that an earlier version wrote in plain', () => {
    const plain = createAccessStore({ filePath, now: () => clock })
    plain.setEnabled(true)
    const secret = plain.totpSecret
    expect(fs.readFileSync(filePath, 'utf-8')).toContain(secret)
    const store = make()
    store.setEnabled(true)
    expect(store.totpSecret).toBe(secret)
    expect(fs.readFileSync(filePath, 'utf-8')).not.toContain(secret)
  })

  it('signs nobody in when the OS cannot open the secret', () => {
    const store = make()
    store.setEnabled(true)
    const { token } = store.redeemPairing(store.startPairing().code, 'phone')
    const code = totp.codeFor(store.totpSecret, totp.counterAt(clock))
    const broken = make({ sealer: { seal: () => null, unseal: () => { throw new Error('no key') } } })
    expect(broken.totpSecret).toBeNull()
    expect(broken.signIn(token, code)).toEqual({ error: 'bad-code' })
  })
})

describe('hardening from the security review', () => {
  it('reads what follows the mapped prefix as IPv4 only', () => {
    expect(isTailnetAddress('::ffff:fd7a:115c:a1e0:1')).toBe(false)
    expect(isTailnetAddress('::ffff:100.101.102.103')).toBe(true)
    expect(isTailnetAddress('fd7a:115c:a1e0::1%12')).toBe(true)
  })

  it('never writes the secret in plain when it cannot be sealed', () => {
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-access-')), 'remote-access.json')
    const store = createAccessStore({ filePath, sealer: { seal: () => null, unseal: () => null } })
    store.setEnabled(true)
    const secret = store.totpSecret
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    const file = fs.readFileSync(filePath, 'utf-8')
    expect(file).not.toContain(secret)
    expect(JSON.parse(file).totpSecret).toBeUndefined()
  })
})

describe('createAccessStore: notifications', () => {
  let filePath
  const sealer = {
    seal: (text) => Buffer.from(`sealed:${text}`).toString('base64'),
    unseal: (sealed) => Buffer.from(sealed, 'base64').toString().replace(/^sealed:/, '')
  }
  const SUBSCRIPTION = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'point', auth: 'secret' }

  beforeEach(() => {
    filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-access-')), 'remote-access.json')
  })

  it('makes the signing keys once and never writes the private half in plain', () => {
    const store = createAccessStore({ filePath, sealer })
    const keys = store.vapidKeys()
    expect(Buffer.from(keys.publicKey, 'base64url')).toHaveLength(65)
    expect(store.vapidKeys()).toEqual(keys)
    expect(fs.readFileSync(filePath, 'utf-8')).not.toContain(keys.privateKey)
    expect(createAccessStore({ filePath, sealer }).vapidKeys()).toEqual(keys)
  })

  it('remembers where to notify a device, and lists it without the address', () => {
    const store = createAccessStore({ filePath, sealer })
    store.setEnabled(true)
    const { deviceId } = store.redeemPairing(store.startPairing().code, 'phone')
    store.setPush(deviceId, SUBSCRIPTION)
    expect(store.pushTargets()).toEqual([{ deviceId, name: 'phone', subscription: SUBSCRIPTION }])
    expect(store.devices()[0]).toMatchObject({ id: deviceId, hasPush: true })
    expect(JSON.stringify(store.devices())).not.toContain('fcm.googleapis.com')
    expect(createAccessStore({ filePath, sealer }).pushTargets()).toHaveLength(1)
    store.setPush(deviceId, null)
    expect(store.pushTargets()).toEqual([])
    expect(store.devices()[0].hasPush).toBe(false)
  })

  it('forgets a device\'s subscription with the device, and all of them with the keys', () => {
    const store = createAccessStore({ filePath, sealer })
    store.setEnabled(true)
    const first = store.redeemPairing(store.startPairing().code, 'phone')
    store.vapidKeys()
    store.setPush(first.deviceId, SUBSCRIPTION)
    // The keys cannot be opened any more (another Windows account): new keys, and the old subscriptions go
    const broken = createAccessStore({ filePath, sealer: { seal: sealer.seal, unseal: () => { throw new Error('no key') } } })
    expect(broken.pushTargets()).toHaveLength(1)
    broken.vapidKeys()
    expect(broken.pushTargets()).toEqual([])
    store.setPush(first.deviceId, SUBSCRIPTION)
    store.revoke(first.deviceId)
    expect(store.pushTargets()).toEqual([])
  })
})
