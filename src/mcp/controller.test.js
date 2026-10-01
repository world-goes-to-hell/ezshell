import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import controllerModule from './controller.js'
import activityModule from './activityLog.js'

const { createMcpController } = controllerModule

function fakeServerFactory({ failWith } = {}) {
  const calls = { start: 0, stop: 0 }
  const factory = ({ getConfig }) => {
    let port = null
    return {
      async start() {
        calls.start++
        if (failWith) throw failWith
        await new Promise((r) => setTimeout(r, 5))
        port = getConfig().port
      },
      async stop() { calls.stop++; await new Promise((r) => setTimeout(r, 5)); port = null },
      isRunning: () => port !== null,
      port: () => port
    }
  }
  return { factory, calls }
}

function setup(options = {}, extra = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-controller-'))
  const server = fakeServerFactory(options)
  const approvals = { cancelAll: vi.fn(), respond: vi.fn(() => true), request: vi.fn() }
  const gateway = { closeAll: vi.fn(), forgetCwds: vi.fn(), getCwd: () => null }
  const controller = createMcpController({
    userDataPath,
    version: 'test',
    isUnlocked: () => true,
    loadSessions: () => [],
    loadFolders: () => [],
    showApproval: () => true,
    dismissApproval: () => {},
    ...(extra.emitActivity ? { emitActivity: extra.emitActivity } : {}),
    deps: { createServer: server.factory, approvals, gateway, ...(extra.activity ? { activity: extra.activity } : {}) }
  })
  return { controller, server, approvals, gateway, userDataPath }
}

