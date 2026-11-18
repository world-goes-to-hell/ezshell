import { describe, it, expect } from 'vitest'
import sdk from './sdk.js'

describe('sdk loader', () => {
  it('exposes the MCP server classes and zod', () => {
    expect(typeof sdk.McpServer).toBe('function')
    expect(typeof sdk.StreamableHTTPServerTransport).toBe('function')
    expect(typeof sdk.z.string).toBe('function')
  })

  // The SDK needs it; the runtime has it since Node 20 (the loader no longer fills it in)
  it('has Web Crypto as a global for the SDK', () => {
    expect(globalThis.crypto?.subtle).toBeDefined()
  })
})
