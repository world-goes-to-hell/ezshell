import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import configModule from './mcpConfig.js'

const { createMcpConfigStore } = configModule

let filePath
beforeEach(() => {
  filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-')), 'mcp.json')
})

const bytesOf = (value) => () => Buffer.alloc(32, value)
const saved = () => JSON.parse(fs.readFileSync(filePath, 'utf8'))

describe('createMcpConfigStore', () => {
  it('creates safe defaults with a token and saves them', () => {
    const store = createMcpConfigStore({ filePath, randomBytes: bytesOf(1) })
    expect(store.get()).toEqual({ enabled: false, port: 47521, alertLevel: 'danger', token: '01'.repeat(32) })
    expect(saved().token).toBe('01'.repeat(32))
  })

  it('keeps valid stored values', () => {
    const stored = { enabled: true, port: 50000, alertLevel: 'all', token: 'ab'.repeat(32) }
    fs.writeFileSync(filePath, JSON.stringify(stored))
    expect(createMcpConfigStore({ filePath, randomBytes: bytesOf(1) }).get()).toEqual(stored)
  })

  it('repairs invalid stored values', () => {
    fs.writeFileSync(filePath, JSON.stringify({ enabled: 'yes', port: 80, alertLevel: 'loud', token: 'short' }))
    expect(createMcpConfigStore({ filePath, randomBytes: bytesOf(2) }).get())
      .toEqual({ enabled: false, port: 47521, alertLevel: 'danger', token: '02'.repeat(32) })
  })

  it('recovers from a corrupted file', () => {
    fs.writeFileSync(filePath, '{ not json')
    expect(createMcpConfigStore({ filePath, randomBytes: bytesOf(3) }).get().port).toBe(47521)
  })

  it('updates and persists valid changes', () => {
    const store = createMcpConfigStore({ filePath, randomBytes: bytesOf(1) })
    const next = store.update({ enabled: true, alertLevel: 'medium', port: 50001 })
    expect(next).toMatchObject({ enabled: true, alertLevel: 'medium', port: 50001 })
    expect(saved()).toMatchObject({ enabled: true, alertLevel: 'medium', port: 50001 })
  })

  it('rejects invalid changes without saving', () => {
    const store = createMcpConfigStore({ filePath, randomBytes: bytesOf(1) })
    expect(() => store.update({ port: 70000 })).toThrow('포트')
    expect(() => store.update({ port: 1023 })).toThrow('포트')
    expect(() => store.update({ alertLevel: 'loud' })).toThrow('알림 수준')
    expect(() => store.update({ enabled: 'yes' })).toThrow()
    expect(() => store.update({ token: 'x' })).toThrow('token')
    expect(saved()).toMatchObject({ enabled: false, port: 47521, alertLevel: 'danger' })
  })

  it('regenerates the token', () => {
    let calls = 0
    const store = createMcpConfigStore({ filePath, randomBytes: () => Buffer.alloc(32, ++calls) })
    const before = store.get().token
    const after = store.regenerateToken().token
    expect(after).not.toBe(before)
    expect(saved().token).toBe(after)
  })

  it('preserves old config if update save fails', () => {
    const store = createMcpConfigStore({ filePath, randomBytes: bytesOf(1) })
    const oldConfig = store.get()
    const failingFs = {
      readFileSync: fs.readFileSync,
      writeFileSync: () => { throw new Error('write failed') }
    }
    const store2 = createMcpConfigStore({ filePath, fileSystem: failingFs, randomBytes: bytesOf(1) })
    expect(() => store2.update({ port: 50001 })).toThrow('write failed')
    expect(store2.get()).toEqual(oldConfig)
  })

  it('preserves old config if regenerateToken save fails', () => {
    const store = createMcpConfigStore({ filePath, randomBytes: bytesOf(1) })
    const oldConfig = store.get()
    const failingFs = {
      readFileSync: fs.readFileSync,
      writeFileSync: () => { throw new Error('write failed') }
    }
    const store2 = createMcpConfigStore({ filePath, fileSystem: failingFs, randomBytes: bytesOf(1) })
    expect(() => store2.regenerateToken()).toThrow('write failed')
    expect(store2.get()).toEqual(oldConfig)
  })

  it('rejects constructor as invalid key', () => {
    const store = createMcpConfigStore({ filePath, randomBytes: bytesOf(1) })
    expect(() => store.update({ constructor: 1 })).toThrow('바꿀 수 없는 설정입니다')
  })

  it('throws when randomBytes returns wrong-length buffer', () => {
    const shortBytes = () => Buffer.alloc(16, 1)
    expect(() => createMcpConfigStore({ filePath, randomBytes: shortBytes })).toThrow()
  })
})
