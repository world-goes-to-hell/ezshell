import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { createAgentBridge, agentName, folderNameOf, phoneText, ANSWER_ARM_MS, MAX_CHATS_PER_DEVICE } from './agentBridge.js'

function setup({ kind = 'claude', status = 'idle', approval = null, shellCount = 1, projects } = {}) {
  let clock = 1_000
  const state = { kind, status, agentId: `${kind}-3`, sessionId: 'session-1', approval, exited: false }
  const ids = Array.from({ length: shellCount }, (_, index) => `local:${index + 1}`)
  const local = {
    list: () => ids.map(id => ({ id, cwd: 'D:\\work\\app', exited: state.exited, agent: state.kind })),
    agentOf: (id) => (ids.includes(id) && state.kind ? { kind: state.kind, status: state.status, sessionId: state.sessionId, cwd: 'D:\\work\\app' } : null),
    chatAgentId: (id) => (ids.includes(id) ? state.agentId : null),
    approvalOf: () => state.approval,
    chatSend: vi.fn(async () => ({ ok: true })),
    answerApproval: vi.fn(async () => ({ ok: true })),
    interruptAgent: vi.fn(() => true)
  }
  const frames = new Map()
  const chats = {
    open: vi.fn((shellId, { viewer, onFrame }) => { frames.set(viewer, onFrame); return { ok: true } }),
    older: vi.fn(async () => {}),
    close: vi.fn((shellId, viewer) => frames.delete(viewer)),
    closeViewer: vi.fn((viewer) => frames.delete(viewer)),
    isOpen: (shellId, viewer) => frames.has(viewer)
  }
  const flags = { enabled: true, locked: false }
  const bridge = createAgentBridge({
    shells: () => local,
    chats,
    agents: () => [{ id: state.agentId, active: true, role: '리뷰어', cwd: 'D:\\work\\app' }],
    projects,
    isLocked: () => flags.locked,
    isEnabled: () => flags.enabled,
    now: () => clock
  })
  return { bridge, local, chats, frames, state, flags, tick: (ms) => { clock += ms } }
}

describe('agentBridge helpers', () => {
  it('names an agent like the PC and sends only the folder name', () => {
    expect(agentName('codex', 'codex-9')).toBe('Codex 9')
    expect(agentName('claude', null)).toBe('Claude Code')
    expect(folderNameOf('D:\\work\\ezshell\\')).toBe('ezshell')
    expect(folderNameOf('/home/me/app')).toBe('app')
    expect(folderNameOf('')).toBeNull()
  })

  it('refuses slash commands, Claude\'s shell mode and control characters from a phone', () => {
    expect(phoneText('  /clear').error).toBeTruthy()
    expect(phoneText('!rm -rf /').error).toBeTruthy()
    expect(phoneText('hi\x1b[201~').error).toBeTruthy()
    expect(phoneText('어떻게 됐어?').text).toBe('어떻게 됐어?')
  })
})

