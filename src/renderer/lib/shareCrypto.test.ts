import { describe, it, expect } from 'vitest'
import { sealSecrets, openSecrets, secretBoxSchema, generatePassphrase, PBKDF2_ITERATIONS, PASSPHRASE_MIN, ShareUnlockError } from './shareCrypto'

const AAD = 'eyJzZXNzaW9uIjp7fX0'

describe('shareCrypto', { timeout: 30000 }, () => {
  it('opens what it sealed with the same passphrase and plain part', async () => {
    const box = await sealSecrets([{ password: '비밀-1' }], '공유 암호 1234', AAD)
    expect(box.iter).toBe(PBKDF2_ITERATIONS)
    expect(JSON.stringify(box)).not.toContain('비밀')
    expect(await openSecrets(box, '공유 암호 1234', AAD)).toEqual([{ password: '비밀-1' }])
  })

  it('uses a fresh salt and iv every time', async () => {
    const a = await sealSecrets([], 'passphrase', AAD)
    const b = await sealSecrets([], 'passphrase', AAD)
    expect(a.salt).not.toBe(b.salt)
    expect(a.iv).not.toBe(b.iv)
  })

  it('refuses a wrong passphrase', async () => {
    const box = await sealSecrets(['x'], 'passphrase-a', AAD)
    await expect(openSecrets(box, 'passphrase-b', AAD)).rejects.toBeInstanceOf(ShareUnlockError)
  })

  it('refuses when the plain part was changed (e.g. another host swapped in)', async () => {
    const box = await sealSecrets(['x'], 'passphrase', AAD)
    await expect(openSecrets(box, 'passphrase', AAD + 'A')).rejects.toBeInstanceOf(ShareUnlockError)
  })

  it('refuses a tampered ciphertext', async () => {
    const box = await sealSecrets(['x'], 'passphrase', AAD)
    const flipped = (box.data[0] === 'A' ? 'B' : 'A') + box.data.slice(1)
    await expect(openSecrets({ ...box, data: flipped }, 'passphrase', AAD)).rejects.toBeInstanceOf(ShareUnlockError)
  })

  it('accepts only sane box shapes and iteration counts', () => {
    const good = { salt: 'A'.repeat(22), iv: 'A'.repeat(16), iter: PBKDF2_ITERATIONS, data: 'AAAA' }
    expect(secretBoxSchema.safeParse(good).success).toBe(true)
    expect(secretBoxSchema.safeParse({ ...good, iter: 1000 }).success).toBe(false)
    expect(secretBoxSchema.safeParse({ ...good, iter: 50_000_000 }).success).toBe(false)
    expect(secretBoxSchema.safeParse({ ...good, salt: 'short' }).success).toBe(false)
    expect(secretBoxSchema.safeParse({ ...good, iv: 'A'.repeat(15) }).success).toBe(false)
    expect(secretBoxSchema.safeParse({ ...good, data: 'not base64!' }).success).toBe(false)
  })
})

describe('passphrase handling', { timeout: 30000 }, () => {
  it('treats composed and decomposed Hangul as the same passphrase', async () => {
    const nfc = '공유암호입니다요'.normalize('NFC')
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc)
    const box = await sealSecrets(['x'], nfd, AAD)
    expect(await openSecrets(box, nfc, AAD)).toEqual(['x'])
  })

  it('generates readable random passphrases long enough for the minimum', () => {
    const a = generatePassphrase()
    expect(a).toMatch(/^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){3}$/)
    expect(a.length).toBeGreaterThanOrEqual(PASSPHRASE_MIN)
    expect(generatePassphrase()).not.toBe(a)
  })
})
