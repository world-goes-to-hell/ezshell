import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createAgentMessages } from './agentMessages.js'

// Read marks instead of receipts (2026-11-20): the recipient reading its inbox is what the sender sees
// (check_sent: unread → read → answered); send_receipt is gone.
let root
let messages
const clients = []
const woken = []
const states = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-read-test-'))
  woken.length = 0
  states.length = 0
})

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
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
  // Ready once its MCP connection is counted
  await vi.waitFor(async () => expect((await call('list_agents')).self).toBe(env.EZSHELL_AGENT_ID))
  return { id: env.EZSHELL_AGENT_ID, call, listTools: () => client.listTools() }
}

async function pair() {
  messages = createAgentMessages({
    notify: (channel, payload) => { if (channel === 'agent-messages-state') states.push(payload) },
    isLocked: () => false,
    onInboxChanged: shell => woken.push(shell)
  })
  await messages.ready()
  const lead = await agent('claude', 'local:1')
  const worker = await agent('codex', 'local:2')
  woken.length = 0
  const { id } = await lead.call('send_message', { to: worker.id, text: '로그인 화면 고쳐 줘' })
  return { lead, worker, id }
}

const statusOf = async (agentClient, id) => (await agentClient.call('check_sent', { message_ids: [id] })).messages[0]

describe('read marks', () => {
  it('the sender sees unread, then read with its time, then answered with the reply', async () => {
    const { lead, worker, id } = await pair()
    expect(woken).toEqual(['local:2'])
    expect(await statusOf(lead, id)).toMatchObject({ id, to: worker.id, text: '로그인 화면 고쳐 줘', status: 'unread', readAt: null })

    expect((await worker.call('read_inbox')).messages.map(m => m.text)).toEqual(['로그인 화면 고쳐 줘'])
    const read = await statusOf(lead, id)
    expect(read.status).toBe('read')
    expect(typeof read.readAt).toBe('number')
    // Read but not answered: still a request the worker owes (reminded after its task)
    expect(messages.unreadFor('local:2')).toEqual([])
    expect(messages.unhandledFor('local:2')).toEqual([id])

    const reply = await worker.call('reply_to_message', { message_id: id, text: '고쳤습니다' })
    expect(await statusOf(lead, id)).toMatchObject({ status: 'answered', answer: { kind: 'reply', id: reply.id } })
    expect(woken).toEqual(['local:2', 'local:1'])
    expect(messages.unhandledFor('local:2')).toEqual([])
  }, 15000)

  it('an acknowledged note counts as answered, and the panel gets the read time', async () => {
    const { lead, worker, id } = await pair()
    await worker.call('read_inbox')
    expect(states.at(-1).messages.find(m => m.id === id).seenAt).toEqual(expect.any(Number))
    await worker.call('acknowledge_message', { message_id: id })
    expect(await statusOf(lead, id)).toMatchObject({ status: 'answered', answer: { kind: 'acknowledged' } })
  }, 15000)

  it('lists only the caller\'s own messages, the last ones by default', async () => {
    const { lead, worker, id } = await pair()
    await worker.call('send_message', { to: lead.id, text: '질문 있어요' })
    expect((await lead.call('check_sent')).messages.map(m => m.id)).toEqual([id])
    expect((await worker.call('check_sent', { message_ids: [id] })).messages).toEqual([])
  }, 15000)

  it('send_receipt is gone, and a receipt from an agent started before the update is refused', async () => {
    const { worker, id } = await pair()
    const tools = (await worker.listTools()).tools.map(tool => tool.name)
    expect(tools).toContain('check_sent')
    expect(tools).not.toContain('send_receipt')
    expect(() => messages.sendAsUser({ to: worker.id, text: '받았습니다', receipt: true })).toThrow(/수신 확인은 없어졌습니다/)
    expect(messages.unhandledFor('local:2')).toEqual([id])
  }, 15000)
})
