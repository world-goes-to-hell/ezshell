import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRunPresets, registerRunPresetIpc, resolveProject, withSubject } from './runPresets.js'
import { commandHash, createRunPresetStore, projectKey, realDirectory } from './runPresetStore.js'
import { pathKey } from '../renderer/lib/localWorkspaceTree'
import { withSubject as rendererSubject } from '../renderer/lib/runPresets'

let base
beforeEach(async () => { base = await mkdtemp(path.join(tmpdir(), 'ezshell-run-')) })
afterEach(async () => {
  vi.useRealTimers()
  await rm(base, { recursive: true, force: true })
})

async function fixture() {
  const root = await realDirectory(base)
  const file = path.join(root, 'run-presets.json')
  const outside = path.join(root, 'second-project')
  const folder = path.join(root, 'project')
  const subfolder = path.join(folder, 'sub')
  const checkout = path.join(root, 'other-checkout')
  const checkoutSubfolder = path.join(checkout, 'sub')
  await Promise.all([mkdir(subfolder, { recursive: true }), mkdir(checkoutSubfolder, { recursive: true }), mkdir(outside)])
  const location = (cwd, worktree = cwd, root = worktree) => ({ root, key: projectKey(root), worktree, worktreeKey: pathKey(worktree), cwd })
  const project = location(folder)
  const shellTasks = new Map()
  const operations = []
  const sendAsUser = vi.fn()
  const sendState = vi.fn()
  const notifyCrash = vi.fn()
  const state = { locked: false, now: 100, cwd: subfolder, bound: true }
  const handlers = new Map()
  const frame = {}
  const event = { senderFrame: frame, sender: { mainFrame: frame } }
  const allowed = () => !state.locked
  const emit = (id, event) => shellTasks.get(id).onEvent({ shellId: id, ...event })
  const shells = {
    currentDirectory: async () => state.cwd,
    chatAgentId: () => state.bound ? 'agent-1' : null,
    async openDevelopmentTask(task) {
      if (state.beforeOpen) await state.beforeOpen()
      const id = `local:${shellTasks.size + 1}`
      shellTasks.set(id, task)
      operations.push(['start', task.name, id])
      emit(id, { type: 'start' })
      return { id }
    },
    async changeDevelopmentTask(id, _taskId, action, _allowed, prepare) {
      operations.push([action, shellTasks.get(id).name, id])
      emit(id, { type: 'exit', action, exitCode: 1 })
      if (action === 'restart') {
        shellTasks.set(id, await prepare())
        emit(id, { type: 'start' })
      }
    }
  }
  const makeController = () => createRunPresets({ file, getShells: () => shells, getAgent: id => id === 'agent-1' ? { id, active: true, shellId: 'agent-shell' } : null,
    isLocked: () => state.locked, sendState, sendAsUser, notifyCrash, now: () => state.now, javaHomeOf: id => id === 'jdk-21' ? outside : null,
    projectOf: async cwd => cwd === checkout || cwd === checkoutSubfolder ? { ...location(cwd, checkout, folder), gitWorktree: true } : location(cwd) })
  const controller = makeController()
  const ipc = registerRunPresetIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, controller, fromMainWindow: e => e.sender === event.sender, isLocked: () => state.locked })
  const invoke = (channel, ...args) => handlers.get(channel)(event, folder, ...args)
  const invokeCheckout = (channel, ...args) => handlers.get(channel)(event, checkout, ...args)
  const save = async (name, input = {}) => (await invoke('run-presets-save', { name, relative: '.', kind: 'custom', command: 'npm run dev', ...input })).preset
  const agent = (method, name, fields = {}) => controller.agentTool('agent-1', { method: `run-${method}`, name, ...fields }, allowed)
  const list = () => controller.list(project)
  const start = async (id, command = 'npm run dev') => {
    expect(await invoke('run-preset-start', id)).toEqual({ needsConfirm: { command } })
    expect(await invoke('run-preset-start', id, { confirmCustom: true })).toEqual({ ok: true })
  }
  return { file, outside, folder, subfolder, checkout, checkoutSubfolder, project, controller, makeController, allowed, event, handlers, ipc,
    state, list, operations, emit, save, start, invoke, invokeCheckout, agent, sendAsUser, sendState, notifyCrash, shellTasks }
}

