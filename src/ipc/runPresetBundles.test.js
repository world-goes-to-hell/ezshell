// Run bundles through the run presets IPC and the agent tools (part 3): saved apart from the presets, started and
// stopped in the project's start order with the presets outside the bundle skipped
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRunPresets, registerRunPresetIpc } from './runPresets.js'
import { createRunPresetStore, presetApproval, projectKey, realDirectory } from './runPresetStore.js'
import { pathKey } from '../renderer/lib/localWorkspaceTree'

let base
beforeEach(async () => { base = await mkdtemp(path.join(tmpdir(), 'ezshell-bundle-')) })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

async function fixture() {
  const root = await realDirectory(base)
  const file = path.join(root, 'run-presets.json')
  const folder = path.join(root, 'project')
  await mkdir(folder, { recursive: true })
  const project = { root: folder, key: projectKey(folder), worktree: folder, worktreeKey: pathKey(folder), cwd: folder }
  const clock = { now: 100 }
  const tasks = new Map()
  const operations = []
  const emit = (id, event) => tasks.get(id).onEvent({ shellId: id, ...event })
  const shells = {
    currentDirectory: async () => folder,
    runAuthorityDirectory: async () => folder,
    chatAgentId: () => 'agent-1',
    async openDevelopmentTask(task) {
      const id = `local:${tasks.size + 1}`
      tasks.set(id, task)
      operations.push(['start', task.name])
      emit(id, { type: 'start', phase: 'server' })
      return { id }
    },
    async changeDevelopmentTask(id, _taskId, action) {
      operations.push([action, tasks.get(id).name])
      emit(id, { type: 'exit', action, exitCode: 1 })
    }
  }
  const makeController = (options = {}) => createRunPresets({ file, getShells: () => shells, getAgent: id => id === 'agent-1' ? { id, active: true, shellId: 'agent-shell' } : null,
    isLocked: () => false, now: () => clock.now, jarHome: root, projectOf: async () => project, ...options })
  const controller = makeController()
  const handlers = new Map()
  const frame = {}
  const event = { senderFrame: frame, sender: { mainFrame: frame } }
  registerRunPresetIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, controller, fromMainWindow: e => e.sender === event.sender, isLocked: () => false })
  const invoke = (channel, ...args) => handlers.get(channel)(event, folder, ...args)
  const save = async name => (await invoke('run-presets-save', { name, relative: '.', kind: 'custom', command: `node ${name}.js`, agentControl: true })).preset
  // 모두 실행 asks about each custom command once; answer yes until it starts
  const startAll = async (config = {}) => {
    let result = await invoke('run-preset-start-all', config)
    for (let round = 0; result?.needsConfirm && round < 10; round++) result = await invoke('run-preset-start-all', { ...config, confirmCustom: true })
    return result
  }
  const started = () => operations.filter(([action]) => action === 'start').map(([, name]) => name)
  return { clock, root, folder, project, file, makeController, controller, invoke, save, startAll, started, operations }
}

