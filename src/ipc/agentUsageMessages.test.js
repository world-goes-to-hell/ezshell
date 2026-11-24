import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentMessages } from './agentMessages.js'
import { rpc } from './agentMessageCli.js'

// Usage reports from a launched Claude's status line arrive over the agent pipe with its token
let messages
let root

afterEach(() => {
  messages?.stop()
  messages = undefined
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

const usage = { agent: 'claude', model: 'Opus 5.5', effort: 'high', sessionId: null, context: { percent: 38, size: 1000000 }, fiveHour: { percent: 23, resetsAt: 1795000000000 }, sevenDay: null }

async function setup({ codexDeclined = false } = {}) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-agent-usage-test-'))
  const codexHookTrustFile = path.join(root, 'codex-hook-mode')
  if (codexDeclined) fs.writeFileSync(codexHookTrustFile, 'disabled\n')
  const sent = []
  messages = createAgentMessages({ roleFile: path.join(root, 'agent-roles.json'), codexHookTrustFile,
    notify: (channel, payload) => sent.push({ channel, payload }), isLocked: () => false })
  await messages.ready()
  const claude = messages.register('claude', 'local:1', root, {})
  return { sent, claude }
}

describe('usage reports', () => {
  it('are stored for the reporting agent and sent to the window once per change', async () => {
    const { sent, claude } = await setup()
    const lease = { pipe: claude.env.EZSHELL_AGENT_PIPE, token: claude.env.EZSHELL_AGENT_TOKEN }
    expect(await rpc({ method: 'usage', usage }, lease)).toMatchObject({ success: true, stored: true })
    await rpc({ method: 'usage', usage }, lease)
    const reports = sent.filter(item => item.channel === 'agent-usage')
    expect(reports).toEqual([{ channel: 'agent-usage', payload: { agentId: 'claude-1', shellId: 'local:1', usage } }])
    expect(messages.usageSnapshot()).toEqual([{ agentId: 'claude-1', shellId: 'local:1', usage }])
  })

  it('refuse a report of another kind and anything without a known token', async () => {
    const { claude } = await setup()
    const lease = { pipe: claude.env.EZSHELL_AGENT_PIPE, token: claude.env.EZSHELL_AGENT_TOKEN }
    expect(await rpc({ method: 'usage', usage: { ...usage, agent: 'codex' } }, lease)).toMatchObject({ stored: false })
    expect(await rpc({ method: 'usage', usage }, { ...lease, token: 'not-a-token' })).toMatchObject({ success: false })
    expect(messages.usageSnapshot()).toEqual([])
  })

  it('are forgotten when the agent ends, and the window hears of it', async () => {
    const { sent, claude } = await setup()
    await rpc({ method: 'usage', usage }, { pipe: claude.env.EZSHELL_AGENT_PIPE, token: claude.env.EZSHELL_AGENT_TOKEN })
    claude.close()
    expect(messages.usageSnapshot()).toEqual([])
    expect(sent.filter(item => item.channel === 'agent-usage').at(-1).payload).toEqual({ agentId: 'claude-1', shellId: 'local:1', usage: null })
  })

  it('keeps the Codex model and picked effort on usage-only reports from the same session', async () => {
    const { sent } = await setup()
    const id = messages.register('codex', 'local:2', root, {}).env.EZSHELL_AGENT_ID
    const report = { ...usage, agent: 'codex', sessionId: '01a1ec18-9b8a-71c1-839d-2e31c010300f', model: 'gpt-6', effort: 'high' }
    messages.setUsage(id, report)
    messages.applyPicked('local:2', { effort: 'xhigh' })
    messages.setUsage(id, { ...report, model: null, effort: null, context: { percent: 45, size: 1000000 } })

    const latest = sent.filter(item => item.channel === 'agent-usage').at(-1).payload
    expect(latest.usage).toMatchObject({ model: 'gpt-6', effort: 'xhigh', context: { percent: 45 } })
    expect(messages.usageSnapshot()).toEqual([latest])

    messages.setUsage(id, { ...report, model: 'gpt-6-codex', effort: null })
    expect(messages.usageSnapshot()[0].usage).toMatchObject({ model: 'gpt-6-codex', effort: null })

    messages.setUsage(id, { ...report, sessionId: '01a1ec18-9b8a-71c1-839d-2e31c0103010', model: null, effort: null })
    expect(messages.usageSnapshot()[0].usage).toMatchObject({ model: null, effort: null })
  })

  it('take a report by shell token for the Claude typed in that shell (no agent token there)', async () => {
    const { sent, claude } = await setup()
    const shell = messages.registerShell('local:1')
    expect(shell.EZSHELL_SHELL_TOKEN).toBeTruthy()
    expect(shell.EZSHELL_AGENT_SETTINGS).toBe(claude.env.EZSHELL_AGENT_SETTINGS)
    const pipe = shell.EZSHELL_AGENT_PIPE
    expect(await rpc({ method: 'usage', shellToken: shell.EZSHELL_SHELL_TOKEN, usage }, { pipe, token: 'none' })).toMatchObject({ success: true, stored: true })
    expect(sent.filter(item => item.channel === 'agent-usage').at(-1).payload).toMatchObject({ agentId: 'claude-1', shellId: 'local:1' })
    messages.forgetShell('local:1')
    expect(await rpc({ method: 'usage', shellToken: shell.EZSHELL_SHELL_TOKEN, usage }, { pipe, token: 'none' })).toMatchObject({ success: false })
  })

  it('keeps role identity separate from usage reported by an agent or its shell', async () => {
    const { claude } = await setup()
    const id = claude.env.EZSHELL_AGENT_ID
    const ownSession = '01a1ec18-9b8a-71c1-839d-2e31c010300f'
    const otherSession = '01a1ec18-9b8a-71c1-839d-2e31c0103010'
    const other = messages.register('claude', 'local:2', root, {}, otherSession)
    messages.setUserRole(other.env.EZSHELL_AGENT_ID, '다른 대화')
    other.close()
    messages.setUserRole(id, '내 대화')
    const pipe = claude.env.EZSHELL_AGENT_PIPE
    const claimedUsage = { ...usage, sessionId: otherSession }
    const lease = { pipe, token: claude.env.EZSHELL_AGENT_TOKEN }
    expect(await rpc({ method: 'usage', usage: claimedUsage }, lease)).toMatchObject({ stored: true })
    expect(messages.snapshot().agents.find(agent => agent.id === id)?.role).toBe('내 대화')
    messages.setVerifiedSession(id, ownSession)
    const { EZSHELL_SHELL_TOKEN: shellToken } = messages.registerShell('local:1')
    expect(await rpc({ method: 'usage', shellToken, usage: claimedUsage }, { pipe, token: 'none' })).toMatchObject({ stored: true })
    expect(messages.usageSnapshot()[0].usage.sessionId).toBe(otherSession)
    messages.setUserRole(id, '')
    expect(await rpc({ method: 'set-role', role: '내 역할' }, lease)).toMatchObject({ role: '내 역할' })
    expect(JSON.parse(fs.readFileSync(path.join(root, 'agent-roles.json'), 'utf8'))).toEqual({
      [`claude:${ownSession}`]: { agent: '내 역할', usedAt: expect.any(Number) },
      [`claude:${otherSession}`]: { user: '다른 대화', usedAt: expect.any(Number) }
    })
  })

  it('gives a launched or typed Claude the same usage status line and official hooks', async () => {
    const { claude } = await setup()
    const settings = JSON.parse(fs.readFileSync(claude.env.EZSHELL_AGENT_SETTINGS, 'utf8'))
    expect(settings.statusLine.command).toBe('ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" "$EZSHELL_AGENT_USAGE_SCRIPT"')
    expect(fs.existsSync(claude.env.EZSHELL_AGENT_USAGE_SCRIPT)).toBe(true)
    const shell = messages.registerShell('local:typed')
    expect(shell.EZSHELL_AGENT_SETTINGS).toBe(claude.env.EZSHELL_AGENT_SETTINGS)
    expect(shell.EZSHELL_AGENT_HOOK_SCRIPT).toBe(claude.env.EZSHELL_AGENT_HOOK_SCRIPT)
    expect(Object.keys(settings.hooks)).toEqual(expect.arrayContaining(['SessionStart', 'SessionEnd', 'UserPromptSubmit',
      'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PermissionDenied', 'Notification', 'PreCompact', 'PostCompact',
      'PostToolUseFailure', 'Elicitation', 'StopFailure', 'Stop']))
    for (const [event, [config]] of Object.entries(settings.hooks)) {
      expect(config.hooks).toEqual([{ type: 'command', command: 'ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" "$EZSHELL_AGENT_HOOK_SCRIPT" claude',
        ...(event === 'Stop' ? { timeout: 5 } : { async: true }) }])
    }
    expect(settings.hooks.PreToolUse[0].matcher).toBe('*')
    expect(settings.hooks.PostToolUse[0].matcher).toBe('*')
  })

  it('atomically replaces Claude settings and resets a persisted Codex decline only when asked', async () => {
    const { sent, claude } = await setup({ codexDeclined: true })
    const file = claude.env.EZSHELL_AGENT_SETTINGS
    const original = JSON.parse(fs.readFileSync(file, 'utf8'))
    const shell = messages.registerShell('local:typed')
    const runtimeMode = () => fs.readFileSync(shell.EZSHELL_CODEX_HOOK_MODE_FILE, 'utf8').trim()
    expect(messages.configureHooks({ enabled: true })).toEqual({ success: true, codexMode: 'disabled' })
    const rename = vi.spyOn(fs, 'renameSync')
    try {
      expect(messages.configureHooks({ enabled: false })).toEqual({ success: true, codexMode: 'disabled' })
      expect(rename).toHaveBeenCalledWith(expect.stringContaining(file + '.'), file)
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ statusLine: original.statusLine })
      expect(runtimeMode()).toBe('disabled')
      const credentials = { pipe: claude.env.EZSHELL_AGENT_PIPE, token: claude.env.EZSHELL_AGENT_TOKEN }
      expect(await rpc({ method: 'agent-event', kind: 'claude', event: 'SessionStart', startedAt: Date.now() }, credentials))
        .toMatchObject({ stored: false })
      expect(messages.configureHooks({ enabled: true })).toEqual({ success: true, codexMode: 'disabled' })
      expect(messages.configureHooks({ enabled: true, resetCodexDecline: true })).toEqual({ success: true, codexMode: 'pending' })
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(original)
      expect(runtimeMode()).toBe('pending')
      expect(fs.readFileSync(path.join(root, 'codex-hook-mode'), 'utf8').trim()).toBe('pending')
      expect(sent.filter(item => item.channel === 'codex-hooks-declined')).toEqual([])
      messages.setCodexHookMode('disabled')
      messages.setCodexHookMode('disabled')
      expect(sent.filter(item => item.channel === 'codex-hooks-declined')).toHaveLength(1)
    } finally { rename.mockRestore() }
  })
})
