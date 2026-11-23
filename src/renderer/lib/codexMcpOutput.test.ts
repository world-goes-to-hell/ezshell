import { describe, expect, it } from 'vitest'
import { parseCodexMcpOutput } from './codexMcpOutput'

describe('parseCodexMcpOutput', () => {
  it('reads the summary and leaves extra lines for the raw output', () => {
    expect(parseCodexMcpOutput([
      '🔌  MCP Tools',
      '  • codex_apps: connected (108 tools)',
      '  • ezshell-cli-mcp: failed (7 tools)',
      '  • msw-mcp: authentication required (0 tools)',
      '  • future-server: disconnected (1 tool)',
      '  Use /mcp verbose for tools and resources.',
      '  New status details from Codex.'
    ].join('\n'))).toEqual([
      { name: 'codex_apps', status: 'connected', label: 'connected', tools: 108 },
      { name: 'ezshell-cli-mcp', status: 'failed', label: 'failed', tools: 7 },
      { name: 'msw-mcp', status: 'auth', label: 'authentication required', tools: 0, loginCommand: '/mcp login msw-mcp' },
      { name: 'future-server', status: 'other', label: 'disconnected', tools: 1 }
    ])
  })

  it('offers login only for a server name that can be sent as one argument', () => {
    expect(parseCodexMcpOutput('MCP Tools\r\n  • --help: authentication required (0 tools)')?.[0].loginCommand).toBeUndefined()
    expect(parseCodexMcpOutput('MCP Tools\n  • server --environment other: authentication required (0 tools)')?.[0].loginCommand).toBeUndefined()
  })

  it('uses plain output when the heading or the server format is unknown', () => {
    expect(parseCodexMcpOutput('Previous output\nMCP Tools\n  • one: connected (1 tool)')).toBeNull()
    expect(parseCodexMcpOutput('🔌  MCP Tools\n  • No MCP servers configured.')).toBeNull()
    expect(parseCodexMcpOutput('MCP Tools\n  • one: connected (9007199254740992 tools)')).toBeNull()
  })
})
