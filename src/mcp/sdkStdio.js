// The MCP SDK for the agent message server only (src/ipc/agentMessageMcp.js): stdio, no HTTP transport.
// sdk.js also loads the HTTP transport, which pulls express, hono and more into the agent runtime bundle
// that agents start outside the install folder (docs/plan/2026-11-26-sessions-survive-update.md).

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

module.exports = { McpServer, StdioServerTransport, z }