describe('createAgentBridge', () => {
  it('lists the agents with their role, status and folder name, and nothing while off or locked', () => {
    const { bridge, flags, state } = setup({ status: 'working' })
    expect(bridge.list()).toEqual([{ shellId: 'local:1', agentId: 'claude-3', kind: 'claude', name: 'Claude Code 3', role: '리뷰어', status: 'working',
      folderName: 'app', project: { id: expect.stringMatching(/^[\w-]{43}$/), name: 'app' }, waitingApproval: false }])
    state.approval = { signature: 's' }
    expect(bridge.list()[0].waitingApproval).toBe(true)
    flags.enabled = false
    expect(bridge.list()).toEqual([])
    flags.enabled = true
    flags.locked = true
    expect(bridge.list()).toEqual([])
  })

  it('groups a registered project with its linked worktree and uses the deepest matching project', () => {
    const root = path.resolve('projects', 'app')
    const worktree = path.resolve('projects', 'app-feature')
    const nested = path.join(root, 'nested')
    const other = path.resolve('other', 'app')
    const { local, bridge } = setup({
      shellCount: 4,
      projects: () => [
        { key: root, name: 'app', worktrees: [root, worktree] },
        { key: nested, name: 'nested', worktrees: [nested] }
      ]
    })
    const originalList = local.list
    local.list = () => originalList().map((entry, index) => ({
      ...entry, cwd: [root, path.join(worktree, 'src'), nested, other][index]
    }))
    const projects = bridge.list().map(row => row.project)
    expect(projects.map(project => project.name)).toEqual(['app', 'app', 'nested', 'app'])
    expect(projects[0]).toEqual(projects[1])
    expect(projects[0].id).not.toBe(projects[3].id)
    expect(bridge.list().map(row => row.project)).toEqual(projects)
  })

  it('sends a line through chatSend only for the chat the device opened, with the same agent', async () => {
    const { bridge, local, state } = setup()
    expect(await bridge.send('v1', 'local:1', 'hi')).toMatchObject({ ok: false })
    expect(bridge.open('v1', 'local:1', vi.fn())).toEqual({ ok: true })
    expect(await bridge.send('v1', 'local:1', 'hi')).toEqual({ ok: true })
    expect(local.chatSend).toHaveBeenCalledWith('local:1', 'hi', undefined, undefined, expect.any(Function))
    expect(await bridge.send('v1', 'local:1', '/compact')).toMatchObject({ ok: false })
    // Another agent took the shell: refused
    state.agentId = 'claude-4'
    expect(await bridge.send('v1', 'local:1', 'hi')).toMatchObject({ ok: false, error: expect.stringContaining('바뀌었습니다') })
    expect(local.chatSend).toHaveBeenCalledTimes(1)
  })

  it('refuses a shell id that is not an open local shell', async () => {
    const { bridge, state } = setup()
    expect(bridge.open('v1', 'local:9', vi.fn())).toMatchObject({ ok: false })
    expect(bridge.open('v1', '../x', vi.fn())).toMatchObject({ ok: false })
    bridge.open('v1', 'local:1', vi.fn())
    state.exited = true
    expect(await bridge.send('v1', 'local:1', 'hi')).toMatchObject({ ok: false })
  })

  it('answers only the prompt this device was sent, and not in its first moment', async () => {
    const approval = { signature: 'sig', options: [{ key: '1', label: 'Yes' }] }
    const { bridge, local, frames, tick } = setup({ approval })
    bridge.open('v1', 'local:1', vi.fn())
    expect(await bridge.answer('v1', 'local:1', '1', 'sig')).toMatchObject({ ok: false })
    frames.get('v1')({ shellId: 'local:1', approval })
    expect(await bridge.answer('v1', 'local:1', '1', 'sig')).toMatchObject({ ok: false, error: expect.stringContaining('확인한 뒤') })
    tick(ANSWER_ARM_MS)
    expect(await bridge.answer('v1', 'local:1', '1', 'other')).toMatchObject({ ok: false })
    expect(await bridge.answer('v1', 'local:1', 'x', 'sig')).toMatchObject({ ok: false })
    expect(await bridge.answer('v1', 'local:1', '1', 'sig')).toEqual({ ok: true })
    expect(local.answerApproval).toHaveBeenCalledTimes(1)
    // The prompt went away: nothing to answer
    frames.get('v1')({ shellId: 'local:1', approval: null })
    tick(ANSWER_ARM_MS)
    expect(await bridge.answer('v1', 'local:1', '1', 'sig')).toMatchObject({ ok: false })
  })

  it.each(['Yes, and don’t ask again', 'Always allow', 'Allow for this session', '이 세션에서는 다시 묻지 않음', '계속 허용'])
    ('blocks a standing approval from a phone (%s)', async label => {
      const approval = { signature: 'sig', options: [{ key: '1', label: 'Yes' }, { key: '2', label }] }
      const { bridge, local, frames, tick } = setup({ approval })
      const onFrame = vi.fn()
      bridge.open('v1', 'local:1', onFrame)
      frames.get('v1')({ shellId: 'local:1', approval })
      expect(onFrame).toHaveBeenCalledWith({ shellId: 'local:1', approval: { signature: 'sig', options: [
        { key: '1', label: 'Yes' }, { key: '2', label, phoneBlocked: true }
      ] } })
      expect(approval.options[1]).toEqual({ key: '2', label })
      tick(ANSWER_ARM_MS)
      expect(await bridge.answer('v1', 'local:1', '2', 'sig')).toEqual({ ok: false, error: bridge.ERRORS.standing })
      expect(local.answerApproval).not.toHaveBeenCalled()
      expect(await bridge.answer('v1', 'local:1', '1', 'sig')).toEqual({ ok: true })
    })

  it.each([{ agentId: 'claude-4' }, { kind: 'codex' }, { sessionId: 'session-2' }, { sessionId: null }])
    ('closes a device chat before forwarding the replacement frame (%o)', changed => {
      const { bridge, chats, state, frames } = setup()
      const onFrame = vi.fn()
      const onClosed = vi.fn()
      expect(bridge.open('v1', 'local:1', onFrame, onClosed)).toEqual({ ok: true })
      const deliver = frames.get('v1')
      deliver({ shellId: 'local:1', state: 'live' })
      Object.assign(state, changed)
      deliver({ shellId: 'local:1', reset: true })
      deliver({ shellId: 'local:1', items: [] })
      expect(onFrame).toHaveBeenCalledTimes(1)
      expect(chats.close).toHaveBeenCalledWith('local:1', 'v1')
      expect(onClosed).toHaveBeenCalledExactlyOnceWith(bridge.ERRORS.changed)
    })

  it('limits the number of chats per device and frees a slot on close', () => {
    const { bridge } = setup({ shellCount: 5 })
    for (let index = 1; index <= MAX_CHATS_PER_DEVICE; index++) {
      expect(bridge.open('v1', `local:${index}`, vi.fn())).toEqual({ ok: true })
    }
    expect(bridge.open('v1', 'local:5', vi.fn())).toEqual({ ok: false, error: bridge.ERRORS.tooMany })
    expect(bridge.open('v2', 'local:5', vi.fn())).toEqual({ ok: true })
    bridge.close('v1', 'local:1')
    expect(bridge.open('v1', 'local:5', vi.fn())).toEqual({ ok: true })
  })

  it('binds the first real conversation id and drops frames after access is disabled', async () => {
    const { bridge, local, state, frames, flags } = setup()
    state.sessionId = null
    const onFrame = vi.fn()
    const onClosed = vi.fn()
    bridge.open('v1', 'local:1', onFrame, onClosed)
    state.sessionId = 'identified'
    expect(await bridge.send('v1', 'local:1', 'hello')).toEqual({ ok: true })
    const guard = local.chatSend.mock.calls[0][4]
    state.sessionId = 'changed'
    expect(guard()).toBe(false)
    state.sessionId = 'identified'
    flags.enabled = false
    frames.get('v1')({ shellId: 'local:1', reset: true })
    expect(onFrame).not.toHaveBeenCalled()
    expect(onClosed).toHaveBeenCalledExactlyOnceWith(bridge.ERRORS.off)
  })

  it('keeps Antigravity to plain text while idle, and its prompts and stopping to the PC terminal', async () => {
    const { bridge, local, state } = setup({ kind: 'antigravity' })
    bridge.open('v1', 'local:1', vi.fn())
    expect(await bridge.send('v1', 'local:1', 'hi')).toEqual({ ok: true })
    state.status = 'working'
    expect(await bridge.send('v1', 'local:1', 'hi')).toMatchObject({ ok: false, reason: 'busy' })
    expect(bridge.interrupt('v1', 'local:1')).toMatchObject({ ok: false })
    expect(await bridge.answer('v1', 'local:1', '1', 'sig')).toMatchObject({ ok: false })
    expect(local.interruptAgent).not.toHaveBeenCalled()
  })

  it('stops a turn for a Claude or Codex chat, and lets go of a device\'s chats when it leaves', () => {
    const { bridge, local, chats } = setup({ kind: 'codex' })
    bridge.open('v1', 'local:1', vi.fn())
    expect(bridge.interrupt('v1', 'local:1')).toEqual({ ok: true })
    expect(local.interruptAgent).toHaveBeenCalledWith('local:1')
    bridge.closeViewer('v1')
    expect(chats.closeViewer).toHaveBeenCalledWith('v1')
    expect(bridge.interrupt('v1', 'local:1')).toMatchObject({ ok: false })
  })
})
