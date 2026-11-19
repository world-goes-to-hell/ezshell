import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createAgentMessages } from './agentMessages.js'

// A recipient confirms a request right away (send_receipt) and answers it when done (reply_to_message)
let root
let messages
const clients = []
const woken = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-receipt-test-'))
  woken.length = 0
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
  messages = createAgentMessages({ notify() {}, isLocked: () => false, onInboxChanged: shell => woken.push(shell) })
  await messages.ready()
  const lead = await agent('claude', 'local:1')
  const worker = await agent('codex', 'local:2')
  woken.length = 0
  const { id } = await lead.call('send_message', { to: worker.id, text: '로그인 화면 고쳐 줘' })
  return { lead, worker, id }
}

describe('receipts', () => {
  it('reach the sender marked as a receipt and leave the request open until the result', async () => {
    const { lead, worker, id } = await pair()
    expect(woken).toEqual(['local:2'])
    expect((await worker.call('read_inbox')).messages.map(m => m.text)).toEqual(['로그인 화면 고쳐 줘'])
    expect((await worker.call('send_receipt', { message_id: id, text: '작업 할당 받았습니다' })).error).toBeNull()

    const inbox = (await lead.call('read_inbox')).messages
    expect(inbox).toMatchObject([{ text: '작업 할당 받았습니다', receipt: true, replyTo: id }])
    expect(messages.unhandledFor('local:2')).toEqual([id])

    await worker.call('reply_to_message', { message_id: id, text: '고쳤습니다' })
    expect(woken).toEqual(['local:2', 'local:1'])
    expect(messages.unhandledFor('local:2')).toEqual([])
    expect((await lead.call('read_inbox')).messages.map(m => m.text)).toEqual(['고쳤습니다'])
  }, 15000)

  it('are read once the sender has seen them in the inbox', async () => {
    const { lead, worker, id } = await pair()
    expect((await lead.listTools()).tools.map(tool => tool.name)).not.toContain('wait_for_message')
    await worker.call('send_receipt', { message_id: id, text: '작업 중인 일을 마치고 하겠습니다' })
    expect((await lead.call('read_inbox')).messages).toHaveLength(1)
    expect((await lead.call('read_inbox')).messages).toEqual([])
    expect(messages.snapshot().messages.find(m => m.receipt)).toMatchObject({ read: true })
  }, 15000)

  it('do not wake the sender and cannot be answered', async () => {
    const { lead, worker, id } = await pair()
    woken.length = 0
    await worker.call('send_receipt', { message_id: id, text: '받았습니다' })
    expect(woken).toEqual([])
    expect(messages.unreadFor('local:1')).toEqual([])
    const receipt = messages.snapshot().messages.find(m => m.receipt).id
    expect((await lead.call('send_receipt', { message_id: receipt, text: '확인' })).error).toBeTruthy()
    expect((await lead.call('reply_to_message', { message_id: receipt, text: '확인' })).error).toBeTruthy()
  }, 15000)

  it('only answer a message sent to the one confirming', async () => {
    const { lead, id } = await pair()
    expect((await lead.call('send_receipt', { message_id: id, text: '받았습니다' })).error).toBeTruthy()
  }, 15000)
})
