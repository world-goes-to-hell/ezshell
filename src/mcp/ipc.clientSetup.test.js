import { describe, it, expect, vi } from 'vitest'
import ipcModule from './ipc.js'

const { registerMcpIpc } = ipcModule

function setup({ unlocked = true, picked = ['D:\\work\\app'], controller } = {}) {
  const handlers = {}
  const ipcMain = { handle: (channel, fn) => { handlers[channel] = fn } }
  const answers = [...picked]
  const pickDirectory = vi.fn(async () => (answers.length ? answers.shift() : null))
  const ctrl = controller === undefined ? { setupClient: vi.fn(async (request) => ({ result: 'added', request })) } : controller
  registerMcpIpc(ipcMain, () => ctrl, () => unlocked, { pickDirectory })
  const call = (payload) => handlers['mcp-setup-client']({}, payload)
  return { call, pickDirectory, controller: ctrl }
}

describe('mcp-setup-client', () => {
  it('lets the main process pick the project folder, never the renderer', async () => {
    const { call, pickDirectory, controller } = setup()
    const reply = await call({ scope: 'project', projectDir: 'C:\\Windows', setTokenEnv: true })
    expect(pickDirectory).toHaveBeenCalledTimes(1)
    expect(controller.setupClient).toHaveBeenCalledWith({ scope: 'project', projectDir: 'D:\\work\\app', overwrite: false, setTokenEnv: true })
    expect(reply).toEqual({ success: true, outcome: expect.objectContaining({ result: 'added' }) })
  })

  it('reuses the folder picked last time for the overwrite answer', async () => {
    const { call, pickDirectory, controller } = setup()
    await call({ scope: 'project' })
    await call({ scope: 'project', overwrite: true, reuseDir: true })
    expect(pickDirectory).toHaveBeenCalledTimes(1)
    expect(controller.setupClient).toHaveBeenLastCalledWith({ scope: 'project', projectDir: 'D:\\work\\app', overwrite: true, setTokenEnv: false })
  })

  it('asks to pick again when there is no earlier folder', async () => {
    const { call, controller } = setup()
    expect(await call({ scope: 'project', reuseDir: true })).toEqual({ success: false, error: '프로젝트 폴더를 다시 고르세요.' })
    expect(controller.setupClient).not.toHaveBeenCalled()
  })

  it('reports a cancelled folder dialog without an error', async () => {
    const { call, controller } = setup({ picked: [] })
    expect(await call({ scope: 'project' })).toEqual({ success: false, cancelled: true })
    expect(controller.setupClient).not.toHaveBeenCalled()
  })

  it('does not open a dialog for the global scope', async () => {
    const { call, pickDirectory, controller } = setup()
    await call({ scope: 'global', overwrite: 'yes', setTokenEnv: 1 })
    expect(pickDirectory).not.toHaveBeenCalled()
    expect(controller.setupClient).toHaveBeenCalledWith({ scope: 'global', projectDir: undefined, overwrite: false, setTokenEnv: false })
  })

  it('is refused while the app is locked or the controller is missing', async () => {
    const locked = setup({ unlocked: false })
    expect(await locked.call({ scope: 'global' })).toEqual({ success: false, error: '앱 잠금을 해제하세요.' })
    expect(locked.pickDirectory).not.toHaveBeenCalled()
    const missing = setup({ controller: null })
    expect(await missing.call({ scope: 'global' })).toMatchObject({ success: false })
  })

  it('checks the lock again after the folder dialog closes', async () => {
    const handlers = {}
    let unlocked = true
    const controller = { setupClient: vi.fn() }
    const pickDirectory = async () => { unlocked = false; return 'D:\\work\\app' }
    registerMcpIpc({ handle: (channel, fn) => { handlers[channel] = fn } }, () => controller, () => unlocked, { pickDirectory })
    expect(await handlers['mcp-setup-client']({}, { scope: 'project' })).toEqual({ success: false, error: '앱 잠금을 해제하세요.' })
    expect(controller.setupClient).not.toHaveBeenCalled()
  })

  it('passes controller errors on as messages', async () => {
    const { call } = setup({ controller: { setupClient: async () => { throw new Error('JSON 형식이 올바르지 않아') } } })
    expect(await call({ scope: 'global' })).toEqual({ success: false, error: 'JSON 형식이 올바르지 않아' })
  })
})
