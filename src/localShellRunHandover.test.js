// Run preset servers outliving an app restarting for an update (docs/plan/2026-11-27-run-presets-survive-update.md)
import { describe, it, expect, vi } from 'vitest'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createLocalShells } from './localShell.js'
import { remotePty } from './sessionHost/client.js'

const DIR = realpathSync(tmpdir())

function fakePty() {
  const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pid: 900 }
  pty.onData = cb => { pty.emit = cb }
  pty.onExit = cb => { pty.exit = cb }
  return pty
}

// The session host client, in memory. A spawned shell gets its pid only when the host answers (`started`).
function fakeHost() {
  const sent = []
  const remotes = new Map()
  const byPty = new Map()
  return {
    sent, remotes, byPty,
    ready: () => true,
    spawn: vi.fn((id, file, args, options, meta) => {
      const remote = remotePty(id, message => sent.push(message))
      remotes.set(id, { remote, meta, options })
      byPty.set(remote.pty, remote)
      return remote.pty
    }),
    adopt: vi.fn(shell => {
      const remote = remotePty(shell.id, message => sent.push(message))
      remote.started(shell.pid)
      remotes.set(shell.id, { remote })
      return remote.pty
    }),
    setMeta: vi.fn(),
    forget: vi.fn()
  }
}

function setup({ host, spawn = vi.fn(() => fakePty()), ...options } = {}) {
  const sent = []
  const killTrees = vi.fn()
  const stopDevelopmentProcess = vi.fn(async pty => pty.hosted ? host.byPty.get(pty)?.exit(1) : pty.exit?.({ exitCode: 1 }))
  const shells = createLocalShells({
    spawn, send: (channel, payload) => sent.push({ channel, payload }), killTrees, stopDevelopmentProcess, platform: 'win32',
    shell: { file: 'powershell.exe', args: [], name: 'PowerShell' }, cwd: DIR, env: {}, commandLine: async () => '', host, spawn, ...options
  })
  return { shells, sent, spawn, killTrees, stopDevelopmentProcess }
}

const handover = { presetId: 'p1', worktree: DIR, scratchOwner: 4242 }
const serverTask = (extra = {}) => ({
  id: 'preset:p1', name: 'API', label: 'API', cwd: DIR, command: 'gradlew bootRun', runPreset: true, expectedUrl: 'http://localhost:8080',
  onEvent: vi.fn(), cleanup: vi.fn(), handover: () => handover, ...extra
})

