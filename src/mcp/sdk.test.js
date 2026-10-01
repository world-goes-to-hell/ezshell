import { describe, it, expect, vi, afterEach } from 'vitest'
import sdk from './sdk.js'

describe('sdk loader', () => {
  it('exposes the MCP server classes and zod', () => {
    expect(typeof sdk.McpServer).toBe('function')
    expect(typeof sdk.StreamableHTTPServerTransport).toBe('function')
    expect(typeof sdk.z.string).toBe('function')
  })

  it('makes Web Crypto available globally for the SDK', () => {
    expect(globalThis.crypto?.subtle).toBeDefined()
  })

  describe('without a global crypto (Electron 28 / Node 18)', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')

    afterEach(() => {
      if (original) Object.defineProperty(globalThis, 'crypto', original)
      vi.resetModules()
    })

    it('fills globalThis.crypto with Node webcrypto before loading the SDK', async () => {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
      expect(globalThis.crypto).toBeUndefined()
      vi.resetModules()

      await import('./sdk.js')

      expect(globalThis.crypto?.subtle).toBeDefined()
      expect(typeof globalThis.crypto.randomUUID()).toBe('string')
    })
  })
})