describe('saved project runs', () => {
  it('checks names, env, relative paths and stored data', async () => {
    const f = await fixture()
    await symlink(f.outside, path.join(f.folder, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const input of [{ name: 'a'.repeat(21) }, { relative: '../second-project' }, { relative: 'outside' },
      { env: { a: 'no' } }, { env: { A: 'many\nlines' } }, { env: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`A${i}`, 'x'])) }]) {
      expect(await f.invoke('run-presets-save', { name: 'ok', kind: 'custom', command: 'node dev', ...input })).toMatchObject({ ok: false })
    }
    const preset = await f.save('web', { env: { PORT: '5431' }, confirmedHash: commandHash('npm run dev') })
    expect(preset).toMatchObject({ env: { PORT: '5431' } })
    expect(preset).not.toHaveProperty('confirmedHash')
    const data = JSON.parse(await readFile(f.file, 'utf8'))
    expect(data.projects[0].presets[0]).not.toHaveProperty('confirmedHash')
    data.projects[0].presets.push({ ...preset, name: 'x'.repeat(21) })
    data.projects[0].presets[0].confirmedHash = commandHash('a different command')
    await writeFile(f.file, JSON.stringify(data))
    expect(createRunPresetStore(f.file).list(projectKey(f.folder))).toEqual([preset])
  })

  it('confirms the exact command from the main frame and restarts in one shell', async () => {
    const f = await fixture()
    const saved = await f.save('web', { jdk: 'jdk-21', env: { PORT: '26789' } })
    const { id } = saved
    const unauthorized = await f.handlers.get('run-preset-start')({ ...f.event, senderFrame: {} }, f.folder, id)
    expect(unauthorized.ok).toBe(false)
    expect(await f.invoke('run-preset-start', id, { confirmCustom: true })).toEqual({ needsConfirm: { command: 'npm run dev' } })
    await f.save('web', { ...saved, command: 'node dev.js' })
    expect(await f.invoke('run-preset-start', id, { confirmCustom: true })).toEqual({ needsConfirm: { command: 'node dev.js' } })
    expect(f.operations).toEqual([])
    expect(await f.invoke('run-preset-start', id, { confirmCustom: true })).toEqual({ ok: true })
    const shellId = f.list().states[id].shellId
    expect(f.shellTasks.get(shellId)).toMatchObject({ env: { PORT: '26789' }, javaHome: f.outside })
    expect(await f.invoke('run-preset-restart', id)).toEqual({ ok: true })
    expect(f.operations).toEqual([['start', 'web', shellId], ['restart', 'web', shellId]])
    expect(f.notifyCrash).not.toHaveBeenCalled()
    expect(f.sendState).toHaveBeenLastCalledWith(expect.objectContaining({ id, state: expect.objectContaining({ shellId, status: 'starting' }) }))
    expect(createRunPresetStore(f.file).list(projectKey(f.folder))[0].confirmedHash).toBe(commandHash('node dev.js'))
  })

  it('checks shell binding, project, lock, per-preset control and the user stop window', async () => {
    const f = await fixture()
    const web = await f.save('web')
    const privatePreset = await f.save('private', { agentControl: false })
    expect(await f.agent('list')).toMatchObject({ presets: [{ name: 'web' }, { name: 'private', agentControl: false }] })
    await expect(f.agent('start', 'private')).rejects.toThrow('꺼져')
    await expect(f.agent('restart', 'private')).rejects.toThrow('꺼져')
    await expect(f.agent('stop', 'private')).rejects.toThrow('꺼져')
    expect(await f.agent('wait', 'private')).toEqual({ result: 'idle', status: 'idle' })
    await f.start(privatePreset.id)
    const privateShell = f.list().states[privatePreset.id].shellId
    f.emit(privateShell, { type: 'data', data: 'VITE v5 ready in 11 ms\nERROR compile failed\n' })
    expect(await f.agent('wait', 'private')).toEqual({ result: 'ready', status: 'running' })
    expect(await f.agent('log', 'private', { errors: true })).toEqual({ groups: [{ at: 100, lines: ['ERROR compile failed'] }] })
    await expect(f.agent('start', 'web')).rejects.toThrow('사용자가')
    f.state.bound = false
    await expect(f.agent('list')).rejects.toThrow('작업 폴더')
    f.state.bound = true
    f.state.cwd = f.outside
    await expect(f.agent('start', 'web')).rejects.toThrow('찾을 수 없습니다')
    f.state.cwd = f.subfolder
    await f.start(web.id)
    const shellId = f.list().states[web.id].shellId
    const waiting = f.agent('wait', 'web', { seconds: 2 })
    f.emit(shellId, { type: 'data', data: 'VITE v5 ready in 11 ms\r\n  Local: http://localhost:26789/\r\n' })
    expect(await waiting).toMatchObject({ result: 'ready', status: 'running' })
    await f.invoke('run-preset-stop', web.id)
    await expect(f.agent('restart', 'web')).rejects.toThrow('방금 중지')
    f.state.now += 30_000
    expect(await f.agent('start', 'web')).toEqual({ ok: true })
    expect(f.list().states[web.id].lastAction).toMatchObject({ by: 'agent-1', action: 'start' })
    f.state.locked = true
    await expect(f.agent('log', 'web')).rejects.toThrow('잠금')
    expect(await f.invoke('run-preset-stop', web.id)).toMatchObject({ ok: false })
  })

  it('confirms a batch before starting, follows its order and waits for the previous preset', async () => {
    const f = await fixture()
    const front = await f.save('front', { command: 'node front.js', waitReady: true })
    const back = await f.save('back', { command: 'node back.js' })
    await f.save('manual', { inAll: false })
    expect(await f.invoke('run-presets-reorder', [back.id, front.id, f.list().presets[2].id])).toEqual({ ok: true })
    expect(await f.invoke('run-preset-start-all')).toEqual({ needsConfirm: { command: 'node back.js' } })
    expect(await f.invoke('run-preset-start-all', { confirmCustom: true })).toEqual({ needsConfirm: { command: 'node front.js' } })
    expect(f.operations).toEqual([])
    const batch = f.invoke('run-preset-start-all', { confirmCustom: true })
    await vi.waitFor(() => expect(f.operations).toEqual([['start', 'back', 'local:1']]))
    f.emit('local:1', { type: 'data', data: 'VITE v5 ready in 10 ms\n' })
    expect(await batch).toEqual({ ok: true })
    expect(f.operations.map(([, name]) => name)).toEqual(['back', 'front'])
  })

  it('requires a fresh install confirmation and denies dependency installation to an agent', async () => {
    const f = await fixture()
    await writeFile(path.join(f.folder, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }))
    const { candidates } = await f.invoke('run-presets-candidates', '.')
    const saved = await f.save('web', { kind: 'task', taskId: candidates[0].taskId })
    const install = process.platform === 'win32' ? 'npm.cmd install' : 'npm install'
    await expect(f.agent('start', 'web')).rejects.toThrow('의존성 설치가 필요합니다')
    expect(await f.invoke('run-preset-start', saved.id, { confirmInstall: true })).toEqual({ needsInstall: { command: install } })
    expect(await f.invoke('run-preset-start', saved.id, { confirmInstall: true })).toEqual({ ok: true })
    expect(f.shellTasks.get('local:1').installCommand).toBe(install)
    expect(await f.invoke('run-preset-restart', saved.id, { confirmInstall: true })).toEqual({ needsInstall: { command: install } })
    expect(f.operations).toHaveLength(1)
    await mkdir(path.join(f.folder, 'node_modules'))
    expect(await f.invoke('run-preset-restart', saved.id)).toEqual({ ok: true })
    expect(f.shellTasks.get('local:1').installCommand).toBeUndefined()
  })

  it('delivers clean crash details only to a same-project agent and honors notify', async () => {
    const f = await fixture()
    const { id } = await f.save('web')
    await f.start(id)
    f.emit('local:1', { type: 'data', data: '\x1b[31mERROR failed\x1b[0m\r\n    at fixture (main.js:1:2)\r\n' })
    f.emit('local:1', { type: 'exit', exitCode: 1 })
    f.emit('local:1', { type: 'exit', exitCode: 1 })
    expect(f.notifyCrash).toHaveBeenCalledExactlyOnceWith('project', 'web')
    expect(f.list().states[id]).toMatchObject({ status: 'crashed', exitCode: 1, errors: 1 })
    expect(await f.agent('log', 'web', { lines: 2 })).toEqual({ lines: ['ERROR failed', '    at fixture (main.js:1:2)'] })
    expect(await f.invoke('run-preset-send', id, 'agent-1', '확인 부탁합니다')).toEqual({ ok: true })
    expect(f.sendAsUser.mock.calls[0][0]).toMatchObject({ to: 'agent-1', text: expect.stringContaining('ERROR failed\n    at fixture (main.js:1:2)\n\n확인 부탁합니다') })
    f.state.cwd = f.outside
    expect(await f.invoke('run-preset-send', id, 'agent-1', '')).toMatchObject({ ok: false })
    const silent = await f.save('quiet', { notify: false })
    await f.start(silent.id)
    f.emit('local:2', { type: 'exit', exitCode: 1 })
    expect(f.notifyCrash).toHaveBeenCalledTimes(1)
  })

  it('previews the exact body from the main frame and keeps it when the run changes before sending', async () => {
    const f = await fixture()
    const { id } = await f.save('web', { relative: 'sub' })
    await f.start(id)
    f.emit('local:1', { type: 'data', data: `ERROR failure ${'x'.repeat(1500)}\n${'    at fixture (src/very-long-fixture-name/main.js:1:2)\n'.repeat(80)}` })
    f.emit('local:1', { type: 'exit', exitCode: 2 })
    const preview = (event = f.event) => f.handlers.get('run-preset-send-preview')(event, f.folder, id)
    await expect(preview({ ...f.event, senderFrame: {} })).resolves.toMatchObject({ ok: false })
    f.state.locked = true
    await expect(preview()).resolves.toMatchObject({ ok: false })
    f.state.locked = false
    const { text } = await preview()
    expect(text).toMatch(/^web\n폴더 sub\/\n실행 방식 직접 입력\n종료 코드 2\n\nERROR failure/)
    expect(text).not.toContain(f.folder)
    expect(text).toHaveLength(3998)
    expect(await f.invoke('run-preset-restart', id)).toEqual({ ok: true })
    const note = 'n'.repeat(4000)
    expect(await f.invoke('run-preset-send', id, 'agent-1', note)).toEqual({ ok: true })
    expect(f.sendAsUser).toHaveBeenLastCalledWith({ to: 'agent-1', text: `${text}\n\n${note}` })
    expect(f.sendAsUser.mock.lastCall[0].text.length).toBeLessThanOrEqual(8000)
    const fresh = await preview()
    expect(fresh.text).not.toContain('ERROR failure')
    expect(await f.invoke('run-preset-send', id, 'agent-1', '  ')).toEqual({ ok: true })
    expect(f.sendAsUser).toHaveBeenLastCalledWith({ to: 'agent-1', text: fresh.text })
  })

  it('resolves the primary project and current worktree separately in a real Git repository', async () => {
    const f = await fixture()
    const linked = path.join(base, 'linked-checkout')
    const git = (...args) => execFileSync('git', args, { cwd: f.folder, stdio: 'pipe', windowsHide: true })
    git('init')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Fixture')
    git('worktree', 'add', '--detach', linked)
    const nested = path.join(linked, 'nested')
    await mkdir(nested)
    expect(await resolveProject(nested)).toMatchObject({ root: f.folder, key: pathKey(f.folder), worktree: await realDirectory(linked), worktreeKey: pathKey(await realDirectory(linked)) })
  })

  it('shares presets across worktrees and keeps user and agent actions within their worktree', async () => {
    const f = await fixture()
    const preset = await f.save('web', { relative: 'sub' })
    const { id } = preset
    await f.start(id)
    const other = await f.invokeCheckout('run-presets-list')
    expect(other).toEqual({ projectKey: pathKey(f.folder), worktreeKey: pathKey(f.checkout), presets: [preset],
      states: { [id]: { status: 'idle', errors: 0 } } })
    expect(f.shellTasks.get('local:1').cwd).toBe(f.subfolder)
    f.state.cwd = f.checkoutSubfolder
    expect((await f.agent('list')).presets[0].status).toBe('idle')
    expect(await f.agent('start', 'web')).toEqual({ ok: true })
    expect(f.shellTasks.get('local:2').cwd).toBe(f.checkoutSubfolder)
    expect(f.sendState).toHaveBeenLastCalledWith({ projectKey: pathKey(f.folder), worktreeKey: pathKey(f.checkout), id,
      state: expect.objectContaining({ shellId: 'local:2', lastAction: { by: 'agent-1', action: 'start', at: 100 } }), firstAgentAction: true })
    f.emit('local:2', { type: 'data', data: 'ERROR in other checkout\n' })
    expect(await f.invoke('run-preset-errors', id)).toEqual({ groups: [] })
    expect(await f.agent('log', 'web', { lines: 1 })).toEqual({ lines: ['ERROR in other checkout'] })
    expect(await f.invoke('run-preset-stop-all')).toEqual({ ok: true })
    expect(f.list().states[id].status).toBe('stopped')
    expect((await f.invokeCheckout('run-presets-list')).states[id]).toMatchObject({ status: 'starting', shellId: 'local:2' })
    await expect(f.agent('restart', 'web')).resolves.toEqual({ ok: true })
    expect(f.operations.at(-1)).toEqual(['restart', 'web', 'local:2'])
    expect(await f.invoke('run-presets-delete', id)).toMatchObject({ ok: false })
  })

  it('persists the first agent start or restart notice once per preset across worktrees and app reloads', async () => {
    const f = await fixture()
    const preset = await f.save('web', { agentActionNotified: true })
    await f.start(preset.id)
    expect(f.sendState.mock.calls.some(([event]) => event.firstAgentAction)).toBe(false)
    await f.agent('restart', 'web')
    f.state.cwd = f.checkoutSubfolder
    await f.agent('start', 'web')
    const notices = () => f.sendState.mock.calls.map(([event]) => event).filter(event => event.firstAgentAction)
    expect(notices()).toEqual([expect.objectContaining({ worktreeKey: pathKey(f.folder), state: expect.objectContaining({ lastAction: expect.objectContaining({ action: 'restart' }) }) })])
    await f.save('web', preset)
    expect(createRunPresetStore(f.file).list(projectKey(f.folder))[0].agentActionNotified).toBe(true)
    expect(f.list().presets[0]).not.toHaveProperty('agentActionNotified')
    await f.makeController().agentTool('agent-1', { method: 'run-start', name: 'web' }, f.allowed)
    expect(notices()).toHaveLength(1)
  })

  it('resolves each task against the package manifest in the selected checkout', async () => {
    const f = await fixture()
    await Promise.all([writeFile(path.join(f.folder, 'package.json'), JSON.stringify({ scripts: { dev: 'node dev.js' } })),
      writeFile(path.join(f.checkout, 'package.json'), JSON.stringify({ scripts: { serve: 'node serve.js' } })),
      mkdir(path.join(f.folder, 'node_modules')), mkdir(path.join(f.checkout, 'node_modules'))])
    const { candidates } = await f.invoke('run-presets-candidates', '.')
    const saved = await f.save('web', { kind: 'task', taskId: candidates[0].taskId })
    expect(await f.invoke('run-preset-start', saved.id)).toEqual({ ok: true })
    expect(await f.invokeCheckout('run-preset-start', saved.id)).toEqual({ ok: true })
    expect(f.shellTasks.get('local:1')).toMatchObject({ cwd: f.folder, command: expect.stringMatching(/ run dev$/) })
    expect(f.shellTasks.get('local:2')).toMatchObject({ cwd: f.checkout, command: expect.stringMatching(/ run serve$/) })
  })

  it('waits for a launch already in progress before stopping it', async () => {
    const f = await fixture()
    const preset = await f.save('web')
    const entered = Promise.withResolvers()
    const resume = Promise.withResolvers()
    f.state.beforeOpen = () => { entered.resolve(); return resume.promise }
    await f.invoke('run-preset-start', preset.id)
    const starting = f.invoke('run-preset-start', preset.id, { confirmCustom: true })
    await entered.promise
    const stopping = f.controller.stopAll(f.project, f.allowed)
    expect(f.operations).toEqual([])
    resume.resolve()
    expect(await starting).toEqual({ ok: true })
    expect(await stopping).toEqual({ ok: true })
    expect(f.operations.map(([action]) => action)).toEqual(['start', 'stop'])
    expect(f.list().states[preset.id]).toMatchObject({ status: 'stopped', lastAction: { action: 'stop', by: 'user' } })
  })

  it('reports a transition still busy after the 10 second stop-all budget', async () => {
    const f = await fixture()
    const preset = await f.save('web')
    const entered = Promise.withResolvers()
    const resume = Promise.withResolvers()
    f.state.beforeOpen = () => { entered.resolve(); return resume.promise }
    await f.invoke('run-preset-start', preset.id)
    const starting = f.invoke('run-preset-start', preset.id, { confirmCustom: true })
    await entered.promise
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let settled = false
    const stopping = f.controller.stopAll(f.project, f.allowed).catch(error => { settled = true; return error.message })
    await vi.advanceTimersByTimeAsync(9999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await stopping).toContain('10초')
    resume.resolve()
    await starting
    await vi.waitFor(() => expect(f.list().states[preset.id]).toMatchObject({ status: 'stopped' }))
  })

  it.each(['백엔드', '웹앱', 'Vite', '서버2', '서버3'])('matches the renderer subject particle for %s', name => {
    expect(withSubject(name)).toBe(rendererSubject(name))
  })
})
