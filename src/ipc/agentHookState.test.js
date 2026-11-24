import { describe, expect, it } from 'vitest'
import { createAgentHookState, hookStatus, applyAgentHook, reconcileAgentHook } from './agentHookState.js'

function harness(kind = 'claude') {
  const state = createAgentHookState(kind)
  const report = (event, startedAt, properties = {}, options) =>
    applyAgentHook(state, { event, startedAt, ...properties }, startedAt + 10, options)
  const check = (now, properties = {}) => reconcileAgentHook(state, { now, screenBlocked: false, ...properties })
  return { state, report, check, status: () => hookStatus(state) }
}

describe('official hook state', () => {
  it('keeps an open turn through compact and changes session identity only on the new start', () => {
    const { report, status, state } = harness()
    report('SessionStart', 100, { sessionId: 'a' })
    expect(status()).toBe('idle')
    report('UserPromptSubmit', 200, { sessionId: 'a', promptId: 'first' })
    report('PreCompact', 250, { sessionId: 'a', promptId: 'first' })
    report('SessionStart', 300, { sessionId: 'b', source: 'compact' })
    report('PostCompact', 350, { sessionId: 'b', promptId: 'first' })
    report('UserPromptSubmit', 400, { sessionId: 'b', promptId: 'first' })
    expect(state.sessionId).toBe('b')
    expect(state.turn).toEqual({ id: 'first', startedAt: 200 })
    expect(status()).toBe('working')
    report('SessionStart', 150, { sessionId: 'a' })
    report('Stop', 450, { sessionId: 'a', promptId: 'first' })
    expect(state.sessionId).toBe('b')
    expect(status()).toBe('working')
    report('Stop', 500, { sessionId: 'b', promptId: 'first' })
    expect(status()).toBe('idle')
    report('PreCompact', 550, { sessionId: 'b' })
    expect(status()).toBe('working')
    report('PostCompact', 600, { sessionId: 'b' })
    expect(status()).toBe('idle')
  })

  it('ignores late turns and tools, and closes all dialogs on the next turn', () => {
    const { report, status, state } = harness()
    report('Stop', 400, { promptId: 'first' })
    report('UserPromptSubmit', 100, { promptId: 'first' })
    report('PreToolUse', 200, { promptId: 'first', toolUseId: 'tool1', tool: 'AskUserQuestion' })
    report('PostToolUse', 300, { promptId: 'first', toolUseId: 'tool1' })
    expect(status()).toBe('idle')
    report('UserPromptSubmit', 500, { promptId: 'second' })
    report('PostToolUseFailure', 800, { promptId: 'second', toolUseId: 'tool2' })
    report('PermissionRequest', 700, { promptId: 'second', toolUseId: 'tool2' })
    expect(status()).toBe('working')
    report('PermissionRequest', 900, { promptId: 'second', toolUseId: 'open' })
    report('UserPromptSubmit', 920, { promptId: 'second' })
    expect(status()).toBe('blocked')
    report('UserPromptSubmit', 1000, { promptId: 'third' })
    report('Stop', 1100, { promptId: 'second' })
    expect(state.turn.id).toBe('third')
    expect(state.dialogs.size).toBe(0)
    expect(status()).toBe('working')
  })

  it('keeps a stop blocked by ezShell working and closes it on the next Stop', () => {
    const { report, status, state } = harness()
    report('UserPromptSubmit', 100, { promptId: 'first' })
    report('Stop', 300, { promptId: 'first' }, { stopBlocked: true })
    expect(status()).toBe('working')
    expect(state.turn.id).toBe('first')
    report('Stop', 500, { promptId: 'first', stopHookActive: true })
    expect(status()).toBe('idle')
  })

  it('uses Claude title timeouts and reopens a Stop while the spinner continues', () => {
    const { report, check, status, state } = harness()
    report('UserPromptSubmit', 100, { promptId: 'first' })
    const idle = { title: { status: 'idle', since: 400, at: 400 } }
    expect(check(600, idle)).toBe(3400)
    expect(status()).toBe('working')
    check(3400, idle)
    expect(status()).toBe('idle')
    report('UserPromptSubmit', 2000, { promptId: 'first' })
    expect(status()).toBe('idle')
    report('UserPromptSubmit', 4000, { promptId: 'second' })
    report('Stop', 5000, { promptId: 'second' })
    const spinner = { title: { status: 'working', since: 4100, at: 6000 } }
    expect(check(6999, spinner)).toBe(7010)
    check(7010, spinner)
    expect(status()).toBe('working')
    expect(state.turn.id).toBe('second')
  })

  it('does not close an open subagent dialog on an idle-looking title', () => {
    const { report, check, status, state } = harness()
    report('UserPromptSubmit', 100, { sessionId: 'parent', promptId: 'parent1' })
    const child = { subagent: true, sessionId: 'child', promptId: 'child1', toolUseId: 'permission' }
    report('PermissionRequest', 200, child)
    expect(state.sessionId).toBe('parent')
    const idle = { title: { status: 'idle', since: 300, at: 300 } }
    check(6000, { ...idle, screenBlocked: true })
    expect(status()).toBe('blocked')
    report('PermissionDenied', 6500, child)
    expect(status()).toBe('working')
    expect(state.turn.id).toBe('parent1')
    report('PermissionRequest', 6600, { ...child, toolUseId: 'other' })
    expect(check(7000, idle)).toBe(12000)
    check(12000, idle)
    expect(status()).toBeNull()
    expect(state.dialogs.size).toBe(0)
  })

  it('reopens a corrected turn for a tool that started after the correction', () => {
    const { report, check, status, state } = harness()
    const turn = { promptId: 'first' }
    report('UserPromptSubmit', 100, turn)
    check(3400, { title: { status: 'idle', since: 400, at: 400 } })
    expect(status()).toBe('idle')
    report('PreToolUse', 3300, { ...turn, toolUseId: 'late' })
    expect(status()).toBe('idle')
    report('PostToolUse', 3500, { ...turn, toolUseId: 'new' })
    expect(status()).toBe('working')
    expect(state.turn?.id).toBe('first')
  })

  it('reopens a turn corrected after Esc when the Claude spinner continues', () => {
    const { report, check, status, state } = harness()
    report('UserPromptSubmit', 100, { promptId: 'first' })
    report('PermissionRequest', 200, { promptId: 'first', toolUseId: 'tool' })
    check(500, { interruptedAt: 300, title: { status: 'idle', since: 400, at: 400 } })
    expect(status()).toBe('idle')
    const spinner = { title: { status: 'working', since: 600, at: 700 } }
    expect(check(2500, spinner)).toBe(2600)
    check(2600, spinner)
    expect(status()).toBe('working')
    expect(state.turn?.id).toBe('first')
  })

  it('applies Esc to the previous turn and gives the next turn its full idle title timeout', () => {
    const { report, check, status, state } = harness()
    const observed = { interruptedAt: 300, title: { status: 'idle', since: 400, at: 400 } }
    report('UserPromptSubmit', 100, { promptId: 'first' })
    expect(check(410, observed)).toBeNull()
    expect(status()).toBe('idle')

    report('UserPromptSubmit', 500, { promptId: 'second' })
    expect(check(510, observed)).toBe(3510)
    expect(check(3509, observed)).toBe(3510)
    expect(status()).toBe('working')
    expect(state.turn?.id).toBe('second')
    expect(check(3510, observed)).toBeNull()
    expect(status()).toBe('idle')
  })

  it('keeps a dialog opened after Esc even when an older dialog is still tracked', () => {
    const { report, check, status, state } = harness()
    const observed = { interruptedAt: 300, title: { status: 'idle', since: 400, at: 400 } }
    report('UserPromptSubmit', 100, { promptId: 'first' })
    report('PermissionRequest', 200, { promptId: 'first', toolUseId: 'old' })
    report('PermissionRequest', 500, { promptId: 'first', toolUseId: 'new' })
    expect(check(510, observed)).toBe(5510)
    expect(status()).toBe('blocked')
    expect(state.dialogs.has('new')).toBe(true)
  })

  it('requires a dismissed dialog after Esc, and ignores titles and sleeping SessionEnd for Codex', () => {
    const { report, check, status } = harness()
    report('UserPromptSubmit', 100, { promptId: 'first' })
    report('PermissionRequest', 200, { promptId: 'first', toolUseId: 'p' })
    const observed = { interruptedAt: 300, title: { status: 'idle', since: 400, at: 400 } }
    check(500, { ...observed, screenBlocked: true })
    expect(status()).toBe('blocked')
    check(700, observed)
    expect(status()).toBe('idle')

    const codex = harness('codex')
    codex.report('UserPromptSubmit', 100, { promptId: 'first' })
    codex.check(5000, observed)
    codex.report('SessionEnd', 5500, {}, { sleeping: true })
    expect(codex.status()).toBe('working')
    codex.report('Interrupt', 6000, { promptId: 'first' })
    expect(codex.status()).toBe('idle')
  })
})
