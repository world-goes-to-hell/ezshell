// Single entry point for the MCP SDK in the main process.
// Electron 28 runs Node 18, where Web Crypto is not a global yet; the SDK expects it.
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto
}

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { z } = require('zod')

module.exports = { McpServer, StreamableHTTPServerTransport, z }
