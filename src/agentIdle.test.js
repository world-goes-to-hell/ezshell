import { describe, expect, it, vi } from 'vitest'
import { createAgentIdle, descendants, elapsedSeconds, launchFlags, resumeCommand, runsCommand, words } from './agentIdle.js'
import { createLocalShells } from './localShell.js'

const SESSION = '0f3a8d40-5ff7-4d63-967c-90f524623f87'

describe('the options a resumed agent keeps', () => {
  it('keeps how much it may do and its model, nothing else, with plain values only', () => {
    expect(launchFlags('codex', 'C:\\npm\\codex.exe -c "mcp_servers.x.command=C:\\a b" --no-daemon --yolo -m gpt-6.2 --sandbox workspace-write')).toEqual(['--yolo', '-m', 'gpt-6.2', '--sandbox', 'workspace-write'])
    expect(launchFlags('claude', '"C:\\claude.exe" --settings "C:\\s.json" --dangerously-skip-permissions --model=opus --permission-mode acceptEdits')).toEqual(['--dangerously-skip-permissions', '--model', 'opus', '--permission-mode', 'acceptEdits'])
    // A value that could be more than a word in a shell line is dropped
    expect(launchFlags('claude', 'claude --model "opus; rm -rf ~" --permission-mode $(whoami)')).toEqual([])
    expect(launchFlags('other', '--yolo')).toEqual([])
    expect(words('a "b c" d')).toEqual(['a', 'b c', 'd'])
  })

  it('types only the session id and those options into the shell', () => {
    expect(resumeCommand('claude', SESSION, ['--dangerously-skip-permissions'])).toBe(`claude --resume ${SESSION} --dangerously-skip-permissions`)
    expect(resumeCommand('codex', SESSION, ['--yolo', '; calc'])).toBe(`codex resume ${SESSION} --yolo`)
    expect(() => resumeCommand('claude', 'x; calc')).toThrow()
  })
})

describe('the processes of an idle agent', () => {
  const tree = new Map([
    [10, { parent: 1, name: 'powershell.exe' }],
    [12, { parent: 10, name: 'claude.exe', startedAt: 1_000_000 }],
    // ezShell's messages MCP: in a shell started with the CLI
    [19, { parent: 12, name: 'powershell.exe', startedAt: 1_002_000 }],
    [20, { parent: 12, name: 'node.exe', startedAt: 1_002_000 }],
    [21, { parent: 20, name: 'cmd.exe' }],
    [30, { parent: 99, name: 'bash.exe' }]
  ])

  it('are the CLI and everything under it', () => {
    expect(descendants(tree, 12)).toEqual([12, 19, 20, 21])
  })

  it('run a command of their own when the CLI started a shell later (a background task), not an MCP wrapper', () => {
    expect(runsCommand(tree, 12)).toBe(false)
    expect(runsCommand(new Map([...tree, [31, { parent: 12, name: 'bash.exe', startedAt: 1_300_000 }]]), 12)).toBe(true)
    // Start time not known: taken as a command
    expect(runsCommand(new Map([...tree, [31, { parent: 12, name: 'bash.exe', startedAt: 0 }]]), 12)).toBe(true)
    expect(elapsedSeconds('1-02:03:04')).toBe(93784)
    expect(elapsedSeconds('05:06')).toBe(306)
    expect(elapsedSeconds('x')).toBeNull()
  })
})

