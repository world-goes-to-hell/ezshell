import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { isLocalFilePath, readPrivateKeyFile } = require('./localKeyPath.js')

describe('isLocalFilePath', () => {
  it('accepts absolute paths on a local drive or the filesystem root', () => {
    for (const p of ['C:\\Users\\me\\.ssh\\id_rsa', 'd:/keys/a.pem', '/home/me/.ssh/id_ed25519', '/Users/me/key.ppk']) {
      expect(isLocalFilePath(p)).toBe(true)
    }
  })

  it('refuses network and device paths (reading them would contact another machine or hang)', () => {
    for (const p of ['\\\\attacker\\share\\id', '//attacker/share/id', '\\\\?\\UNC\\host\\share\\id', '\\\\.\\pipe\\x', '\\\\.\\COM1', '\\\\?\\C:\\keys\\id', 'file://host/id', 'smb://host/id']) {
      expect(isLocalFilePath(p)).toBe(false)
    }
  })

  it('refuses relative paths, ~, environment variables and control characters', () => {
    for (const p of ['keys\\id', 'id_rsa', '~/.ssh/id', '%USERPROFILE%\\id', 'C:\\keys\\id\n', '', null, 42]) {
      expect(isLocalFilePath(p)).toBe(false)
    }
  })
})

describe('readPrivateKeyFile', () => {
  it('reads a local path and refuses others without touching them', () => {
    const reads = []
    const readFile = (p) => { reads.push(p); return Buffer.from('key') }
    expect(readPrivateKeyFile('C:\\keys\\id', readFile).toString()).toBe('key')
    expect(() => readPrivateKeyFile('\\\\attacker\\share\\id', readFile)).toThrow('이 PC')
    expect(reads).toEqual(['C:\\keys\\id'])
  })
})
