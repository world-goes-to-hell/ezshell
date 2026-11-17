// Single entry point for the MCP SDK in the main process. The SDK expects Web Crypto as a global:
// the main process has it since Electron moved past Node 18 (checked on Electron 45, Node 24).

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { z } = require('zod')

module.exports = { McpServer, StreamableHTTPServerTransport, z }
