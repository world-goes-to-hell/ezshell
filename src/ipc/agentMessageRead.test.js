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
  const registration = messages.register(kind, shellId, root, {})
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
    return { error: result.isError ? result.content[0].text : null, ...(result.isError ? {} : JSON.parse(result.content[0].text)) }
  }
  // Ready once its MCP connection is counted
  await vi.waitFor(async () => expect((await call('list_agents')).self).toBe(env.EZSHELL_AGENT_ID))
  return { id: env.EZSHELL_AGENT_ID, call, listTools: () => client.listTools(), finish: registration.finish }
}

async function pair(options = {}) {
  messages = createAgentMessages({
    notify: (channel, payload) => { if (channel === 'agent-messages-state') states.push(payload) },
    isLocked: () => false,
    onInboxChanged: shell => woken.push(shell),
    ...options
  })
  await messages.ready()
  const lead = await agent('claude', 'local:1')
  const worker = await agent('codex', 'local:2')
  woken.length = 0
  const { id } = await lead.call('send_message', { to: worker.id, text: '로그인 화면 고쳐 줘' })
  return { lead, worker, id }
}

const statusOf = async (agentClient, id) => (await agentClient.call('check_sent', { message_ids: [id] })).messages[0]

describe('agent inspection and escalation', () => {
  it('reports only public screen fields and notifies once per verified human prompt', async () => {
    let locked = false
    let ticket = Symbol()
    let blocked = { kind: 'approval', question: 'Ask?\nSECRET', options: ['🙂'.repeat(220), 'No'], detail: 'SECRET' }
    const onEscalate = vi.fn(() => true)
    const { lead, worker } = await pair({
      isLocked: () => locked,
      inspectLocalAgent: (_shellId, id) => id === 'codex-2' ? { status: 'blocked', statusSource: 'screen', blocked, ticket } : null,
      onEscalate
    })
    const tools = (await lead.listTools()).tools.map(tool => tool.name)
    expect(tools).toEqual(expect.arrayContaining(['inspect_agent', 'escalate']))
    const target = { id: worker.id }
    expect(await lead.call('inspect_agent', target)).toEqual({
      error: null, id: worker.id, status: 'blocked', statusSource: 'screen',
      blocked: { kind: 'approval', question: 'Ask?', options: ['🙂'.repeat(200), 'No'] },
      unread: 1, idleFor: null, exitCode: null
    })
    expect(await lead.call('escalate', { ...target, reason: 'Needs a decision' })).toMatchObject({ notified: true })
    expect(await worker.call('escalate', { ...target, reason: 'The same prompt' })).toMatchObject({ notified: false })
    expect(onEscalate).toHaveBeenCalledExactlyOnceWith({ id: worker.id, shellId: 'local:2', kind: 'approval' })
    expect((await lead.call('escalate', { ...target, reason: 'Line 1\nLine 2' })).error).toBeTruthy()
    blocked = { kind: 'draft', ours: false, text: 'SECRET' }
    expect((await lead.call('inspect_agent', target)).blocked).toEqual({ kind: 'draft', ours: false })
    expect((await lead.call('escalate', { ...target, reason: 'Draft' })).error).toBeTruthy()
    blocked = { kind: 'question', question: 'Which option?' }
    ticket = Symbol()
    expect(await lead.call('escalate', { ...target, reason: 'New question' })).toMatchObject({ notified: true })
    locked = true
    expect((await lead.call('inspect_agent', target)).error).toMatch(/잠금/)
    expect((await lead.call('escalate', { ...target, reason: 'Locked' })).error).toMatch(/잠금/)
    expect(onEscalate).toHaveBeenCalledTimes(2)
    locked = false
    worker.finish(2)
    expect(await lead.call('inspect_agent', target)).toMatchObject({ status: 'error', blocked: { kind: 'ended' }, exitCode: 2 })
    expect((await lead.call('inspect_agent', { id: 'codex-999' })).error).toBeTruthy()
  }, 15000)
})

describe('read marks', () => {
  it('lists effective roles, keeps agent changes under the user override, and clears the override', async () => {
    const { lead, worker } = await pair()
    expect((await worker.listTools()).tools.map(tool => tool.name)).toContain('set_role')
    expect(await worker.call('set_role', { role: '  리뷰어 ', agent_id: lead.id })).toMatchObject({ id: worker.id, role: '리뷰어', roleSource: 'agent' })
    expect((await lead.call('list_agents')).agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: lead.id, role: null }), expect.objectContaining({ id: worker.id, role: '리뷰어' })
    ]))
    expect(messages.setUserRole(worker.id, '보내기 구현')).toMatchObject({ role: '보내기 구현', roleSource: 'user' })
    expect(await worker.call('set_role', { role: '검토' })).toMatchObject({ role: '보내기 구현', roleSource: 'user' })
    expect(states.at(-1).agents.find(item => item.id === worker.id)).toMatchObject({ role: '보내기 구현', roleSource: 'user' })
    expect(messages.setUserRole(worker.id, '')).toMatchObject({ role: '검토', roleSource: 'agent' })
    expect(await worker.call('set_role', { role: '' })).toMatchObject({ role: null, roleSource: null })
  }, 15000)

  it('rejects invisible and invalid Unicode in both role setters and enforces the 20-code-point limit', async () => {
    const { worker } = await pair()
    const invalid = ['역할\n두 줄', '\t들여쓰기', '숨김\u202E', '제어\u0085문자', '역할\u2028이름',
      '리뷰' + String.fromCodePoint(0xe0020), '리뷰\u200B', '리뷰\u2060', '\uFEFF리뷰',
      '리뷰\u00AD', '리뷰\uE000', '리뷰\u0378', '리뷰\uD800']
    for (const role of invalid) {
      expect((await worker.call('set_role', { role })).error).toMatch(/제어 문자/)
      expect(() => messages.setUserRole(worker.id, role)).toThrow(/제어 문자/)
    }
    expect((await worker.call('set_role', { role: '🙂'.repeat(21) })).error).toMatch(/20자/)
    expect(await worker.call('set_role', { role: '🙂'.repeat(20) })).toMatchObject({ role: '🙂'.repeat(20) })
  }, 15000)

  it('rejects self-assigned ID lookalikes and reserved names', async () => {
    const { worker } = await pair()
    for (const role of ['나', '사 용 자', 'Ｕｓｅｒ', 'e z S H E L L', 'Claude-1', 'ＣＯＤＥＸ－２',
      'Antigravity - ４', '\u1102 \u1161', 'claude–1', 'codex—2', 'antigravity_3', 'claude1', 'codex−2',
      'сlaude-1', 'ϲlaude-1', 'ϹLAUDE２', 'cοdеx—２', 'Αntіgravity _ 3', 'ANTІGRAVITY-3',
      'Ꮯlaude_١', 'claude\uFE0F-1', '사용자님', '사 용 자-님', '나예요', 'uѕer', 'ezѕhell']) {
      expect((await worker.call('set_role', { role })).error).toMatch(/예약 이름/)
    }
    for (const role of ['코드 리뷰', 'Codex 검토 2', 'UI 설계', 'Ревью 2', 'Έλεγχος 3', '문서–검토']) {
      expect(await worker.call('set_role', { role })).toMatchObject({ role, roleSource: 'agent' })
    }
    expect(messages.setUserRole(worker.id, 'сlaude–1')).toMatchObject({ role: 'сlaude–1', roleSource: 'user' })
    expect(messages.setUserRole(worker.id, '나')).toMatchObject({ role: '나', roleSource: 'user' })
  }, 15000)

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
