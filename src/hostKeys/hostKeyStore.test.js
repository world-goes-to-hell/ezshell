import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import storeModule from './hostKeyStore.js'
import helper from './hostKeys.testhelper.js'

const { createHostKeyStore, describeHostKey } = storeModule
const { hostKey } = helper

let dir
let filePath

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-hostkeys-'))
  filePath = path.join(dir, 'known-hosts.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('describeHostKey', () => {
  it('reads the key type and gives an OpenSSH style SHA256 fingerprint', () => {
    const key = hostKey('ssh-ed25519', 7)
    const expected = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
    expect(describeHostKey(key)).toEqual({ keyType: 'ssh-ed25519', fingerprint: expected })
  })

  it('does not trust a malformed key type', () => {
    expect(describeHostKey(Buffer.from([0, 0, 0, 200, 1, 2])).keyType).toBe('unknown')
  })
})

describe('createHostKeyStore', () => {
  it('reports a new server as unknown and as trusted once saved', () => {
    const store = createHostKeyStore({ filePath })
    const key = hostKey()
    expect(store.check('dev.example', 22, key).status).toBe('unknown')
    store.trust('dev.example', 22, key)
    expect(store.check('dev.example', 22, key)).toMatchObject({ status: 'trusted', keyType: 'ssh-ed25519' })
  })

  it('reports a different key for a saved server as changed, with the saved fingerprint', () => {
    const store = createHostKeyStore({ filePath })
    const saved = hostKey('ssh-ed25519', 1)
    store.trust('dev.example', 22, saved)
    const result = store.check('dev.example', 22, hostKey('ssh-ed25519', 2))
    expect(result.status).toBe('changed')
    expect(result.previous).toEqual(describeHostKey(saved))
  })

  it('treats a key of another type as changed, not as a new server', () => {
    const store = createHostKeyStore({ filePath })
    store.trust('dev.example', 22, hostKey('ssh-ed25519'))
    expect(store.check('dev.example', 22, hostKey('ssh-rsa')).status).toBe('changed')
  })

  it('replaces the saved key when a changed key is trusted', () => {
    const store = createHostKeyStore({ filePath })
    store.trust('dev.example', 22, hostKey('ssh-ed25519', 1))
    store.trust('dev.example', 22, hostKey('ssh-ed25519', 2))
    expect(store.check('dev.example', 22, hostKey('ssh-ed25519', 2)).status).toBe('trusted')
    expect(store.check('dev.example', 22, hostKey('ssh-ed25519', 1)).status).toBe('changed')
  })

  it('keeps servers apart by port and ignores host name case', () => {
    const store = createHostKeyStore({ filePath })
    const key = hostKey()
    store.trust('Dev.Example', 22, key)
    expect(store.check('dev.example', 22, key).status).toBe('trusted')
    expect(store.check('dev.example', 2222, key).status).toBe('unknown')
  })

  it('treats a missing port as 22', () => {
    const store = createHostKeyStore({ filePath })
    const key = hostKey()
    store.trust('dev.example', undefined, key)
    expect(store.check('dev.example', 22, key).status).toBe('trusted')
  })

  it('keeps saved keys across instances', () => {
    const key = hostKey()
    createHostKeyStore({ filePath }).trust('dev.example', 22, key)
    expect(createHostKeyStore({ filePath }).check('dev.example', 22, key).status).toBe('trusted')
  })

  it('does not write server addresses to the file in plain text', () => {
    const store = createHostKeyStore({ filePath })
    store.trust('secret-db.internal', 22, hostKey())
    store.trust('10.20.30.40', 2222, hostKey())
    const text = fs.readFileSync(filePath, 'utf8')
    expect(text).not.toContain('secret-db')
    expect(text).not.toContain('10.20.30.40')
  })

  it('moves a corrupt file aside and starts empty', () => {
    fs.writeFileSync(filePath, '{ not json')
    const store = createHostKeyStore({ filePath })
    expect(store.check('dev.example', 22, hostKey()).status).toBe('unknown')
    const names = fs.readdirSync(dir)
    expect(names.some(name => name.startsWith('known-hosts.json.corrupt-'))).toBe(true)
    store.trust('dev.example', 22, hostKey())
    expect(createHostKeyStore({ filePath }).check('dev.example', 22, hostKey()).status).toBe('trusted')
  })

  it('never overwrites a file it could not read, and reads it again next time', () => {
    const key = hostKey()
    createHostKeyStore({ filePath }).trust('dev.example', 22, key)
    const before = fs.readFileSync(filePath, 'utf8')
    let isLocked = true
    const lockedFs = {
      ...fs,
      readFileSync: (...args) => {
        if (isLocked) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
        return fs.readFileSync(...args)
      }
    }
    const store = createHostKeyStore({ filePath, fs: lockedFs })
    expect(store.check('other.example', 22, key).status).toBe('unknown')
    expect(() => store.trust('other.example', 22, key)).toThrow()
    expect(fs.readFileSync(filePath, 'utf8')).toBe(before)
    isLocked = false
    expect(store.check('dev.example', 22, key).status).toBe('trusted')
  })

  it('leaves no temporary file behind when saving fails', () => {
    const failingFs = { ...fs, renameSync: () => { throw new Error('EPERM') } }
    const store = createHostKeyStore({ filePath, fs: failingFs })
    expect(() => store.trust('dev.example', 22, hostKey())).toThrow()
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('ignores entries that are not in the expected shape', () => {
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, salt: 'x'.repeat(44), hosts: { a: 'nope', b: { keyType: 1 } } }))
    const store = createHostKeyStore({ filePath })
    expect(store.check('dev.example', 22, hostKey()).status).toBe('unknown')
  })
})
