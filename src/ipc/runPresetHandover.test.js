// A run preset server outliving an app restarting for an update (docs/plan/2026-11-27-run-presets-survive-update.md)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRunPresets } from './runPresets.js'
import { projectKey, realDirectory } from './runPresetStore.js'

let base
beforeEach(async () => { base = await mkdtemp(path.join(tmpdir(), 'ezshell-run-handover-')) })
afterEach(async () => rm(base, { recursive: true, force: true }))

// One app: its own controller and shells over the same saved presets
function app(root, file, options = {}) {
  const tasks = new Map()
  const operations = []
  const state = { locked: false }
  const shells = {
    async openDevelopmentTask(task) {
      const id = `local:${tasks.size + 1}`
      tasks.set(id, task)
      task.onEvent({ type: 'start', shellId: id, phase: 'server' })
      return { id }
    },
    async changeDevelopmentTask(id, _taskId, action) {
      operations.push([action, id])
      tasks.get(id).onEvent({ type: 'exit', shellId: id, action, exitCode: 1 })
    }
  }
  const reloads = []
  const project = { root, key: projectKey(root), worktree: root, worktreeKey: projectKey(root), cwd: root }
  const controller = createRunPresets({
    file, getShells: () => shells, isLocked: () => state.locked, now: () => 100, projectOf: async () => project,
    prepareReload: async (task, { worktree, mode }) => ({ ...task, hotReload: { port: 57334, worktree, cwd: task.cwd, mode } }),
    startReload: (config, callbacks) => { reloads.push({ config, callbacks }); return { close: vi.fn(), suspend: vi.fn(), resume: vi.fn() } },
    ...options
  })
  const allowed = () => !state.locked
  return { controller, tasks, operations, project, allowed, reloads, state }
}

async function springFixture() {
  const root = await realDirectory(base)
  await writeFile(path.join(root, 'pom.xml'), '<artifactId>spring-boot-starter</artifactId>')
  return { root, file: path.join(root, 'run-presets.json') }
}

// The app before the update: a Spring run with hot reload, started and ready; what it hands over goes through JSON
async function handedOver(root, file) {
  const before = app(root, file)
  const { preset } = await before.controller.save(before.project, { name: 'Spring', kind: 'task', taskId: '.:maven', hotReload: 'standard' }, before.allowed)
  await before.controller.act(before.project, preset.id, 'start', { allowed: before.allowed, approve: () => true })
  const task = before.tasks.get('local:1')
  task.onEvent({ type: 'launched', shellId: 'local:1', pid: 13, env: {} })
  task.onEvent({ type: 'data', shellId: 'local:1', data: 'INFO Started Spring in 1.2 seconds (http://localhost:8080)\r\n' })
  const run = JSON.parse(JSON.stringify(task.handover()))
  return { preset, run, development: { taskId: `preset:${preset.id}`, name: 'Spring', label: 'Spring', cwd: root, url: null, run } }
}

describe('run preset handover on an update', () => {
  it('describes a running server for the next app, without its environment', async () => {
    const { root, file } = await springFixture()
    const { preset, run } = await handedOver(root, file)
    expect(run).toEqual({
      projectRoot: root, worktree: root, presetId: preset.id, startedAt: 100, readyAt: 100, address: expect.any(String),
      expectedUrl: null, scratchOwner: process.pid, tomcat: false, hotReload: { port: 57334, devtools: false }, hotReloadDropped: false
    })
  })

  it('takes the server back: state, log, hot reload on the same port, stop, and its scratch released when it ends', async () => {
    const { root, file } = await springFixture()
    const { preset, development } = await handedOver(root, file)
    const release = vi.fn()
    const protectScratch = vi.fn(() => release)
    const reapScratch = vi.fn(async () => {})
    const next = app(root, file, { protectScratch, reapScratch })
    next.controller.holdKeptScratch([{ id: 'local:1', development }])
    expect(protectScratch).toHaveBeenCalledWith(process.pid)

    const task = await next.controller.adoptRun({ id: 'local:1', development, buffer: 'INFO Started Spring in 1.2 seconds\r\nERROR boom\r\n' })
    expect(task).toMatchObject({ id: `preset:${preset.id}`, cwd: root, runPreset: true, name: 'Spring', label: 'Spring',
      hotReload: { port: 57334, worktree: root, cwd: root, mode: 'standard' } })
    expect(task.filterOutput('listening on 57334\r\n')).not.toContain('57334')
    expect(next.controller.list(next.project).states[preset.id]).toMatchObject({ status: 'running', shellId: 'local:1', startedAt: 100, readyAt: 100, errors: 1 })

    next.tasks.set('local:1', task)
    task.onEvent({ type: 'launched', shellId: 'local:1', pid: 13, env: {} })
    expect(next.reloads).toEqual([expect.objectContaining({ config: task.hotReload, callbacks: expect.objectContaining({ pid: 13 }) })])
    task.onEvent({ type: 'data', shellId: 'local:1', data: 'GET /health\r\n' })
    expect(next.controller.list(next.project).states[preset.id].readyAt).toBe(100)

    await next.controller.act(next.project, preset.id, 'stop', { allowed: next.allowed })
    expect(next.operations).toEqual([['stop', 'local:1']])
    expect(next.controller.list(next.project).states[preset.id].status).toBe('stopped')
    await task.cleanup(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(reapScratch).toHaveBeenCalledTimes(1)
  })

  it('refuses a kept server whose preset is gone, moved or another one, and releases its scratch', async () => {
    const { root, file } = await springFixture()
    const { development } = await handedOver(root, file)
    const releases = []
    const next = app(root, file, { protectScratch: () => { const release = vi.fn(); releases.push(release); return release }, reapScratch: async () => {} })
    await mkdir(path.join(root, 'moved'))
    const variants = [
      { ...development, run: { ...development.run, presetId: '00000000-0000-4000-8000-000000000000' } },
      { ...development, taskId: 'preset:other' },
      { ...development, cwd: path.join(root, 'moved') },
      { ...development, run: { ...development.run, worktree: 'relative' } }
    ]
    next.controller.holdKeptScratch(variants.map((item, index) => ({ id: `local:${index + 1}`, development: item })))
    for (const [index, item] of variants.entries()) {
      await expect(next.controller.adoptRun({ id: `local:${index + 1}`, development: item, buffer: '' })).rejects.toThrow()
    }
    expect(releases.map(release => release.mock.calls.length)).toEqual([1, 1, 1, 1])
  })

  it('keeps a Tomcat server running but says its hot reload needs a restart', async () => {
    const { root, file } = await springFixture()
    const { development } = await handedOver(root, file)
    const next = app(root, file, { reapScratch: async () => {} })
    const tomcat = { ...development, run: { ...development.run, tomcat: true, hotReload: null, hotReloadDropped: true } }
    next.controller.holdKeptScratch([{ id: 'local:1', development: tomcat }])
    const task = await next.controller.adoptRun({ id: 'local:1', development: tomcat, buffer: '' })
    expect(task.hotReload).toBeUndefined()
    expect(task.hotReloadFailure).toContain('재기동')
  })

  it('hands nothing over for a run that is not starting or running', async () => {
    const { root, file } = await springFixture()
    const before = app(root, file)
    const { preset } = await before.controller.save(before.project, { name: 'Spring', kind: 'task', taskId: '.:maven' }, before.allowed)
    await before.controller.act(before.project, preset.id, 'start', { allowed: before.allowed, approve: () => true })
    const task = before.tasks.get('local:1')
    task.onEvent({ type: 'exit', shellId: 'local:1', exitCode: 0 })
    expect(task.handover()).toBeNull()
  })
})
