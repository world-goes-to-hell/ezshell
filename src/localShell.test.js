import { describe, it, expect, vi } from 'vitest'
import { createLocalShells, defaultShell, BACKLOG_CHARS } from './localShell.js'

function fakePty() {
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb) => { pty.emit = cb },
    onExit: (cb) => { pty.exit = cb }
  }
  return pty
}

function setup(options = {}) {
  const ptys = []
  const sent = []
  const spawn = vi.fn((file, args, options) => {
    const pty = fakePty()
    pty.options = options
    ptys.push(pty)
    return pty
  })
  const shells = createLocalShells({ spawn, send: (channel, payload) => sent.push({ channel, payload }), shell: { file: 'sh', args: [], name: 'sh' }, cwd: '/home', env: {}, ...options })
  return { shells, ptys, sent, spawn }
}

describe('defaultShell', () => {
  it('is PowerShell on Windows and the login shell elsewhere', () => {
    expect(defaultShell('win32', {}).file).toBe('powershell.exe')
    expect(defaultShell('linux', { SHELL: '/bin/zsh' })).toEqual({ file: '/bin/zsh', args: ['-l'], name: 'zsh' })
    expect(defaultShell('linux', {}).file).toBe('/bin/bash')
  })
})

describe('createLocalShells', () => {
  it('binds five agents to their own shells when two MCP processes start after a shared snapshot', async () => {
    const processes = new Map()
    const processTree = vi.fn(async () => processes)
    const { shells, ptys } = setup({ agents: {}, processTree, processAlive: () => true })
    const agents = Array.from({ length: 5 }, (_, index) => {
      const { id } = shells.open()
      const ptyPid = 200 + index
      const cliPid = 300 + index
      const pid = 400 + index
      const kind = index % 2 === 0 ? 'claude' : 'codex'
      ptys[index].pid = ptyPid
      processes.set(cliPid, { parent: ptyPid, name: `${kind}.exe` })
      return { id, cliPid, pid, kind }
    })
    const addHelpers = (set, entries) => {
      for (const { pid, cliPid } of entries) set.set(pid, { parent: cliPid, name: 'electron.exe' })
      return set
    }
    processTree.mockResolvedValueOnce(addHelpers(new Map(processes), agents.slice(0, 3)))
    addHelpers(processes, agents.slice(3))

    try {
      const connections = await Promise.all(agents.map(({ pid, kind }) => shells.bindAgentProcess({ pid, kind })))
      expect(processTree).toHaveBeenCalledTimes(2)
      const attached = connections.map((connect, index) => connect({
        agentId: `${agents[index].kind}-${index}`, setStatus: () => {}, onExit: () => {}
      }))
      expect(attached.map(agent => agent.shellId)).toEqual(agents.map(agent => agent.id))
    } finally {
      shells.closeAll()
    }
  })

  it('tracks the CLI across MCP disconnection and reconnection until the CLI exits', async () => {
    vi.useFakeTimers()
    const processes = new Map([
      [15, { parent: 14, name: 'electron.exe' }],
      [14, { parent: 13, name: 'powershell.exe' }],
      [13, { parent: 12, name: 'node.exe' }],
      [12, { parent: 10, name: 'claude.exe' }]
    ])
    const alive = new Set([12, 13, 14, 15])
    const { shells, ptys } = setup({ agents: {}, processTree: async () => processes, processAlive: pid => alive.has(pid) })
    const { id } = shells.open()
    ptys[0].pid = 10
    const onExit = vi.fn()
    try {
      const attach = await shells.bindAgentProcess({ pid: 15, kind: 'claude' })
      const binding = attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit })
      expect(binding.shellId).toBe(id)
      alive.delete(15)
      expect(binding.detach()).toBe(true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(shells.agentOf(id).kind).toBe('claude')
      expect(onExit).not.toHaveBeenCalled()

      processes.set(16, { parent: 13, name: 'electron.exe' })
      alive.add(16)
      const reconnect = await shells.bindAgentProcess({ pid: 16, kind: 'claude' })
      const reconnected = reconnect({ agentId: 'claude-2', setStatus: vi.fn(), onExit })
      expect(reconnected.agentId).toBe('claude-1')
      expect(binding.detach()).toBe(false)
      alive.delete(12)
      expect(await shells.chatSend(id, 'check')).toEqual({ ok: false, reason: 'not-agent' })
      await vi.advanceTimersByTimeAsync(1000)
      expect(shells.isRunning(id)).toBe(true)
      expect(shells.agentOf(id)).toBeNull()
      expect(onExit).toHaveBeenCalledExactlyOnceWith('claude-1')
    } finally {
      shells.closeAll()
      vi.useRealTimers()
    }
  })

  it('sets the PTY color capabilities without changing the parent environment', () => {
    const env = { Term: 'dumb', No_Color: '1', ColorTerm: '24bit', Path: 'shell-path' }
    const { shells, ptys } = setup({ env, platform: 'win32' })
    shells.open()
    expect(ptys[0].options.name).toBe('xterm-256color')
    expect(ptys[0].options.env).toEqual({ Term: 'xterm-256color', ColorTerm: 'truecolor', Path: 'shell-path' })
    expect(env).toEqual({ Term: 'dumb', No_Color: '1', ColorTerm: '24bit', Path: 'shell-path' })
  })

  it('passes the corrected environment through agent registration', () => {
    const register = vi.fn((kind, id, cwd, env) => ({ env: { ...env, EZSHELL_AGENT_PIPE: 'test-pipe' } }))
    const { shells, ptys } = setup({ env: { TERM: 'dumb', NO_COLOR: '1' }, agents: { register } })
    const { id } = shells.open({ agent: 'codex' })
    const terminalEnv = { TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    // No resumed session: the last argument (the session the usage watcher looks for) is empty
    expect(register).toHaveBeenCalledWith('codex', id, '/home', terminalEnv, null)
    expect(ptys[0].options.env).toEqual({ ...terminalEnv, EZSHELL_AGENT_PIPE: 'test-pipe' })
  })

  it('clears the Orca color override even when its TERM advertises colors', () => {
    const env = { TERM_PROGRAM: 'Orca', TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' }
    const { shells, ptys } = setup({ env })
    shells.open()
    expect(ptys[0].options.env).toEqual({ TERM_PROGRAM: 'Orca', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
    expect(env.NO_COLOR).toBe('1')
  })

  it('drops the markers of a Claude Code session the app was started from, keeping Claude settings', () => {
    // Started from inside Claude Code, every Claude in a local shell took itself for a sub-session of it
    // (transcript saving off, so its conversation could not be resumed)
    const { shells, ptys } = setup({ env: {
      TERM: 'xterm', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_MESSAGING_SOCKET: 'pipe', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDE_PID: '42',
      CLAUDE_CONFIG_DIR: 'D:\\claude', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe'
    } })
    shells.open()
    expect(ptys[0].options.env).toEqual({
      TERM: 'xterm-256color', COLORTERM: 'truecolor', CLAUDE_CONFIG_DIR: 'D:\\claude', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe'
    })
  })

  it('preserves NO_COLOR from a parent with a color-capable terminal', () => {
    const { shells, ptys } = setup({ env: { TERM: 'xterm', NO_COLOR: '1' } })
    shells.open()
    expect(ptys[0].options.env).toEqual({ TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' })
  })

  it('continues through PTY output and exit when the message registration has no status callbacks', () => {
    const pty = fakePty()
    const close = vi.fn()
    const send = vi.fn()
    const shells = createLocalShells({
      spawn: () => pty,
      send,
      agents: { register: () => ({ env: {}, close }) },
      shell: { file: 'sh', args: [], name: 'sh' },
      cwd: '/home',
      env: {}
    })
    const { id } = shells.open({ agent: 'claude' })
    pty.emit('\x1b]0;✳ Claude Code\x07')
    pty.exit({ exitCode: 0 })
    expect(send).toHaveBeenCalledWith('local-shell-exit', { id, exitCode: 0 })
    expect(close).toHaveBeenCalledOnce()
  })

  it('opens a shell with a clamped size and forwards its output', () => {
    const { shells, ptys, sent } = setup()
    const { id, name } = shells.open({ cols: 100000, rows: 'x' })
    expect(name).toBe('sh')
    expect(ptys[0].options).toMatchObject({ cols: 500, rows: 24, cwd: '/home' })
    ptys[0].emit('hello')
    expect(sent).toEqual([{ channel: 'local-shell-data', payload: { id, data: 'hello' } }])
  })

  it('reports a Windows shell directory from a split OSC sequence and ignores network URLs', async () => {
    const { shells, ptys } = setup({ platform: 'win32', cwd: 'C:\\launch' })
    const { id } = shells.open()
    expect(await shells.currentDirectory(id)).toBe('C:\\launch')
    ptys[0].emit('\x1b]7;file:///C:/my%20')
    ptys[0].emit('work\x07')
    expect(await shells.currentDirectory(id)).toBe('C:\\my work')
    ptys[0].emit('\x1b]7;file://example.com/share\x07')
    expect(await shells.currentDirectory(id)).toBe('C:\\my work')
  })

  it('gives a redrawn tab the output so far and the exit state', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open()
    ptys[0].emit('a')
    ptys[0].emit('b')
    expect(shells.attach(id)).toEqual({ backlog: 'ab', exited: false, exitCode: null })
    ptys[0].exit({ exitCode: 3 })
    expect(shells.attach(id)).toEqual({ backlog: 'ab', exited: true, exitCode: 3 })
    expect(shells.attach('local:99')).toBeNull()
  })

  it('keeps only the end of a long output', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open()
    for (let i = 0; i < 5; i++) ptys[0].emit(String(i).repeat(BACKLOG_CHARS))
    const { backlog } = shells.attach(id)
    expect(backlog.length).toBe(BACKLOG_CHARS)
    expect(backlog.endsWith('4')).toBe(true)
  })

  it('writes and resizes only a running shell, and ignores input that is not text', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open()
    shells.write(id, 'ls\r')
    shells.write(id, { toString: () => 'x' })
    shells.write('local:99', 'x')
    shells.resize(id, 120, 40)
    expect(ptys[0].write.mock.calls).toEqual([['ls\r']])
    expect(ptys[0].resize).toHaveBeenCalledWith(120, 40)
    ptys[0].exit({ exitCode: 0 })
    shells.write(id, 'x')
    shells.resize(id, 80, 24)
    expect(ptys[0].write).toHaveBeenCalledTimes(1)
    expect(ptys[0].resize).toHaveBeenCalledTimes(1)
  })

  it('routes a Windows screenshot to the running agent and counts it as a Codex draft', () => {
    const { shells, ptys } = setup({ platform: 'win32' })
    const codex = shells.open({ agent: 'codex' })
    const claude = shells.open({ agent: 'claude' })
    const ordinary = shells.open()
    ptys[0].emit('\x1b]0;⠋ Codex\x07')
    expect(shells.pasteClipboardImage(codex.id)).toBe(true)
    expect(shells.pasteClipboardImage(claude.id)).toBe(true)
    expect(shells.pasteClipboardImage(ordinary.id)).toBe(false)
    expect(ptys[0].write.mock.calls).toEqual([['\x16']])
    expect(ptys[1].write.mock.calls).toEqual([['\x1bv']])
    expect(ptys[2].write).not.toHaveBeenCalled()
    expect(shells.hasWorkingAgent([codex.id])).toBe(false)
    shells.write(codex.id, '\r')
    expect(shells.hasWorkingAgent([codex.id])).toBe(true)
    ptys[1].exit({ exitCode: 0 })
    expect(shells.pasteClipboardImage(claude.id)).toBe(false)
  })

  it('kills a running shell on close, and every shell on closeAll', () => {
    const { shells, ptys } = setup()
    const first = shells.open()
    shells.open()
    shells.open()
    ptys[2].exit({ exitCode: 0 })
    shells.close(first.id)
    expect(ptys[0].kill).toHaveBeenCalledTimes(1)
    shells.closeAll()
    expect(ptys[1].kill).toHaveBeenCalledTimes(1)
    expect(ptys[2].kill).not.toHaveBeenCalled()
    expect(shells.count()).toBe(0)
  })

  it('keeps more than ten local shells open at once', () => {
    const { shells } = setup()
    const opened = Array.from({ length: 12 }, () => shells.open())
    expect(shells.count()).toBe(12)
    expect(shells.list().map(shell => shell.id)).toEqual(opened.map(shell => shell.id))
  })

  it('prepares one replacement per shell and keeps the original until adoption', () => {
    const { shells, ptys, spawn } = setup()
    const previous = shells.open({ cols: 96, rows: 35 })
    const options = { agent: 'claude', resume: 'abcdef12-1111-4222-8333-444455556666', replacementFor: previous.id }
    spawn.mockImplementationOnce(() => { throw new Error('PTY failed') })
    expect(() => shells.open(options)).toThrow('PTY failed')
    expect(shells.count()).toBe(1)
    expect(ptys[0].kill).not.toHaveBeenCalled()

    const replacement = shells.open(options)
    expect(replacement.id).not.toBe(previous.id)
    expect(ptys[1].options).toMatchObject({ cols: 96, rows: 35 })
    expect(() => shells.open(options)).toThrow(/바꾸는 중/)
    expect(ptys[0].kill).not.toHaveBeenCalled()
    shells.close(previous.id)
    expect(ptys[0].kill).toHaveBeenCalledOnce()
    expect(shells.count()).toBe(1)
    expect(shells.attach(replacement.id)?.exited).toBe(false)
  })

  it('tracks the activity of the launched agent across split OSC sequences', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open({ agent: 'claude' })
    expect(shells.hasWorkingAgent([id])).toBe(false)
    ptys[0].emit('\x1b]0;⠋')
    ptys[0].emit(' Codex\x07')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].emit('\x1b]2;Codex\x1b')
    ptys[0].emit('\\')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    ptys[0].emit('\x1b]9;4;3\x07')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].exit({ exitCode: 0 })
    expect(shells.hasWorkingAgent([id])).toBe(false)
  })

  it('ignores Codex startup progress and an unsubmitted draft, then reports work after submission', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open({ agent: 'codex' })
    ptys[0].emit('\x1b]0;⠋ ezshell\x07\x1b]9;4;3\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    shells.write(id, '\x1b[I')
    shells.write(id, '\r')
    expect(shells.hasWorkingAgent([id])).toBe(false)

    shells.write(id, '\x1b[200~Check the output\rfrom this command\x1b[201~')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    shells.write(id, '\r')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].emit('\x1b]0;ezshell\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    ptys[0].emit('\x1b]0;⠙ ezshell\x07')
    expect(shells.hasWorkingAgent([id])).toBe(true)
  })

  // Recorded from Claude Code (2026-11): working spins ◐/◑ in the title, idle is ✳, and it sends no
  // program status report even after the probe is answered
  it('reads the half-circle spinner of Claude Code as working and ✳ as idle', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open({ agent: 'claude' })
    ptys[0].emit('\x1b]0;✳ Claude Code\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    ptys[0].emit('\x1b]0;◐ Claude Code\x07')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].emit('\x1b]0;◑ 인사 응답 테스트\x07')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].emit('\x1b]0;✳ 인사 응답 테스트\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
  })

  it('answers the program status probe and prefers root state over title and child reports', () => {
    const { shells, ptys } = setup()
    const { id } = shells.open({ agent: 'claude' })
    ptys[0].emit('\x1b]750')
    ptys[0].emit('1;?\x07')
    expect(ptys[0].write).toHaveBeenCalledWith('\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\')
    ptys[0].emit('\x1b]7501;state=blocked:app=claude-code:kind=permission\x1b\\')
    ptys[0].emit('\x1b]0;⠋ Claude\x07\x1b]7501;state=working:app=claude-code:id=job\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
    ptys[0].emit('\x1b]7501;state=working:app=claude-code\x1b\\')
    expect(shells.hasWorkingAgent([id])).toBe(true)
    ptys[0].emit('\x1b]7501;state=done:app=claude-code\x07')
    expect(shells.hasWorkingAgent([id])).toBe(false)
  })

  it.each([
    ['claude', ['← □ Scope ✓ Submit →', '', 'How should I proceed?', '', '❯ 1. [ ] Use the first option',
      '  2. [ ] Type something', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel']],
    ['codex', ['Would you like to run the following command?', '', '› 1. Yes, proceed (y)',
      '  2. No, go back (esc)', '', 'Press enter to confirm or esc to cancel']]
  ])('publishes response needed for a visible %s prompt even if the CLI reports idle', async (kind, prompt) => {
    const setStatus = vi.fn()
    const { shells, ptys } = setup({ agents: { register: () => ({ env: {}, setStatus, close() {} }) } })
    const { id } = shells.open({ agent: kind, cols: 100 })
    const clear = '\x1b[?2004h\x1b[2J\x1b[H'
    const idle = `\x1b]7501;state=idle:app=${kind}\x07`
    try {
      ptys[0].emit(idle + clear + prompt.join('\r\n'))
      await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith('blocked'))
      expect(shells.agentOf(id).status).toBe('blocked')
      ptys[0].emit(idle)
      expect(setStatus).toHaveBeenLastCalledWith('blocked')

      // The next normal output may contain numbered text of its own.
      ptys[0].emit(clear + ['Here is the plan:', '  1. Read the file', '  2. Run the tests'].join('\r\n'))
      await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith('idle'))
      expect(shells.agentOf(id).status).toBe('idle')
    } finally {
      shells.close(id)
    }
  })
})
