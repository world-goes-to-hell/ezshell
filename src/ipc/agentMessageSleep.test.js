import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createAgentMessages } from './agentMessages.js'

// An agent put to sleep to save memory (src/agentIdle.js): its CLI and messages MCP are gone, but the
// others still see it and can write to it; a message wakes it (the shell resumes it under the same id).
let root
let messages
const clients = []
const woken = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-sleep-test-'))
  woken.length = 0
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => {})))
  messages?.stop()
  messages = undefined
  fs.rmSync(root, { recursive: true, force: true })
})

async function agent(kind, shellId) {
  const { env } = messages.register(kind, shellId, root, {})
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
    return { error: result.isError ? result.content[0].text : null, ...(result.isError ? {} : JSON.parse(result.content[0].text)) }
  }
  await vi.waitFor(async () => expect((await call('list_agents')).self).toBe(env.EZSHELL_AGENT_ID))
  return { id: env.EZSHELL_AGENT_ID, call, client }
}

const SESSION = '0f3a8d40-5ff7-4d63-967c-90f524623f87'

describe('a sleeping agent', () => {
  it('stays listed and takes messages, each of which wakes its shell', async () => {
    messages = createAgentMessages({ notify: () => {}, isLocked: () => false, onInboxChanged: shell => woken.push(shell) })
    await messages.ready()
    const lead = await agent('claude', 'local:1')
    const worker = await agent('codex', 'local:2')

    expect(messages.sleep(worker.id, SESSION)).toBe(true)
    await worker.client.close()
    const state = messages.snapshot().agents.find(item => item.id === worker.id)
    expect(state).toMatchObject({ active: true, sleeping: true, status: 'sleeping', resumeId: SESSION })

    const listed = await lead.call('list_agents')
    expect(listed.agents.map(item => item.id)).toContain(worker.id)
    woken.length = 0
    const sent = await lead.call('send_message', { to: worker.id, text: '깨어나면 로그 봐 줘' })
    expect(sent.error).toBeNull()
    expect(woken).toEqual(['local:2'])
  })

  it('ends when it is not resumed after all', async () => {
    messages = createAgentMessages({ notify: () => {}, isLocked: () => false, onInboxChanged: () => {} })
    await messages.ready()
    const lead = await agent('claude', 'local:1')
    const worker = await agent('codex', 'local:2')
    messages.sleep(worker.id, SESSION)
    // Closing failed (text in its composer): awake as before
    messages.cancelSleep(worker.id, { ended: false })
    expect(messages.snapshot().agents.find(item => item.id === worker.id)).toMatchObject({ active: true, status: 'idle' })
    expect(messages.snapshot().agents.find(item => item.id === worker.id).sleeping).toBeUndefined()

    messages.sleep(worker.id, SESSION)
    await worker.client.close()
    // The shell was closed while it slept
    messages.cancelSleep(worker.id, { ended: true })
    expect((await lead.call('list_agents')).agents.map(item => item.id)).not.toContain(worker.id)
    expect((await lead.call('send_message', { to: worker.id, text: '거기 있어?' })).error).toMatch(/찾을 수 없습니다/)
  })
})
