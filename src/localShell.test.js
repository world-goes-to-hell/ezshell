import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, promises, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createAgentMessages } from './ipc/agentMessages.js'
import { rpc } from './ipc/agentMessageCli.js'
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
  const shells = createLocalShells({
    spawn, send: (channel, payload) => sent.push({ channel, payload }),
    shell: { file: 'sh', args: [], name: 'sh' }, cwd: '/home', env: {},
    commandLine: async () => '', timedProcessTree: options.processTree, ...options
  })
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
  it('binds the Antigravity status reporter, rejects tool descendants, keeps OSC blocking, and detaches on exit', async () => {
    let shells
    let locked = false
    const agents = createAgentMessages({ notify: vi.fn(), isLocked: () => locked, reportLocalAntigravity: report => shells.reportAntigravityStatus(report) })
    await agents.ready()
    const runtime = { name: basename(process.execPath), executable: process.execPath }
    const antigravityRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ezshell-agy-status-')))
    const statusShell = { name: process.platform === 'win32' ? 'cmd.exe' : 'sh' }
    const processes = new Map([
      [12, { parent: 10, name: 'agy.exe', startedAt: 1 }], [13, { parent: 11, name: 'agy.exe', startedAt: 1 }],
      [14, { ...runtime, parent: 19 }], [19, { ...statusShell, parent: 12 }],
      [15, { ...runtime, parent: 11 }],
      [16, { ...runtime, parent: 20 }], [20, { ...statusShell, parent: 13 }],
      [17, { ...runtime, parent: 21 }], [21, { ...statusShell, parent: 18 }], [18, { parent: 12, name: 'agy.exe' }],
      [22, { ...runtime, parent: 19, executable: join(dirname(process.execPath), 'other', runtime.name) }],
      [23, { ...runtime, parent: 24 }], [24, { parent: 12, name: 'powershell.exe' }]
    ])
    const fixture = setup({ agents, processTree: async () => processes, processAlive: pid => processes.has(pid), antigravityRoot })
    shells = fixture.shells
    const first = shells.open({ agent: 'antigravity' }).id
    const second = shells.open().id
    const [firstPty, secondPty] = fixture.ptys
    firstPty.pid = 10
    secondPty.pid = 11
    const cwd = process.platform === 'win32' ? 'C:\\work' : '/work'
    const sessionId = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
    const otherId = 'd13ee880-0dde-49af-a4c9-7a3620649d7b'
    mkdirSync(join(antigravityRoot, sessionId))
    mkdirSync(join(antigravityRoot, otherId))
    const report = (pty, pid, conversation_id = '', fields = {}, token = pty.options.env.EZSHELL_SHELL_TOKEN) => rpc({
      method: 'antigravity-status', pid,
      value: { product: 'antigravity', cwd, conversation_id, agent_state: 'idle', ...fields }
    }, { pipe: pty.options.env.EZSHELL_AGENT_PIPE, token })
    try {
      expect(firstPty.options.env).not.toHaveProperty('EZSHELL_AGENT_TOKEN')
      expect(fixture.spawn.mock.calls[0][1].join(' ')).toContain('--settings')
      expect(shells.agentOf(first)).toBeNull()
      expect(await report(firstPty, 16)).toMatchObject({ stored: false })
      expect(await report(firstPty, 17)).toMatchObject({ stored: false })
      expect(await report(firstPty, 22, otherId)).toMatchObject({ stored: false })
      expect(await report(firstPty, 23, otherId)).toMatchObject({ stored: false })
      expect(await report(secondPty, 15)).toMatchObject({ stored: false })
      expect(await report(firstPty, 14, '', {}, 'unregistered')).toMatchObject({ stored: false })
      locked = true
      expect(await report(firstPty, 14)).toMatchObject({ stored: false })
      locked = false
      firstPty.emit('\x1b]7501;?\x07\x1b]7501;state=blocked:kind=question:app=antigravity\x07')
      expect(await report(firstPty, 14)).toMatchObject({ stored: true })
      expect(shells.agentOf(first)).toEqual({ kind: 'antigravity', cwd, sessionId: null, status: 'blocked' })
      expect(await report(firstPty, 14, sessionId)).toMatchObject({ stored: true })
      expect(await report(firstPty, 23, otherId)).toMatchObject({ stored: false })
      expect(shells.agentOf(first)?.sessionId).toBe(sessionId)
      expect(shells.approvalOf(first)).toEqual({ question: null, detail: [], options: [], signature: 'antigravity-terminal', usesTerminalInput: true })
      firstPty.write.mockClear()
      expect((await shells.answerApproval(first, '1', 'antigravity-terminal')).ok).toBe(false)
      expect((await shells.chatSend(first, 'text')).ok).toBe(false)
      expect(shells.interruptAgent(first)).toBe(false)
      expect(firstPty.write).not.toHaveBeenCalled()
      firstPty.emit('\x1b]7501;state=idle:app=antigravity\x07')
      expect(shells.approvalOf(first)).toBeNull()
      expect(await report(secondPty, 16, otherId)).toMatchObject({ stored: true })
      expect(shells.agentOf(first)?.sessionId).toBe(sessionId)
      expect(shells.agentOf(second)?.sessionId).toBe(otherId)
      expect(agents.snapshot().agents).toMatchObject([
        { kind: 'antigravity', shellId: first, active: true, mcpConnected: false, status: 'idle' },
        { kind: 'antigravity', shellId: second, active: true, mcpConnected: false, status: 'idle' }
      ])
      processes.delete(12)
      expect(shells.agentOf(first)).toBeNull()
      expect(await report(firstPty, 14, sessionId)).toMatchObject({ stored: false })
      await vi.waitFor(() => expect(agents.snapshot().agents.find(agent => agent.shellId === first)?.active).not.toBe(true), { timeout: 2000 })
      expect(shells.isRunning(first)).toBe(true)
    } finally {
      shells.closeAll()
      agents.stop()
      rmSync(antigravityRoot, { recursive: true, force: true })
    }
  })

  it('requires a brain directory created after agy started before changing its role conversation', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ezshell-agy-role-')))
    const session = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
    const earlier = 'd13ee880-0dde-49af-a4c9-7a3620649d7b'
    const later = 'd13ee880-0dde-49af-a4c9-7a3620649d7c'
    const earlierDirectory = join(root, earlier)
    mkdirSync(earlierDirectory)
    const stat = statSync(earlierDirectory)
    const startedAt = (stat.birthtimeMs || stat.mtimeMs) + 1
    const processes = new Map([
      [12, { parent: 10, name: 'agy.exe', startedAt }],
      [13, { parent: 12, name: process.platform === 'win32' ? 'cmd.exe' : 'sh' }],
      [14, { parent: 13, name: basename(process.execPath), executable: process.execPath }]
    ])
    const registerLocalAntigravity = vi.fn((_, attach) => Boolean(attach({ agentId: 'antigravity-1', setStatus: vi.fn(), onExit: vi.fn() })))
    const setVerifiedSession = vi.fn()
    const { shells, ptys } = setup({
      processTree: async () => processes, processAlive: pid => processes.has(pid), antigravityRoot: root,
      agents: { registerLocalAntigravity, setVerifiedSession }
    })
    const { id } = shells.open()
    ptys[0].pid = 10
    let sequence = 0
    const report = sessionId => shells.reportAntigravityStatus({
      shellId: id, pid: 14, isCurrent: () => true, sequence: ++sequence,
      status: { sessionId, cwd: root, status: 'idle' }
    })
    try {
      expect(await report(earlier)).toBe(true)
      expect(registerLocalAntigravity).toHaveBeenCalledWith(root, expect.any(Function), null)
      expect(shells.agentOf(id).sessionId).toBeNull()
      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(startedAt))
      mkdirSync(join(root, session))
      expect(await report(session)).toBe(true)
      expect(shells.agentOf(id).sessionId).toBe(session)
      expect(await report(null)).toBe(true)
      expect(await report(earlier)).toBe(true)
      expect(await report(later)).toBe(true)
      expect(shells.agentOf(id).sessionId).toBe(session)
      expect(setVerifiedSession.mock.calls).toEqual([
        ['antigravity-1', session], ['antigravity-1', session], ['antigravity-1', session], ['antigravity-1', session]
      ])

      await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(startedAt))
      mkdirSync(join(root, later))
      const readStat = promises.lstat
      const olderCheck = Promise.withResolvers()
      const releaseOlderCheck = Promise.withResolvers()
      const lstat = vi.spyOn(promises, 'lstat').mockImplementation(async (file, ...options) => {
        if (file === earlierDirectory) {
          olderCheck.resolve()
          await releaseOlderCheck.promise
        }
        return readStat(file, ...options)
      })
      try {
        const accepted = report(later)
        const unverified = report(earlier)
        await olderCheck.promise
        expect(await accepted).toBe(true)
        releaseOlderCheck.resolve()
        expect(await unverified).toBe(true)
        expect(setVerifiedSession).toHaveBeenLastCalledWith('antigravity-1', later)
        expect(shells.agentOf(id).sessionId).toBe(later)
      } finally {
        releaseOlderCheck.resolve()
        lstat.mockRestore()
      }
      const logs = join(earlierDirectory, '.system_generated', 'logs')
      mkdirSync(logs, { recursive: true })
      writeFileSync(join(logs, 'transcript.jsonl'), '')
      expect(await report(earlier)).toBe(true)
      expect(shells.agentOf(id).sessionId).toBe(earlier)
    } finally {
      shells.closeAll()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds a manual Claude through its own process and updates the session without MCP', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const session = { pid: 12, cwd: '/work', startedAt, sessionId: '183a2d7a-c5d8-4d40-acd1-11c08bce7cde' }
    const nested = { ...session, pid: 13 }
    const outside = { ...session, pid: 22 }
    const processes = new Map([
      [12, { parent: 10, name: 'claude.exe', startedAt }],
      [13, { parent: 12, name: 'claude.exe', startedAt }],
      [14, { parent: 12, name: 'electron.exe' }],
      [22, { parent: 20, name: 'claude.exe', startedAt }]
    ])
    const readClaudeSessions = vi.fn(async () => [session, nested, outside])
    const processTree = vi.fn(async () => processes)
    const onExit = vi.fn()
    const registerLocalClaude = vi.fn((_, attach) => attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit }))
    const { shells, ptys } = setup({ readClaudeSessions, processTree, processAlive: pid => processes.has(pid), agents: { registerLocalClaude } })
    const first = shells.open().id
    const second = shells.open().id
    ptys[0].pid = 10
    ptys[1].pid = 11
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(registerLocalClaude).toHaveBeenCalledTimes(1)
      expect(shells.agentOf(first)).toMatchObject({ kind: 'claude', cwd: session.cwd, sessionId: session.sessionId })
      expect(shells.agentOf(second)).toBeNull()

      const next = { ...session, sessionId: 'd13ee880-0dde-49af-a4c9-7a3620649d7b' }
      readClaudeSessions.mockResolvedValue([next, nested, outside])
      await vi.advanceTimersByTimeAsync(1000)
      expect(shells.agentOf(first)?.sessionId).toBe(next.sessionId)
      expect(processTree).toHaveBeenCalledTimes(1)
      expect(registerLocalClaude).toHaveBeenCalledTimes(1)

      const connectMcp = await shells.bindAgentProcess({ pid: 14, kind: 'claude' })
      expect(connectMcp({ agentId: 'claude-2', setStatus: vi.fn(), onExit }).agentId).toBe('claude-2')
      processes.delete(12)
      readClaudeSessions.mockResolvedValue([outside])
      await vi.advanceTimersByTimeAsync(1000)
      expect(shells.agentOf(first)).toBeNull()
      expect(shells.isRunning(first)).toBe(true)
      expect(onExit.mock.calls).toEqual([['claude-1'], ['claude-2']])
    } finally {
      shells.closeAll()
      vi.useRealTimers()
    }
  })

  it.each([10, 12])('verifies a managed Claude session from its own process (PID %s)', async pid => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const ownSession = { pid, cwd: '/work', startedAt, sessionId: '183a2d7a-c5d8-4d40-acd1-11c08bce7cde' }
    const nextSession = { ...ownSession, sessionId: 'd13ee880-0dde-49af-a4c9-7a3620649d7b' }
    const unrelatedSession = { ...nextSession, pid: 22 }
    const processTree = vi.fn(async () => new Map([
      [pid, { parent: pid === 10 ? 1 : 10, name: 'claude.exe', startedAt }],
      [22, { parent: 20, name: 'claude.exe', startedAt }],
      [23, { parent: pid, name: 'node.exe', startedAt }]
    ]))
    const readClaudeSessions = vi.fn(async () => [unrelatedSession, { ...nextSession, pid: 23 }, ownSession])
    const setVerifiedSession = vi.fn()
    const registerLocalClaude = vi.fn()
    const { shells, ptys } = setup({ readClaudeSessions, processTree, processAlive: () => true, agents: {
      register: () => ({ env: { EZSHELL_AGENT_ID: 'claude-managed' }, close: vi.fn() }),
      registerLocalClaude,
      setVerifiedSession
    } })
    try {
      shells.open({ agent: 'claude' })
      ptys[0].pid = 10
      await vi.advanceTimersByTimeAsync(1000)
      expect(setVerifiedSession.mock.calls).toEqual([['claude-managed', ownSession.sessionId]])
      readClaudeSessions.mockResolvedValue([nextSession])
      await vi.advanceTimersByTimeAsync(1000)
      expect(setVerifiedSession.mock.calls).toEqual([
        ['claude-managed', ownSession.sessionId], ['claude-managed', nextSession.sessionId]
      ])
      expect(registerLocalClaude).not.toHaveBeenCalled()
      expect(processTree).toHaveBeenCalledTimes(1)
    } finally {
      shells.closeAll()
      vi.useRealTimers()
    }
  })

  it('ignores a stale Claude session file after PID reuse when reading the sleep target', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now() + 1000
    const sessionId = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
    const session = { pid: 12, cwd: '/work', sessionId, startedAt: startedAt + 7770, processStartedAt: startedAt }
    const claude = { parent: 10, name: 'claude.exe', startedAt: startedAt + 1500 }
    const processes = new Map([[12, claude], [14, { parent: 12, name: 'electron.exe' }]])
    const readClaudeSessions = async () => [session]
    const processTree = vi.fn(async () => processes)
    const registerLocalClaude = vi.fn((_, attach) => attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit: vi.fn() }))
    const setVerifiedSession = vi.fn()
    const { shells, ptys } = setup({
      readClaudeSessions, processTree, processAlive: pid => processes.has(pid),
      agents: { registerLocalClaude, setVerifiedSession }
    })
    const { id } = shells.open()
    ptys[0].pid = 10
    try {
      await vi.advanceTimersByTimeAsync(3000)
      expect(shells.agentOf(id)).toBeNull()
      expect(registerLocalClaude).not.toHaveBeenCalled()
      expect(processTree).toHaveBeenCalledTimes(1)

      session.processStartedAt = claude.startedAt
      await vi.advanceTimersByTimeAsync(1000)
      expect(registerLocalClaude).toHaveBeenCalledTimes(1)
      const attach = await shells.bindAgentProcess({ pid: 14, kind: 'claude' })
      attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit: vi.fn() })
      expect(shells.idleAgents()).toMatchObject([{ kind: 'claude', external: true, sessionId }])

      claude.startedAt += 5000
      session.startedAt += 1
      await vi.advanceTimersByTimeAsync(1000)
      expect(setVerifiedSession).not.toHaveBeenCalled()
      expect(shells.idleAgents()).toEqual([])
    } finally {
      shells.closeAll()
      vi.useRealTimers()
    }
  })

  it.each([null, 'codex.exe', 'node.exe'])('uses a Codex resume UUID only for the CLI directly below the shell (parent %s)', async parent => {
    const sessionId = '183a2d7a-c5d8-4d40-acd1-11c08bce7cde'
    const processes = new Map([
      [12, { parent: 10, name: parent }],
      [13, { parent: parent ? 12 : 10, name: 'codex.exe' }],
      [14, { parent: 13, name: 'electron.exe' }]
    ])
    const commandLine = vi.fn(async () => `"C:\\Program Files\\codex.exe" --no-daemon resume ${sessionId}`)
    const { shells, ptys } = setup({ processTree: async () => processes, processAlive: pid => processes.has(pid), commandLine, agents: {} })
    shells.open()
    ptys[0].pid = 10
    try {
      const attach = await shells.bindAgentProcess({ pid: 14, kind: 'codex' })
      const binding = attach({ agentId: 'codex-1', setStatus: vi.fn(), onExit: vi.fn() })
      if (parent) {
        expect(commandLine).not.toHaveBeenCalled()
        expect(binding).not.toHaveProperty('resumeId')
      } else {
        expect(commandLine).toHaveBeenCalledExactlyOnceWith(13)
        expect(binding).toMatchObject({ resumeId: sessionId })
      }
    } finally {
      shells.closeAll()
    }
  })

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

  it('distinguishes unavailable process ancestry from a known process outside the app shells', async () => {
    const processTree = vi.fn(async () => new Map([[12, { parent: 1, name: 'electron.exe' }]]))
      .mockRejectedValueOnce(new Error('snapshot unavailable'))
    const { shells, ptys } = setup({ processTree, agents: {} })
    shells.open()
    ptys[0].pid = 10
    try {
      await expect(shells.bindAgentProcess({ pid: 12, kind: 'claude' })).rejects.toThrow(/계보/)
      await expect(shells.bindAgentProcess({ pid: 12, kind: 'claude' })).resolves.toBeUndefined()
    } finally {
      shells.closeAll()
    }
  })

  it('reads the composer of a CLI whose start scrolled out of the backlog before its MCP connected (2026-11-23 user report)', async () => {
    const processes = new Map([[15, { parent: 12, name: 'electron.exe' }], [12, { parent: 10, name: 'claude.exe' }]])
    const { shells, ptys } = setup({ agents: {}, processTree: async () => processes, processAlive: () => true })
    const { id } = shells.open()
    ptys[0].pid = 10
    const rule = '─'.repeat(79)
    try {
      // Claude turns bracketed paste on once, when it starts; a long session pushes that out of the backlog
      ptys[0].emit('\x1b[?2004h')
      for (let sent = 0; sent <= BACKLOG_CHARS * 2; sent += 64 * 1024) ptys[0].emit('x'.repeat(64 * 1024 - 2) + '\r\n')
      ptys[0].emit(`\x1b[2J\x1b[10;1H${rule}\x1b[11;1H❯ \x1b[12;1H${rule}\x1b[11;3H`)
      const attach = await shells.bindAgentProcess({ pid: 15, kind: 'claude' })
      attach({ agentId: 'claude-1', setStatus: vi.fn(), onExit: vi.fn() })
      // The headless screen parses what it is given asynchronously
      await vi.waitFor(() => expect(shells.chatScreen(id).lines.join('')).toContain('❯'))
      expect(shells.chatScreen(id).composer).toBe('empty')
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
      [12, { parent: 10, name: 'claude.exe', startedAt: 10_000 }]
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
      const authorizeBinding = vi.fn(() => { throw new Error('Reconnect credential required') })
      expect(() => attach({ agentId: 'claude-2', setStatus: vi.fn(), onExit, authorizeBinding })).toThrow('Reconnect credential required')
      expect(authorizeBinding).toHaveBeenCalledExactlyOnceWith('claude-1', false, true)
      alive.delete(15)
      expect(binding.detach()).toBe(true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(shells.agentOf(id).kind).toBe('claude')
      expect(onExit).not.toHaveBeenCalled()

      processes.set(16, { parent: 13, name: 'electron.exe' })
      alive.add(16)
      const reconnect = await shells.bindAgentProcess({ pid: 16, kind: 'claude' })
      authorizeBinding.mockImplementation(() => {})
      const reconnected = reconnect({ agentId: 'claude-2', setStatus: vi.fn(), onExit, authorizeBinding })
      expect(reconnected.agentId).toBe('claude-1')
      expect(binding.detach()).toBe(false)
      processes.get(12).startedAt += 1000
      const reusedPid = await shells.bindAgentProcess({ pid: 16, kind: 'claude' })
      authorizeBinding.mockImplementation(() => { throw new Error('Process start changed') })
      expect(() => reusedPid({ agentId: 'claude-3', setStatus: vi.fn(), onExit, authorizeBinding })).toThrow('Process start changed')
      expect(authorizeBinding).toHaveBeenLastCalledWith('claude-1', false, false)
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

  it('drops inherited session markers and credentials, keeping Claude settings', () => {
    // Started from inside Claude Code, every Claude in a local shell took itself for a sub-session of it
    // (transcript saving off, so its conversation could not be resumed)
    const { shells, ptys } = setup({ env: {
      TERM: 'xterm', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_MESSAGING_SOCKET: 'pipe', CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDE_PID: '42',
      CLAUDE_CONFIG_DIR: 'D:\\claude', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
      EZSHELL_AGENT_ID: 'codex-1', EZSHELL_AGENT_TOKEN: 'parent-agent', EZSHELL_AGENT_PIPE: 'parent-pipe'
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
