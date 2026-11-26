import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLocalShells } from './localShell.js'
import { remotePty } from './sessionHost/client.js'

const DIR = realpathSync(tmpdir())

function fakePty() {
  const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pid: 900 }
  pty.onData = cb => { pty.emit = cb }
  pty.onExit = cb => { pty.exit = cb }
  return pty
}

// The session host client, in memory: what localShell.js asks of it
function fakeHost({ ready = true } = {}) {
  const sent = []
  const remotes = new Map()
  return {
    sent, remotes,
    ready: () => ready,
    spawn: vi.fn((id, file, args, options, meta) => {
      const remote = remotePty(id, message => sent.push(message))
      remotes.set(id, { remote, meta, options })
      remote.pty.pid = 700 + remotes.size
      return remote.pty
    }),
    adopt: vi.fn(shell => {
      const remote = remotePty(shell.id, message => sent.push(message))
      remote.pty.pid = shell.pid
      remotes.set(shell.id, { remote })
      return remote.pty
    }),
    setMeta: vi.fn()
  }
}

function setup(options = {}) {
  const sent = []
  const spawn = vi.fn(() => fakePty())
  const killTrees = vi.fn()
  const shells = createLocalShells({
    spawn, send: (channel, payload) => sent.push({ channel, payload }), killTrees,
    shell: { file: 'sh', args: [], name: 'sh' }, cwd: '/home', env: {}, commandLine: async () => '', ...options
  })
  return { shells, sent, spawn, killTrees }
}

