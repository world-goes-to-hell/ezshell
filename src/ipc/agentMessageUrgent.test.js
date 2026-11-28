import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createAgentMessages } from './agentMessages.js'
import { isInboxPrompt, urgentPrompt } from './agentInboxPrompts.js'

// send_message with urgent (2026-11-28 user request): a busy recipient otherwise reads mail only when its
// task ends. An urgent message also goes into its chat right away (main: onUrgentMessage → chatSend).
let root
let messages
const clients = []
const woken = []
const urgent = []

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-urgent-test-'))
  woken.length = 0
  urgent.length = 0
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
  await vi.waitFor(async () => expect((await call('list_agents')).self).toBe(env.EZSHELL_AGENT_ID))
  return { id: env.EZSHELL_AGENT_ID, call }
}

async function pair() {
  messages = createAgentMessages({
    notify: () => {},
    isLocked: () => false,
    onInboxChanged: shell => woken.push(shell),
    onUrgentMessage: request => urgent.push(request)
  })
  await messages.ready()
  const lead = await agent('claude', 'local:1')
  const worker = await agent('codex', 'local:2')
  woken.length = 0
  return { lead, worker }
}

describe('urgent agent messages', () => {
  it('hands an urgent message to the recipient\'s chat as well as its inbox', async () => {
    const { lead, worker } = await pair()
    const { id } = await lead.call('send_message', { to: worker.id, text: '공유 파일 수정 멈춰 줘', urgent: true })
    expect(woken).toEqual(['local:2'])
    expect(urgent).toEqual([{ shellId: 'local:2', agentId: worker.id, messageId: id }])
    const [message] = (await worker.call('read_inbox')).messages
    expect(message).toMatchObject({ id, urgent: true })
  })

  it('leaves a normal message to the usual notice', async () => {
    const { lead, worker } = await pair()
    await lead.call('send_message', { to: worker.id, text: '시간 날 때 봐 줘' })
    expect(woken).toEqual(['local:2'])
    expect(urgent).toEqual([])
    expect((await worker.call('read_inbox')).messages[0].urgent).toBeUndefined()
  })

  it('treats a retry with a different urgency as a different request', async () => {
    const { lead, worker } = await pair()
    const first = await lead.call('send_message', { to: worker.id, text: '멈춰', request_id: 'retry-1' })
    expect(first.error).toBeNull()
    const again = await lead.call('send_message', { to: worker.id, text: '멈춰', request_id: 'retry-1', urgent: true })
    expect(again.error).toMatch('같은 요청 ID')
    expect(urgent).toEqual([])
  })
})

describe('the urgent notice', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  it('names the message, asks to pause the current task, and shows as an inbox notice', () => {
    expect(urgentPrompt(id)).toBe(`Urgent ezShell message ${id}: pause your current task, read it now with read_inbox and handle it first.`)
    expect(isInboxPrompt(urgentPrompt(id))).toBe(true)
    expect(isInboxPrompt(urgentPrompt(id) + ' and more')).toBe(false)
    expect(() => urgentPrompt('stop; rm -rf')).toThrow()
  })
})