describe('run bundles', () => {
  it('saves a bundle apart from the presets and lists it with them', async () => {
    const f = await fixture()
    const gateway = await f.save('gateway')
    const order = await f.save('order')
    const saved = await f.invoke('run-preset-bundle-save', { name: '주문 개발', presetIds: [gateway.id, order.id] })
    expect(saved).toMatchObject({ ok: true, bundles: [{ name: '주문 개발', presetIds: [gateway.id, order.id] }] })
    expect((await f.invoke('run-presets-list')).bundles).toEqual(saved.bundles)
    expect(JSON.parse(await readFile(path.join(f.root, 'run-bundles.json'), 'utf8')).projects).toHaveLength(1)
    // Saving a preset does not drop the bundle; deleting one takes it out of the bundle
    await f.save('auth')
    await f.invoke('run-presets-delete', order.id)
    expect((await f.invoke('run-presets-list')).bundles).toEqual([{ ...saved.bundles[0], presetIds: [gateway.id] }])
  })

  it('refuses unknown presets, long names and a repeated name in main', async () => {
    const f = await fixture()
    const gateway = await f.save('gateway')
    expect(await f.invoke('run-preset-bundle-save', { name: 'x', presetIds: ['nope'] })).toMatchObject({ ok: false, error: expect.stringContaining('없는 실행 구성') })
    expect(await f.invoke('run-preset-bundle-save', { name: 'x'.repeat(21), presetIds: [gateway.id] })).toMatchObject({ ok: false })
    await f.invoke('run-preset-bundle-save', { name: '주문', presetIds: [gateway.id] })
    expect(await f.invoke('run-preset-bundle-save', { name: '주문', presetIds: [gateway.id] })).toMatchObject({ ok: false, error: '같은 이름의 묶음이 있습니다.' })
    expect(await f.invoke('run-preset-start-all', { bundleId: 'gone' })).toMatchObject({ ok: false, error: expect.stringContaining('실행 묶음을 찾지 못했습니다') })
    expect(await f.invoke('run-preset-bundle-delete', 'gone')).toMatchObject({ ok: false })
  })

  it('starts only the bundle\u2019s presets in the start order and stops them alone', async () => {
    const f = await fixture()
    const config = await f.save('config')
    const gateway = await f.save('gateway')
    const auth = await f.save('auth')
    const order = (await f.invoke('run-presets-list')).startOrder
    await f.invoke('run-start-order-save', { ...order, stages: [{ ids: [config.id], gate: { kind: 'none' } }, { ids: [auth.id], gate: { kind: 'none' } }, { ids: [gateway.id], gate: { kind: 'none' } }] })
    const { bundles: [bundle] } = await f.invoke('run-preset-bundle-save', { name: '주문 개발', presetIds: [gateway.id, auth.id] })
    expect(await f.startAll({ bundleId: bundle.id })).toMatchObject({ ok: true })
    expect(f.started()).toEqual(['auth', 'gateway'])
    // Another bundle's start does not reuse the answers given for this one
    const { bundles } = await f.invoke('run-preset-bundle-save', { name: '설정만', presetIds: [config.id] })
    expect(await f.invoke('run-preset-start-all', { bundleId: bundles[1].id })).toEqual({ needsConfirm: expect.any(Object) })
    await f.invoke('run-preset-start-all', { bundleId: bundles[1].id, confirmCustom: true })
    expect(f.started()).toEqual(['auth', 'gateway', 'config'])
    expect(await f.invoke('run-preset-stop-all', { bundleId: bundle.id })).toMatchObject({ ok: true })
    const stops = f.operations.filter(([action]) => action === 'stop').map(([, name]) => name)
    expect(stops.sort()).toEqual(['auth', 'gateway'])
  })

  it('lets the agent tools start and stop a bundle by name', async () => {
    const f = await fixture()
    await f.save('gateway')
    const auth = await f.save('auth')
    await f.invoke('run-preset-bundle-save', { name: '주문', presetIds: [auth.id] })
    // The user has accepted both commands before (the agent cannot)
    const store = createRunPresetStore(f.file)
    store.write(f.folder, store.list(f.project.key).map(preset => ({ ...preset, confirmedHash: presetApproval(preset).hash })))
    const controller = f.makeController({ store })
    const tool = request => controller.agentTool('agent-1', request, () => true)
    expect((await tool({ method: 'run-list' })).bundles).toEqual(['주문'])
    expect(await tool({ method: 'run-start-all', bundle: '주문' })).toMatchObject({ ok: true, stages: 1 })
    await vi.waitFor(() => expect(controller.list(f.project).batch).toBeNull())
    expect(f.started()).toEqual(['auth'])
    await expect(tool({ method: 'run-start-all', bundle: '없음' })).rejects.toThrow('실행 묶음을 찾지 못했습니다')
    await tool({ method: 'run-stop-all', bundle: '주문' })
    expect(f.operations.filter(([action]) => action === 'stop').map(([, name]) => name)).toEqual(['auth'])
  })
})
