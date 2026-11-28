// list_agents (2026-11-28 user report): an agent asked for the agents of a folder found two while the sidebar showed
// three, the third running in its terminal without a message connection. It is listed as connected: false.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createAgentMessages } from './agentMessages.js'

let root
let messages
const clients = []

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-list-test-')) })
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  messages?.stop()
  messages = undefined
  fs.rmSync(root, { recursive: true, force: true })
})

async function connect(registration) {
  const { env } = registration
  const client = new Client({ name: 'ezshell-test', version: '1' })
  clients.push(client)
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [env.EZSHELL_AGENT_MCP_SCRIPT],
    env: { ...process.env, EZSHELL_AGENT_PIPE: env.EZSHELL_AGENT_PIPE, EZSHELL_AGENT_TOKEN: env.EZSHELL_AGENT_TOKEN },
    stderr: 'pipe'
  }))
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text)
  }
  await vi.waitFor(async () => expect((await call('list_agents')).self).toBe(env.EZSHELL_AGENT_ID))
  return { id: env.EZSHELL_AGENT_ID, call }
}

describe('list_agents', () => {
  it('lists an agent of a local terminal without a message connection as connected: false, and send refuses it', async () => {
    messages = createAgentMessages({ notify: () => {}, isLocked: () => false })
    await messages.ready()
    const lead = await connect(messages.register('claude', 'local:1', root, {}))
    const offline = messages.register('codex', 'local:2', root, {})
    const ended = messages.register('codex', 'local:3', root, {})
    ended.finish(0)
    // A CLI that ended while still counted active (its exit not seen) is not offered either
    const stale = messages.register('codex', 'local:5', root, {})
    stale.setStatus('ended', 'screen')
    const { agents } = await lead.call('list_agents')
    expect(agents).toEqual([
      { id: lead.id, kind: 'claude', cwd: root, role: null },
      { id: offline.env.EZSHELL_AGENT_ID, kind: 'codex', cwd: root, role: null, connected: false }
    ])
    expect((await lead.call('send_message', { to: offline.env.EZSHELL_AGENT_ID, text: 'hello' })).error).toContain('메시지를 받을 실행 중인 에이전트를 찾을 수 없습니다.')
    // Once its MCP connects it is an ordinary entry
    await connect(offline)
    expect((await lead.call('list_agents')).agents[1]).toEqual({ id: offline.env.EZSHELL_AGENT_ID, kind: 'codex', cwd: root, role: null })
  })
})