describe('local shells in the session host', () => {
  it('opens a shell in the host when it is ready, with what the next app needs to take it back', () => {
    const host = fakeHost()
    const { shells, spawn, sent } = setup({ host })
    const { id } = shells.open({ cols: 100, rows: 30, cwd: DIR })
    expect(spawn).not.toHaveBeenCalled()
    expect(host.spawn).toHaveBeenCalledWith(id, 'sh', expect.any(Array), expect.objectContaining({ cols: 100, rows: 30, cwd: DIR }), { agent: null, cwd: DIR, launchDirectory: DIR, resumeId: null })
    host.remotes.get(id).remote.data('hello')
    expect(sent).toContainEqual({ channel: 'local-shell-data', payload: { id, data: 'hello' } })
    shells.write(id, 'ls\r')
    expect(host.sent).toContainEqual({ type: 'write', id, data: 'ls\r' })
  })

  it('opens it in the app while the host is not ready', () => {
    const host = fakeHost({ ready: false })
    const { shells, spawn } = setup({ host })
    shells.open({})
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(host.spawn).not.toHaveBeenCalled()
  })

  it('hands the hosted shells over on an update and ends only the others with their trees', () => {
    const host = fakeHost()
    const { shells, killTrees } = setup({ host })
    const hosted = shells.open({ cwd: DIR }).id
    host.ready = () => false
    const inApp = shells.open({}).id
    shells.list() // both there
    const appPty = shells.attach(inApp)
    expect(appPty).not.toBeNull()
    shells.handOver()
    expect(host.setMeta).toHaveBeenCalledWith(hosted, expect.objectContaining({ agent: null, cwd: DIR, launchDirectory: DIR, reportedDirectory: null, resumeId: null }))
    expect(host.sent.some(message => message.type === 'kill' && message.id === hosted)).toBe(false)
    expect(shells.list().map(shell => shell.id)).toEqual([hosted])
    expect(killTrees).toHaveBeenCalledWith([900])
  })

  it('takes back the shells an earlier app kept, under their ids and with their output', () => {
    const host = fakeHost()
    const { shells, sent } = setup({ host })
    const adopted = shells.adopt([
      { id: 'local:7', pid: 4100, meta: { agent: null, cwd: 'C:\\work', launchDirectory: 'C:\\work' }, buffer: 'npm run dev\r\nready', cols: 120, rows: 40, exited: false },
      { id: 'evil', pid: 1, meta: {}, buffer: '', exited: false },
      { id: 'local:2', pid: 4101, meta: { cwd: 'relative' }, buffer: '', exited: true }
    ])
    expect(adopted).toEqual(['local:7'])
    expect(shells.list()).toEqual([{ id: 'local:7', name: 'sh', exited: false, cwd: process.platform === 'win32' ? 'C:\\work' : null, agent: null }])
    expect(shells.attach('local:7').backlog).toBe('npm run dev\r\nready')
    host.remotes.get('local:7').remote.data(' again')
    expect(sent).toContainEqual({ channel: 'local-shell-data', payload: { id: 'local:7', data: ' again' } })
    // New shells do not take a kept shell's id
    expect(shells.open({}).id).toBe('local:8')
  })

  it.skipIf(process.platform !== 'win32')('keeps the verified launch folder through an update, and drops it when the folder was swapped', async () => {
    const root = mkdtempSync(join(DIR, 'ezshell-handover-'))
    const original = join(root, 'actual')
    const shown = join(root, 'shown')
    mkdirSync(original)
    mkdirSync(shown)
    try {
      const before = fakeHost()
      const first = setup({ host: before, platform: 'win32', processAlive: () => true, cwd: root }).shells
      const { id } = first.open({ cwd: original })
      before.remotes.get(id).remote.data(`\x1b]7;${pathToFileURL(shown).href}\x07`)
      first.handOver()
      // The meta goes through the pipe as JSON
      const meta = JSON.parse(JSON.stringify(before.setMeta.mock.calls[0][1]))
      expect(meta.launchDirectory).toBe(original)
      const kept = [{ id, pid: 4300, meta, buffer: '', cols: 80, rows: 24, exited: false }]

      const next = setup({ host: fakeHost(), platform: 'win32', processAlive: () => true, cwd: root }).shells
      next.adopt(kept)
      expect(await next.runAuthorityDirectory(id)).toBe(original)
      expect(await next.currentDirectory(id)).toBe(shown)

      // The same path, another folder: the shell did not start there
      renameSync(original, join(root, 'moved'))
      mkdirSync(original)
      const swapped = setup({ host: fakeHost(), platform: 'win32', processAlive: () => true, cwd: root }).shells
      swapped.adopt(kept)
      expect(await swapped.runAuthorityDirectory(id)).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('gives an adopted agent shell its message registration back', () => {
    const host = fakeHost()
    const registration = { close: vi.fn(), setStatus: vi.fn() }
    let handed = []
    const agents = { adopt: vi.fn(() => registration), adoptShell: vi.fn(), agentsOfShell: vi.fn(() => handed), register: vi.fn(), registerShell: vi.fn(() => ({})) }
    const { shells } = setup({ host, agents })
    shells.adopt([{ id: 'local:3', pid: 4200, meta: { agent: 'claude', resumeId: '01234567-89ab-cdef-0123-456789abcdef' }, buffer: '', exited: false }])
    expect(agents.adopt).toHaveBeenCalledWith('claude', 'local:3', { resumeId: '01234567-89ab-cdef-0123-456789abcdef' })
    expect(agents.adoptShell).toHaveBeenCalledWith('local:3')
    expect(shells.list()[0].agent).toBe('claude')
    // The agent id comes with the handover, opened after the unlock
    expect(shells.chatAgentId('local:3')).toBeUndefined()
    handed = ['claude-4']
    expect(shells.chatAgentId('local:3')).toBe('claude-4')
  })

  // 2026-11-26, after updating to 2.38.0: still "입력칸을 찾지 못했습니다" for a Codex that had worked 20 minutes.
  // The host keeps the last 256KB only: the CLI's bracketed paste switch (sent once at its start) was cut off,
  // and the composer is read only with it on. The modes now go with the handover; without them (an older app
  // handed the shell over) a Claude or Codex is taken to have it on, as both always do while running.
  it.each([
    ['handed over with its modes', { '2004': true }, true],
    ['handed over by an older app, without modes', undefined, true],
    ['handed over with the switch off', { '2004': false }, false]
  ])('reads the composer of an agent whose start fell out of the kept output (%s)', async (_name, modes, sends) => {
    const fixture = JSON.parse(readFileSync(new URL('./ipc/fixtures/agent-inbox-pty/codex-100x24-warning.json', import.meta.url), 'utf8'))
    const host = fakeHost()
    const agents = { adopt: vi.fn(() => ({ close: vi.fn(), setStatus: vi.fn() })), adoptShell: vi.fn(), agentsOfShell: vi.fn(() => ['codex-13']), register: vi.fn(), registerShell: vi.fn(() => ({})),
      unreadFor: () => [], unhandledFor: () => [] }
    const { shells } = setup({ host, agents })
    const buffer = fixture.phases.idle.frame.replaceAll('[?2004h', '')
    shells.adopt([{ id: 'local:5', pid: 4300, cols: fixture.cols, rows: fixture.rows, meta: { agent: 'codex', ...(modes ? { modes } : {}) }, buffer, exited: false }])
    const written = vi.spyOn(host.remotes.get('local:5').remote.pty, 'write')
    const result = await Promise.race([shells.chatSend('local:5', 'still there?'), new Promise(resolve => setTimeout(() => resolve('pending'), 3000))])
    if (sends) {
      expect(result).not.toMatchObject({ reason: 'no-composer' })
      expect(written.mock.calls.map(([data]) => data).join('')).toContain('still there?')
    } else {
      expect(result).toMatchObject({ ok: false, reason: 'no-composer' })
    }
    // The tab's terminal gets the same modes after the kept output when it attaches
    expect(shells.attach('local:5')?.backlog.endsWith(sends ? '[?2004h' : '[?2004l')).toBe(true)
  })

  it('hands the shell’s terminal modes over with it', () => {
    const host = fakeHost()
    const { shells } = setup({ host })
    const { id } = shells.open({ cols: 100, rows: 30, cwd: DIR })
    host.remotes.get(id).remote.data('[?2004h[?1h ready')
    shells.handOver()
    expect(host.setMeta).toHaveBeenCalledWith(id, expect.objectContaining({ modes: { '1': true, '2004': true } }))
  })

  // 2026-11-26 user report: after the update, sending from the chat view failed with "에이전트의 입력칸을 찾지
  // 못했습니다" until the terminal was shown once. The wake's screen started empty and an idle CLI draws nothing.
  it.each(readdirSync(new URL('./ipc/fixtures/agent-inbox-pty/', import.meta.url)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)))('reads an adopted agent’s screen from what the host kept (%s), so the chat sends at once', async name => {
    const fixture = JSON.parse(readFileSync(new URL(`./ipc/fixtures/agent-inbox-pty/${name}.json`, import.meta.url), 'utf8'))
    const host = fakeHost()
    const registration = { close: vi.fn(), setStatus: vi.fn() }
    const agents = { adopt: vi.fn(() => registration), adoptShell: vi.fn(), agentsOfShell: vi.fn(() => ['agent-1']), register: vi.fn(), registerShell: vi.fn(() => ({})),
      unreadFor: () => [], unhandledFor: () => [] }
    const { shells } = setup({ host, agents })
    shells.adopt([{ id: 'local:3', pid: 4200, cols: fixture.cols, rows: fixture.rows, meta: { agent: fixture.kind }, buffer: fixture.phases.idle.frame, exited: false }])
    const pty = host.remotes.get('local:3').remote.pty
    const written = vi.spyOn(pty, 'write')
    const result = await Promise.race([shells.chatSend('local:3', 'hello after update'), new Promise(resolve => setTimeout(() => resolve('pending'), 3000))])
    expect(result).not.toMatchObject({ reason: 'no-composer' })
    expect(written.mock.calls.map(([data]) => data).join('')).toContain('hello after update')
  })
})
