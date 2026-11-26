import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
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
})