describe('createMcpController', () => {
  it('delegates activity listing and cancelling', () => {
    const activity = { list: vi.fn(() => [{ id: 'r1' }]), cancel: vi.fn(() => true), begin() {}, update() {} }
    const { controller } = setup({}, { activity })
    expect(controller.listActivity()).toEqual([{ id: 'r1' }])
    expect(controller.cancelActivity('r1')).toBe(true)
    expect(activity.cancel).toHaveBeenCalledWith('r1')
  })

  it('clears the activity record when the app locks (final fix I4)', async () => {
    const { createActivityLog } = activityModule
    const emitted = []
    const activity = createActivityLog({ emit: (item) => emitted.push(item) })
    activity.begin({ id: 'r1', time: 't', sessionId: 's', sessionName: 'dev', command: 'ls', level: 'low', reasons: [], state: 'done' })
    emitted.length = 0
    const { controller, approvals, gateway } = setup({}, { activity })
    controller.onLocked()
    expect(approvals.cancelAll).toHaveBeenCalled()
    expect(gateway.closeAll).toHaveBeenCalled()
    expect(controller.listActivity()).toEqual([])
    expect(emitted).toEqual([])
  })

  it('forgets working directories after closing connections when the app locks (final fix C2a)', () => {
    const { controller, gateway } = setup()
    controller.onLocked()
    expect(gateway.forgetCwds).toHaveBeenCalledTimes(1)
    expect(gateway.closeAll.mock.invocationCallOrder[0]).toBeLessThan(gateway.forgetCwds.mock.invocationCallOrder[0])
  })

  it('keeps working directories when sessions are saved or the server stops', async () => {
    const { controller, gateway } = setup()
    controller.onSessionsSaved()
    await controller.updateConfig({ enabled: true })
    await controller.updateConfig({ enabled: false })
    expect(gateway.closeAll).toHaveBeenCalledTimes(2)
    expect(gateway.forgetCwds).not.toHaveBeenCalled()
  })

  it('stays off by default', async () => {
    const { controller, server } = setup()
    expect((await controller.start()).running).toBe(false)
    expect(server.calls.start).toBe(0)
  })

  it('starts when enabled and shows the register command', async () => {
    const { controller } = setup()
    const status = await controller.updateConfig({ enabled: true })
    expect(status.running).toBe(true)
    expect(status.error).toBeNull()
    expect(status.registerCommand).toBe(
      `claude mcp add --transport http my-ssh-client http://127.0.0.1:47521/mcp --header "Authorization: Bearer ${status.config.token}"`
    )
  })

  it('explains a port that is already in use', async () => {
    const { controller } = setup({ failWith: Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }) })
    const status = await controller.updateConfig({ enabled: true })
    expect(status.running).toBe(false)
    expect(status.error).toBe('포트 47521 이(가) 이미 사용 중입니다. 다른 포트를 지정하세요.')
  })

  it('stops and drops connections when disabled', async () => {
    const { controller, server, approvals, gateway } = setup()
    await controller.updateConfig({ enabled: true })
    const status = await controller.updateConfig({ enabled: false })
    expect(status.running).toBe(false)
    expect(server.calls.stop).toBe(1)
    expect(approvals.cancelAll).toHaveBeenCalled()
    expect(gateway.closeAll).toHaveBeenCalled()
  })

  it('restarts on a new port', async () => {
    const { controller, server } = setup()
    await controller.updateConfig({ enabled: true })
    const status = await controller.updateConfig({ port: 50000 })
    expect(server.calls).toEqual({ start: 2, stop: 1 })
    expect(status.registerCommand).toContain('http://127.0.0.1:50000/mcp')
  })

  it('rejects invalid settings', async () => {
    const { controller } = setup()
    await expect(controller.updateConfig({ port: 1 })).rejects.toThrow('포트')
  })

  it('keeps the server running when the token changes', async () => {
    const { controller, server } = setup()
    const before = (await controller.updateConfig({ enabled: true })).config.token
    const status = await controller.regenerateToken()
    expect(status.config.token).not.toBe(before)
    expect(status.running).toBe(true)
    expect(server.calls.start).toBe(1)
  })

  it('cancels approvals and closes connections when the app locks', () => {
    const { controller, approvals, gateway } = setup()
    controller.onLocked()
    expect(approvals.cancelAll).toHaveBeenCalled()
    expect(gateway.closeAll).toHaveBeenCalled()
  })

  it('closes connections when sessions are saved', () => {
    const { controller, gateway } = setup()
    controller.onSessionsSaved()
    expect(gateway.closeAll).toHaveBeenCalled()
  })

  it('stores settings in mcp.json', async () => {
    const { controller, userDataPath } = setup()
    await controller.updateConfig({ enabled: true })
    expect(JSON.parse(fs.readFileSync(path.join(userDataPath, 'mcp.json'), 'utf8')).enabled).toBe(true)
  })

  it('forwards approval answers', () => {
    const { controller, approvals } = setup()
    expect(controller.respondApproval('a1', true)).toBe(true)
    expect(approvals.respond).toHaveBeenCalledWith('a1', true)
  })

  it('stops the server on shutdown', async () => {
    const { controller, server } = setup()
    await controller.updateConfig({ enabled: true })
    await controller.shutdown()
    expect(server.calls.stop).toBe(1)
    expect(controller.getStatus().running).toBe(false)
  })
})

describe('lifecycle serialization', () => {
  it('ends stopped after an unawaited on/off toggle', async () => {
    const { controller, server } = setup()
    const on = controller.updateConfig({ enabled: true })
    const off = controller.updateConfig({ enabled: false })
    await Promise.all([on, off])
    expect(controller.getStatus().running).toBe(false)
    expect(server.calls).toEqual({ start: 1, stop: 1 })
  })

  it('ends running after an unawaited off/on toggle', async () => {
    const { controller, server } = setup()
    await controller.updateConfig({ enabled: true })
    const off = controller.updateConfig({ enabled: false })
    const on = controller.updateConfig({ enabled: true })
    await Promise.all([off, on])
    expect(controller.getStatus().running).toBe(true)
    expect(server.calls).toEqual({ start: 2, stop: 1 })
  })

  it('does not let a rejected update block the next one', async () => {
    const { controller } = setup()
    const bad = controller.updateConfig({ port: 1 })
    const good = controller.updateConfig({ enabled: true })
    await expect(bad).rejects.toThrow('포트')
    expect((await good).running).toBe(true)
  })
})