describe('run preset servers in the session host', () => {
  it('opens a run preset server in the host and reports its pid once the host started it', async () => {
    const host = fakeHost()
    const { shells, spawn } = setup({ host })
    const task = serverTask()
    const { id } = await shells.openDevelopmentTask(task, { cols: 80, rows: 24 })
    expect(spawn).not.toHaveBeenCalled()
    expect(host.spawn).toHaveBeenCalledWith(id, 'powershell.exe', expect.any(Array), expect.objectContaining({ cwd: DIR }), { development: true })
    expect(task.onEvent.mock.calls.some(([event]) => event.type === 'launched')).toBe(false)
    host.remotes.get(id).remote.started(5150)
    await vi.waitFor(() => expect(task.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'launched', shellId: id, pid: 5150 })))
  })

  // The host refuses a second shell under an id it still holds: a restart in the same tab failed with exit -1
  it('lets the host forget an ended server, so a restart opens it again under the same id', async () => {
    const host = fakeHost()
    const { shells } = setup({ host })
    const task = serverTask()
    const { id } = await shells.openDevelopmentTask(task, {})
    host.remotes.get(id).remote.started(5150)
    await shells.changeDevelopmentTask(id, task.id, 'stop')
    expect(host.forget).toHaveBeenCalledWith(id)
    await shells.changeDevelopmentTask(id, task.id, 'restart', () => true, async () => serverTask())
    expect(host.spawn).toHaveBeenCalledTimes(2)
    expect(host.spawn.mock.calls[1][0]).toBe(id)
  })

  it('keeps other development tasks and a build step in the app, and opens the server after the build in the host', async () => {
    const host = fakeHost()
    const ptys = []
    const { shells, spawn } = setup({ host, spawn: vi.fn(() => { const pty = fakePty(); ptys.push(pty); return pty }) })
    await shells.openDevelopmentTask({ id: 'dev:x', name: 'Dev', cwd: DIR, command: 'npm run dev' }, {})
    const runtime = serverTask({ id: 'preset:p2' })
    const { id } = await shells.openDevelopmentTask(serverTask({ id: 'preset:p2', preparation: { command: 'mvn package', finish: async () => runtime } }), {})
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(host.spawn).not.toHaveBeenCalled()
    ptys[1].exit({ exitCode: 0 })
    await vi.waitFor(() => expect(host.spawn).toHaveBeenCalledWith(id, 'powershell.exe', expect.any(Array), expect.any(Object), { development: true }))
  })

  it('on an update keeps a hosted server running and hands it over, and ends the rest', async () => {
    const host = fakeHost()
    const { shells, spawn, killTrees, stopDevelopmentProcess } = setup({ host })
    const kept = serverTask()
    const { id } = await shells.openDevelopmentTask(kept, {})
    host.remotes.get(id).remote.started(5150)
    host.remotes.get(id).remote.data('Started Api in 3.2 seconds\r\n')
    const noHandover = serverTask({ id: 'preset:p3', handover: () => null })
    const ended = (await shells.openDevelopmentTask(noHandover, {})).id
    host.remotes.get(ended).remote.started(5151)
    await shells.openDevelopmentTask({ id: 'dev:x', name: 'Dev', cwd: DIR, command: 'npm run dev' }, {})
    expect(spawn).toHaveBeenCalledTimes(1)

    await shells.drainDevelopmentTasks({ keepHosted: true })
    expect(stopDevelopmentProcess).toHaveBeenCalledTimes(2)
    expect(stopDevelopmentProcess.mock.calls.map(([pty]) => pty.pid)).not.toContain(5150)
    expect(kept.cleanup).not.toHaveBeenCalled()

    shells.handOver()
    expect(host.setMeta).toHaveBeenCalledWith(id, expect.objectContaining({
      development: expect.objectContaining({ taskId: 'preset:p1', name: 'API', label: 'API', cwd: DIR, run: handover })
    }))
    expect(host.setMeta.mock.calls.map(([shellId]) => shellId)).toEqual([id])
    expect(killTrees).not.toHaveBeenCalledWith(expect.arrayContaining([5150]))
  })

  it('takes a kept server back once its run preset is checked, with the output it printed meanwhile', async () => {
    const host = fakeHost()
    const { shells, sent } = setup({ host })
    const meta = { development: { taskId: 'preset:p1', name: 'API', label: 'API', cwd: DIR, url: 'http://localhost:8080', run: handover } }
    expect(shells.adopt([{ id: 'local:4', pid: 5150, meta, buffer: 'Started Api\r\n', cols: 100, rows: 30, exited: false }])).toEqual([])
    const [record] = shells.takeKeptDevelopment()
    expect(record).toMatchObject({ id: 'local:4', development: meta.development })
    expect(shells.takeKeptDevelopment()).toEqual([])
    host.remotes.get('local:4').remote.data('GET /health\r\n')

    const task = serverTask()
    shells.adoptDevelopment('local:4', task)
    expect(shells.list()).toContainEqual(expect.objectContaining({ id: 'local:4', exited: false,
      development: expect.objectContaining({ taskId: 'preset:p1', status: 'running', runPreset: true, url: 'http://localhost:8080' }) }))
    expect(shells.attach('local:4').backlog).toContain('Started Api\r\nGET /health\r\n')
    await vi.waitFor(() => expect(task.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'launched', shellId: 'local:4', pid: 5150 })))
    expect(task.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'data', data: 'GET /health\r\n' }))
    expect(task.onEvent.mock.calls.some(([event]) => event.type === 'start')).toBe(false)
    // New shells do not take the kept id
    expect(shells.open({}).id).toBe('local:5')

    host.remotes.get('local:4').remote.exit(0)
    expect(task.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'exit', shellId: 'local:4', exitCode: 0 }))
    await vi.waitFor(() => expect(task.cleanup).toHaveBeenCalled())
    expect(sent).toContainEqual({ channel: 'local-shell-exit', payload: { id: 'local:4', exitCode: 0 } })
  })

  it('ends a kept server whose run preset could not be checked', () => {
    const host = fakeHost()
    const { shells, killTrees } = setup({ host })
    shells.adopt([{ id: 'local:4', pid: 5150, meta: { development: { taskId: 'preset:p1', name: 'API', cwd: DIR, run: handover } }, buffer: '', exited: false }])
    shells.dropKeptDevelopment('local:4')
    expect(killTrees).toHaveBeenCalledWith([5150])
    expect(host.forget).toHaveBeenCalledWith('local:4')
    expect(shells.list()).toEqual([])
  })

  it('ends a kept development shell that came without a run to hand over', () => {
    const host = fakeHost()
    const { shells, killTrees } = setup({ host })
    expect(shells.adopt([{ id: 'local:6', pid: 5152, meta: { development: true }, buffer: '', exited: false }])).toEqual([])
    expect(killTrees).toHaveBeenCalledWith([5152])
    expect(shells.takeKeptDevelopment()).toEqual([])
  })
})
