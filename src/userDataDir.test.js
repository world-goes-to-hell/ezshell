import { describe, it, expect } from 'vitest'
import path from 'path'
import userDataDir from './userDataDir.js'

const { resolveUserDataDir, legacyDataDirNames } = userDataDir

const APPDATA = path.join('C:', 'Users', 'me', 'AppData', 'Roaming')
const at = (name) => path.join(APPDATA, name)
const existing = (...dirs) => (dir) => dirs.includes(dir)

describe('resolveUserDataDir', () => {
  it('keeps using the folder of the old product name so sessions and the master password carry over', () => {
    const dir = resolveUserDataDir({
      appDataDir: APPDATA,
      defaultDir: at('ezshell'),
      legacyNames: ['my-ssh-client'],
      exists: existing(at('my-ssh-client'))
    })

    expect(dir).toBe(at('my-ssh-client'))
  })

  it('prefers the old folder even when a new one also exists (never hide saved sessions)', () => {
    const dir = resolveUserDataDir({
      appDataDir: APPDATA,
      defaultDir: at('ezshell'),
      legacyNames: ['my-ssh-client'],
      exists: existing(at('my-ssh-client'), at('ezshell'))
    })

    expect(dir).toBe(at('my-ssh-client'))
  })

  it('uses the new default folder on a fresh install', () => {
    const dir = resolveUserDataDir({
      appDataDir: APPDATA,
      defaultDir: at('ezshell'),
      legacyNames: ['my-ssh-client'],
      exists: existing()
    })

    expect(dir).toBe(at('ezshell'))
  })
})

describe('legacyDataDirNames', () => {
  it('is the package name used before the rename (installed builds and npm run dev alike)', () => {
    expect(legacyDataDirNames()).toEqual(['my-ssh-client'])
  })
})
