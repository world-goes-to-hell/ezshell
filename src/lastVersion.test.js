import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { readLastVersion, writeLastVersion, resolveWhatsNew } = require('./lastVersion.js')

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-lastver-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const file = () => path.join(dir, 'last-version.json')

describe('lastVersion', () => {
  it('reads what it wrote and null for a missing or broken file', () => {
    expect(readLastVersion(file())).toBeNull()
    writeLastVersion(file(), '2.14.0')
    expect(readLastVersion(file())).toBe('2.14.0')
    fs.writeFileSync(file(), '{oops')
    expect(readLastVersion(file())).toBeNull()
    fs.writeFileSync(file(), JSON.stringify({ version: 'not a version' }))
    expect(readLastVersion(file())).toBeNull()
  })

  it('records the version on a fresh install so nothing is shown', () => {
    const state = resolveWhatsNew({ file: file(), current: '2.14.0', existingUser: false })
    expect(state).toEqual({ previous: '2.14.0', current: '2.14.0', existingUser: false })
    expect(readLastVersion(file())).toBe('2.14.0')
  })

  it('leaves the record alone for an existing user until the notes are seen', () => {
    expect(resolveWhatsNew({ file: file(), current: '2.14.0', existingUser: true })).toEqual({ previous: null, current: '2.14.0', existingUser: true })
    expect(readLastVersion(file())).toBeNull()
    writeLastVersion(file(), '2.12.0')
    expect(resolveWhatsNew({ file: file(), current: '2.14.0', existingUser: true }).previous).toBe('2.12.0')
  })
})
