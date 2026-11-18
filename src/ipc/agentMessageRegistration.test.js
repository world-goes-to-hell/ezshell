import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createAgentMessages } from './agentMessages.js'
import { createEntry, installAgentMessageMcp } from './agentMessageSetup.js'

let root
let bridgeFile
const clients = []
let messages

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-registration-test-'))
  bridgeFile = path.join(root, 'agent-message-connection')
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  messages?.stop()
  messages = undefined
  fs.rmSync(root, { recursive: true, force: true })
})

describe('register local agent message MCP', () => {
  it('preserves the existing Claude settings and reuses an identical registration', async () => {
    const file = path.join(root, '.claude.json')
    const original = { mcpServers: { other: { command: 'other' } }, projects: { sample: { enabled: true } } }
    fs.writeFileSync(file, JSON.stringify(original))
    const options = { bridgeFile, homeDir: root, env: {}, enableBridge: vi.fn() }
    expect(await installAgentMessageMcp('claude', options)).toBe('added')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      ...original, mcpServers: { ...original.mcpServers, 'ezshell-cli-mcp': { type: 'stdio', ...createEntry('claude', bridgeFile) } }
    })
    expect(await installAgentMessageMcp('claude', options)).toBe('unchanged')
    expect(JSON.parse(fs.readFileSync(file + '.ezshell-backup', 'utf8'))).toEqual(original)
  })

  it('preserves an existing Codex server with the same name', async () => {
    const codex = vi.fn().mockResolvedValue(JSON.stringify([{ name: 'ezshell-cli-mcp', transport: { type: 'http', url: 'http://localhost:4123/mcp' } }]))
    const enableBridge = vi.fn()
    expect(await installAgentMessageMcp('codex', { bridgeFile, codex, enableBridge })).toBe('conflict')
    expect(codex).toHaveBeenCalledExactlyOnceWith(['mcp', 'list', '--json'])
    expect(enableBridge).not.toHaveBeenCalled()
  })

  it('registers the bridge through the Codex CLI without changing other names', async () => {
    const codex = vi.fn().mockResolvedValueOnce(JSON.stringify([{ name: 'other' }])).mockResolvedValueOnce('')
    const entry = createEntry('codex', bridgeFile)
    expect(await installAgentMessageMcp('codex', { bridgeFile, codex, enableBridge: vi.fn() })).toBe('added')
    expect(codex).toHaveBeenNthCalledWith(2, [
      'mcp', 'add', 'ezshell-cli-mcp', '--env', `EZSHELL_AGENT_BRIDGE_FILE=${bridgeFile}`,
      '--env', 'EZSHELL_AGENT_BRIDGE_KIND=codex', '--', entry.command, ...entry.args
    ])
  })

  it('moves this app’s old registration after installing the new Codex name', async () => {
    const entry = createEntry('codex', bridgeFile)
    const codex = vi.fn().mockResolvedValueOnce(JSON.stringify([
      { name: 'ezshell_agent', transport: { type: 'stdio', ...entry, args: ['old-launcher'] } }
    ])).mockResolvedValue('')
    expect(await installAgentMessageMcp('codex', { bridgeFile, codex, enableBridge: vi.fn() })).toBe('added')
    expect(codex.mock.calls[1][0].slice(0, 3)).toEqual(['mcp', 'add', 'ezshell-cli-mcp'])
    expect(codex.mock.calls[2][0]).toEqual(['mcp', 'remove', 'ezshell_agent'])
  })

  it('moves an owned old Claude entry and preserves unrelated servers', async () => {
    const file = path.join(root, '.claude.json')
    const entry = { type: 'stdio', ...createEntry('claude', bridgeFile) }
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { ezshell_agent: { ...entry, args: ['old'] }, other: { command: 'other' } } }))
    expect(await installAgentMessageMcp('claude', { bridgeFile, homeDir: root, env: {}, enableBridge: vi.fn() })).toBe('added')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers).toEqual({ other: { command: 'other' }, 'ezshell-cli-mcp': entry })
  })

  it('refreshes this app’s launcher under its current name for both clients', async () => {
    const file = path.join(root, '.claude.json')
    const claudeEntry = { type: 'stdio', ...createEntry('claude', bridgeFile) }
    const codexEntry = { type: 'stdio', ...createEntry('codex', bridgeFile) }
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'ezshell-cli-mcp': { ...claudeEntry, args: ['old'] } } }))
    const codex = vi.fn().mockResolvedValueOnce(JSON.stringify([
      { name: 'ezshell-cli-mcp', transport: { ...codexEntry, args: ['old'] } }
    ])).mockResolvedValue('')
    const enableBridge = vi.fn()
    expect(await installAgentMessageMcp('claude', { bridgeFile, homeDir: root, env: {}, enableBridge })).toBe('added')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers['ezshell-cli-mcp']).toEqual(claudeEntry)
    expect(await installAgentMessageMcp('codex', { bridgeFile, codex, enableBridge })).toBe('added')
    expect(codex.mock.calls[1][0].slice(0, 3)).toEqual(['mcp', 'add', 'ezshell-cli-mcp'])
  })

  it('creates distinct sessions from the installed definitions and drops a disconnected agent', async () => {
    messages = createAgentMessages({ notify() {}, isLocked: () => false, bridgeFile })
    await messages.enableExternalBridge()

    const connect = async kind => {
      const entry = createEntry(kind, bridgeFile)
      const client = new Client({ name: 'ezshell-test', version: '1' })
      clients.push(client)
      await client.connect(new StdioClientTransport({ ...entry, env: { ...process.env, ...entry.env }, stderr: 'pipe' }))
      return async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args })
        expect(result.isError).not.toBe(true)
        return JSON.parse(result.content[0].text)
      }
    }
    const codex = await connect('codex')
    const claude = await connect('claude')
    await claude('list_agents')
    const { agents, self } = await codex('list_agents')
    expect(self).toBe('codex-1')
    expect(agents.map(agent => agent.id)).toEqual(['codex-1', 'claude-2'])
    await codex('send_message', { to: 'claude-2', text: 'Please review' })
    expect((await claude('read_inbox')).messages[0].text).toBe('Please review')
    await clients.pop().close()
    await vi.waitFor(() => expect(messages.snapshot().agents[1]).toMatchObject({ id: 'claude-2', active: false, mcpConnected: false }))
    expect((await codex('list_agents')).agents.map(agent => agent.id)).toEqual(['codex-1'])
  }, 15000)
})
