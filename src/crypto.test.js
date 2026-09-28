import { describe, it, expect } from 'vitest'
import cryptoUtil from './crypto.js'

describe('encryptAsync', () => {
  it('produces data that the existing decrypt can read', async () => {
    const encrypted = await cryptoUtil.encryptAsync('{"k":[{"command":"ls"}]}', 'master-pw')
    expect(cryptoUtil.decrypt(encrypted, 'master-pw')).toBe('{"k":[{"command":"ls"}]}')
  })

  it('uses the same format as encrypt', async () => {
    const asyncResult = await cryptoUtil.encryptAsync('text', 'pw')
    const syncResult = cryptoUtil.encrypt('text', 'pw')
    expect(Object.keys(asyncResult).sort()).toEqual(Object.keys(syncResult).sort())
  })

  it('cannot be read with a different password', async () => {
    const encrypted = await cryptoUtil.encryptAsync('secret', 'right')
    expect(() => cryptoUtil.decrypt(encrypted, 'wrong')).toThrow()
  })
})