describe('what the idle check does', () => {
  function setup(agent, { session = SESSION, background = false } = {}) {
    let time = 0
    const shells = { idleAgents: () => [agent], sleep: vi.fn(async () => ({ ok: true })) }
    const trim = vi.fn(async () => true)
    const tree = new Map([[agent.pid, { parent: 1, name: 'claude.exe', startedAt: 1_000_000 }], [50, { parent: agent.pid, name: background ? 'bash.exe' : 'node.exe', startedAt: 9_000_000 }]])
    const idle = createAgentIdle({
      shells, trim, sessionOf: () => session, processTree: async () => tree,
      commandLine: async () => 'claude.exe --dangerously-skip-permissions', now: () => time, tickMs: 60_000
    })
    return { idle, shells, trim, at: minutes => { time = minutes * 60_000 } }
  }
  const agent = { id: 'local:1', kind: 'claude', external: true, agentId: 'claude-1', pid: 12, activeAt: 0, idle: true }

  it('gives back memory once per idle stretch, then puts the agent to sleep', async () => {
    const { idle, shells, trim, at } = setup({ ...agent })
    idle.configure({ trimMinutes: 10, sleepMinutes: 30 })
    at(5); await idle.tick()
    expect(trim).not.toHaveBeenCalled()
    at(10); await idle.tick()
    at(11); await idle.tick()
    expect(trim).toHaveBeenCalledExactlyOnceWith([12, 50])
    at(30); await idle.tick()
    expect(shells.sleep).toHaveBeenCalledExactlyOnceWith('local:1', { sessionId: SESSION, flags: ['--dangerously-skip-permissions'] })
    idle.stop()
  })

  it('does not sleep an agent with a background command, without a session id, or launched by the app', async () => {
    for (const [target, options] of [[agent, { background: true }], [agent, { session: null }], [{ ...agent, external: false }, {}]]) {
      const { idle, shells, at } = setup({ ...target }, options)
      idle.configure({ trimMinutes: 0, sleepMinutes: 15 })
      at(60); await idle.tick()
      expect(shells.sleep).not.toHaveBeenCalled()
      idle.stop()
    }
  })

  it('does nothing while the agent works, and takes only the listed minutes', async () => {
    const { idle, shells, trim, at } = setup({ ...agent, idle: false })
    expect(idle.configure({ trimMinutes: 5, sleepMinutes: -3 })).toEqual({ trimMinutes: 5, sleepMinutes: 0 })
    at(120); await idle.tick()
    expect(trim).not.toHaveBeenCalled()
    expect(shells.sleep).not.toHaveBeenCalled()
    idle.stop()
  })
})

