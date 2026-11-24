import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentMessages } from './agentMessages.js'
import { rpc } from './agentMessageCli.js'
import { PROMPT } from './agentInboxPrompts.js'

const sessionId = '550e8400-e29b-41d4-a716-446655440000'
const promptId = '550e8400-e29b-41d4-a716-446655440001'
const event = { kind: 'claude', event: 'UserPromptSubmit', sessionId, promptId, startedAt: 1620000000000 }
let messages

async function setup(options = {}) {
  const notify = vi.fn()
  const isLocked = vi.fn(() => false)
  messages = createAgentMessages({ notify, isLocked, ...options })
  await messages.ready()
  const claude = messages.register('claude', 'local:1', '.', {})
  const codex = messages.register('codex', 'local:2', '.', {})
  const managed = agent => ({ pipe: agent.env.EZSHELL_AGENT_PIPE, token: agent.env.EZSHELL_AGENT_TOKEN })
  return { claude, codex, isLocked, notify, managed }
}

afterEach(() => messages?.stop())

describe('agent hook reports on the message pipe', () => {
  it('records only permitted fields and leaves renderer state and notifications alone', async () => {
    const { claude, notify, managed } = await setup()
    const before = messages.snapshot()
    notify.mockClear()
    const report = { method: 'agent-event', ...event, prompt: 'private text', cwd: '/secret', tool_input: { command: 'private' } }
    expect(await rpc(report, managed(claude))).toEqual({ success: true, stored: true })
    expect(messages.hookEventsOf(claude.env.EZSHELL_AGENT_ID)).toEqual([event])
    expect(messages.snapshot()).toEqual(before)
    expect(notify).not.toHaveBeenCalled()
    claude.finish(0)
    expect(messages.hookEventsOf(claude.env.EZSHELL_AGENT_ID)).toEqual([])
  })

  it('routes shell tokens to their own active CLI and checks provider for agent tokens', async () => {
    const { claude, codex, managed } = await setup()
    const shell = messages.registerShell('local:2')
    const options = { pipe: shell.EZSHELL_AGENT_PIPE, token: 'shell' }
    const withShell = { shellToken: shell.EZSHELL_SHELL_TOKEN, method: 'agent-event', ...event }
    expect(await rpc(withShell, options)).toMatchObject({ stored: false })
    expect(await rpc({ ...withShell, kind: 'codex', promptId: 'turn-1' }, options)).toMatchObject({ stored: true })
    expect(messages.hookEventsOf(codex.env.EZSHELL_AGENT_ID)).toEqual([{ ...event, kind: 'codex', promptId: 'turn-1' }])
    expect(messages.hookEventsOf(claude.env.EZSHELL_AGENT_ID)).toEqual([])
    expect(await rpc({ method: 'agent-event', ...event }, managed(codex))).toMatchObject({ stored: false })
    expect(await rpc(withShell, { ...options, token: 'different' })).toMatchObject({ stored: false })
    messages.forgetShell('local:2')
    expect(await rpc(withShell, options)).toMatchObject({ success: false })
  })

  it('rejects malformed events, foreign credentials, and reports while locked', async () => {
    const { claude, managed, isLocked } = await setup()
    const options = managed(claude)
    for (const extra of [{ sessionId: '/path' }, { promptId: 'prompt text' }, { startedAt: -2 },
      { event: 'SubagentStart' }, { event: 'Notification', notification: 'arbitrary' }, { toolUseId: 'tool/123' }]) {
      expect(await rpc({ method: 'agent-event', ...event, ...extra }, options)).toMatchObject({ stored: false })
    }
    expect(await rpc({ method: 'agent-event', ...event }, { ...options, token: 'foreign' })).toMatchObject({ success: false })
    const shell = messages.registerShell('local:1')
    isLocked.mockReturnValue(true)
    expect(await rpc({ method: 'agent-event', ...event }, options)).toMatchObject({ success: false })
    const shellReport = { method: 'stop-check', ...event, event: 'Stop', shellToken: shell.EZSHELL_SHELL_TOKEN }
    expect(await rpc(shellReport, { ...options, token: 'shell' })).toMatchObject({ success: false })
    expect(messages.hookEventsOf(claude.env.EZSHELL_AGENT_ID)).toEqual([])
  })

  it('accepts authenticated Stop checks while leaving the turn alone', async () => {
    const { claude, managed } = await setup()
    const before = messages.snapshot()
    const options = managed(claude)
    expect(await rpc({ method: 'stop-check', ...event }, options)).toMatchObject({ stored: false })
    expect(await rpc({ method: 'stop-check', ...event, event: 'Stop', stopHookActive: false }, options)).toEqual({ success: true, block: null })
    expect(messages.hookEventsOf(claude.env.EZSHELL_AGENT_ID)).toEqual([])
    expect(messages.snapshot()).toEqual(before)
  })

  it('runs the stop policy only for the latest recorded Stop with the exact prompt and timestamp', async () => {
    const onAgentHook = vi.fn(() => ({ block: PROMPT }))
    const { claude, managed } = await setup({ onAgentHook })
    const first = { ...event, event: 'Stop' }
    const latest = { ...first, startedAt: first.startedAt + 5 }
    const options = managed(claude)
    const record = stop => rpc({ ...stop, method: 'agent-event', checkStop: true }, options)
    const check = stop => rpc({ ...stop, method: 'stop-check' }, options)
    await record(first)
    await record(latest)
    expect(await check(first)).toMatchObject({ block: null })
    expect(await check({ ...latest, promptId: sessionId })).toMatchObject({ block: null })
    expect(await check(latest)).toMatchObject({ block: PROMPT })
    expect(await check(latest)).toMatchObject({ block: null })
    expect(onAgentHook.mock.calls).toEqual([
      ['local:1', claude.env.EZSHELL_AGENT_ID, first, { checkStop: false }],
      ['local:1', claude.env.EZSHELL_AGENT_ID, latest, { checkStop: true }]
    ])
  })

  it('keeps usage tied to the current official session after a session switch', async () => {
    const { claude } = await setup()
    const id = claude.env.EZSHELL_AGENT_ID
    const usage = { agent: 'claude', model: 'Claude', sessionId }
    messages.setHookSession(id, sessionId)
    expect(messages.setUsage(id, usage)).toBe(true)
    messages.setHookSession(id, promptId)
    expect(messages.hookSessionOf(id)).toBe(promptId)
    expect(messages.usageSnapshot()).toEqual([])
    expect(messages.setUsage(id, usage)).toBe(false)
    expect(messages.setUsage(id, { ...usage, sessionId: null })).toBe(true)
    expect(messages.usageSnapshot()[0].usage.sessionId).toBe(promptId)
  })

  it('keeps the role and resume ID tied to the verified session when a hook names a different one', async () => {
    await setup()
    const registration = messages.register('codex', 'local:3', '.', {}, sessionId)
    const id = registration.env.EZSHELL_AGENT_ID
    messages.setUserRole(id, '리뷰어')
    messages.setHookSession(id, promptId)
    expect(messages.snapshot().agents.find(agent => agent.id === id)).toMatchObject({ resumeId: sessionId, role: '리뷰어' })
    registration.finish(0)
    const other = messages.register('codex', 'local:4', '.', {}, promptId)
    expect(messages.snapshot().agents.find(agent => agent.id === other.env.EZSHELL_AGENT_ID).role).toBeNull()
    const resumed = messages.register('codex', 'local:5', '.', {}, sessionId)
    expect(messages.snapshot().agents.find(agent => agent.id === resumed.env.EZSHELL_AGENT_ID).role).toBe('리뷰어')
  })
})