describe('putting an agent typed into a shell to sleep and waking it', () => {
  const wait = (test, ms = 3000) => vi.waitFor(() => { if (!test()) throw new Error('not yet') }, { timeout: ms, interval: 20 })

  it('closes the CLI with /exit, keeps the shell, and resumes it under the same agent id', async () => {
    const processes = new Map([
      [15, { parent: 13, name: 'electron.exe' }],
      [13, { parent: 12, name: 'node.exe' }],
      [12, { parent: 10, name: 'claude.exe' }]
    ])
    const alive = new Set([12, 13, 15])
    const agents = { sleep: vi.fn(), cancelSleep: vi.fn(), unreadFor: () => [], unhandledFor: () => [] }
    const ptys = []
    const sent = []
    const shells = createLocalShells({
      spawn: () => {
        const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: cb => { pty.emit = cb }, onExit: cb => { pty.exit = cb } }
        ptys.push(pty)
        return pty
      },
      send: (channel, payload) => sent.push({ channel, payload }),
      shell: { file: 'sh', args: [], name: 'sh' }, cwd: '/home', env: {}, agents,
      processTree: async () => processes, processAlive: pid => alive.has(pid)
    })
    const { id } = shells.open()
    const pty = ptys[0]
    pty.pid = 10
    try {
      const attach = await shells.bindAgentProcess({ pid: 15, kind: 'claude' })
      attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit: vi.fn() })
      // Idle (✳ in the title) with an empty composer
      const screen = text => '\x1b[2J\x1b[Hready\r\n' + '─'.repeat(40) + '\r\n> ' + text
      pty.emit('\x1b[?2004h\x1b]0;✳ claude\x07' + screen(''))
      expect(shells.idleAgents()).toEqual([expect.objectContaining({ id, external: true, agentId: 'claude-1', pid: 12, idle: true })])
      // The screen main keeps of the agent draws it a moment later
      await new Promise(done => setTimeout(done, 200))

      const sleeping = shells.sleep(id, { sessionId: SESSION, flags: ['--dangerously-skip-permissions'] })
      await wait(() => pty.write.mock.calls.some(([data]) => data === '\x1b[200~/exit\x1b[201~'))
      expect(agents.sleep).toHaveBeenCalledWith('claude-1', SESSION)
      pty.emit(screen('/exit'))
      await wait(() => pty.write.mock.calls.some(([data]) => data === '\r'))
      alive.delete(12)
      alive.delete(13)
      alive.delete(15)
      expect(await sleeping).toEqual({ ok: true })
      expect(sent.at(-1)).toEqual({ channel: 'local-shell-sleep', payload: { id, sleeping: { kind: 'claude', since: expect.any(Number) } } })
      expect(shells.agentOf(id)).toBeNull()
      expect(shells.idleAgents()).toEqual([])
      expect(shells.sleeping()).toEqual([{ id, sleeping: { kind: 'claude', since: expect.any(Number) } }])

      // Keys wait: the shell is about to get the resume line
      pty.write.mockClear()
      shells.write(id, 'ls\r')
      expect(pty.write).not.toHaveBeenCalled()

      // A message for it wakes it
      shells.wakeInbox(id)
      expect(pty.write).toHaveBeenCalledExactlyOnceWith(`claude --resume ${SESSION} --dangerously-skip-permissions\r`)
      expect(sent.at(-1).payload.sleeping.waking).toBe(true)

      processes.set(22, { parent: 10, name: 'claude.exe' })
      processes.set(25, { parent: 22, name: 'electron.exe' })
      alive.add(22)
      alive.add(25)
      const again = await shells.bindAgentProcess({ pid: 25, kind: 'claude' })
      const authorizeBinding = vi.fn()
      expect(again({ agentId: 'claude-9', setStatus: vi.fn(), onExit: vi.fn(), authorizeBinding }).agentId).toBe('claude-1')
      expect(authorizeBinding).toHaveBeenCalledExactlyOnceWith('claude-1', true, false)
      expect(sent.at(-1)).toEqual({ channel: 'local-shell-sleep', payload: { id, sleeping: null } })
      expect(shells.agentOf(id).kind).toBe('claude')
      expect(agents.cancelSleep).not.toHaveBeenCalled()
    } finally {
      shells.closeAll()
    }
  })

  it('gives up when the composer has text, and the agent stays as it was', async () => {
    const processes = new Map([[15, { parent: 12, name: 'electron.exe' }], [12, { parent: 10, name: 'claude.exe' }]])
    const agents = { sleep: vi.fn(), cancelSleep: vi.fn(), unreadFor: () => [], unhandledFor: () => [] }
    let pty
    const shells = createLocalShells({
      spawn: () => (pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: cb => { pty.emit = cb }, onExit: () => {} }),
      send: () => {}, shell: { file: 'sh', args: [], name: 'sh' }, cwd: '/home', env: {}, agents,
      processTree: async () => processes, processAlive: () => true
    })
    const { id } = shells.open()
    pty.pid = 10
    try {
      const attach = await shells.bindAgentProcess({ pid: 15, kind: 'claude' })
      attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit: vi.fn() })
      pty.emit('\x1b[?2004h\x1b]0;✳ claude\x07\x1b[2J\x1b[Hready\r\n' + '─'.repeat(40) + '\r\n> half a thought')
      await new Promise(done => setTimeout(done, 200))
      const result = await shells.sleep(id, { sessionId: SESSION })
      expect(result).toEqual({ ok: false, reason: 'composer-not-empty' })
      expect(agents.cancelSleep).toHaveBeenCalledWith('claude-1', { ended: false })
      expect(shells.agentOf(id).kind).toBe('claude')
      expect(shells.sleeping()).toEqual([])
    } finally {
      shells.closeAll()
    }
  })
})
