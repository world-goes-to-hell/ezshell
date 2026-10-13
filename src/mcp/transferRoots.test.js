import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import configModule from './mcpConfig.js'
import controllerModule from './controller.js'
import ipcModule from './ipc.js'

const { createMcpConfigStore, MAX_TRANSFER_ROOTS } = configModule
const { createMcpController } = controllerModule
const { registerMcpIpc } = ipcModule

const tempDirs = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** base/userdata is the app's data folder; base/work and base/other are ordinary folders */
function makeDirs() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-roots-')))
  tempDirs.push(base)
  const dirs = { base, userData: path.join(base, 'userdata'), work: path.join(base, 'work'), other: path.join(base, 'other') }
  for (const dir of [dirs.userData, dirs.work, dirs.other]) fs.mkdirSync(dir)
  return dirs
}

function setupController() {
  const dirs = makeDirs()
  const controller = createMcpController({
    userDataPath: dirs.userData,
    version: 'test',
    isUnlocked: () => true,
    loadSessions: () => [],
    loadFolders: () => [],
    showApproval: () => true,
    dismissApproval: () => {},
    deps: {
      createServer: () => ({ start: async () => {}, stop: async () => {}, isRunning: () => false, port: () => null }),
      approvals: { cancelAll() {}, respond: () => true, request: vi.fn() },
      gateway: { closeAll() {}, retireAll() {}, forgetCwds() {}, getCwd: () => null, hasLingering: () => false, whenSettled: async () => {} }
    }
  })
  const saved = () => JSON.parse(fs.readFileSync(path.join(dirs.userData, 'mcp.json'), 'utf8'))
  return { controller, dirs, saved }
}

describe('mcpConfig: transfer folders', () => {
  const filePathIn = () => path.join(makeDirs().userData, 'mcp.json')

  it('starts with none', () => {
    expect(createMcpConfigStore({ filePath: filePathIn() }).get().transferRoots).toEqual([])
  })

  it('cannot be changed through the general settings update', () => {
    const store = createMcpConfigStore({ filePath: filePathIn() })
    expect(() => store.update({ transferRoots: ['C:\\'] })).toThrow('바꿀 수 없는 설정')
    expect(store.get().transferRoots).toEqual([])
  })

  it('keeps stored folders and drops entries that are not absolute paths', () => {
    const filePath = filePathIn()
    const kept = path.resolve('/srv/work')
    fs.writeFileSync(filePath, JSON.stringify({ transferRoots: [kept, 'relative', 5, '', kept] }))
    expect(createMcpConfigStore({ filePath }).get().transferRoots).toEqual([kept])
  })

  it('refuses a list that is not made of absolute paths, or is too long', () => {
    const store = createMcpConfigStore({ filePath: filePathIn() })
    expect(() => store.setTransferRoots(['relative'])).toThrow()
    expect(() => store.setTransferRoots('C:\\work')).toThrow()
    const many = Array.from({ length: MAX_TRANSFER_ROOTS + 1 }, (unused, index) => path.resolve(`/srv/work${index}`))
    expect(() => store.setTransferRoots(many)).toThrow()
    expect(store.get().transferRoots).toEqual([])
  })
})

describe('controller: registering transfer folders', () => {
  it('adds a folder by its real path and saves it', async () => {
    const { controller, dirs, saved } = setupController()
    const status = await controller.addTransferRoot(dirs.work)
    expect(status.config.transferRoots).toEqual([dirs.work])
    expect(saved().transferRoots).toEqual([dirs.work])
  })

  it('does not add the same folder twice', async () => {
    const { controller, dirs } = setupController()
    await controller.addTransferRoot(dirs.work)
    const status = await controller.addTransferRoot(dirs.work.toUpperCase() === dirs.work ? dirs.work : dirs.work)
    expect(status.config.transferRoots).toEqual([dirs.work])
  })

  it('refuses a folder that contains the app data folder, and the app data folder itself', async () => {
    const { controller, dirs } = setupController()
    await expect(controller.addTransferRoot(dirs.base)).rejects.toThrow('데이터 폴더')
    await expect(controller.addTransferRoot(dirs.userData)).rejects.toThrow('데이터 폴더')
    expect(controller.getStatus().config.transferRoots).toEqual([])
  })

  it('refuses a junction that leads to a folder containing the app data folder', async () => {
    const { controller, dirs } = setupController()
    const link = path.join(dirs.work, 'up')
    fs.symlinkSync(dirs.base, link, 'junction')
    await expect(controller.addTransferRoot(link)).rejects.toThrow('데이터 폴더')
  })

  it('refuses what is not an existing folder', async () => {
    const { controller, dirs } = setupController()
    fs.writeFileSync(path.join(dirs.work, 'file.txt'), 'x')
    await expect(controller.addTransferRoot(path.join(dirs.work, 'file.txt'))).rejects.toThrow()
    await expect(controller.addTransferRoot(path.join(dirs.work, 'none'))).rejects.toThrow()
    await expect(controller.addTransferRoot('relative')).rejects.toThrow()
    await expect(controller.addTransferRoot(undefined)).rejects.toThrow()
  })

  it('stops at the limit', async () => {
    const { controller, dirs } = setupController()
    for (let i = 0; i < MAX_TRANSFER_ROOTS; i++) {
      const dir = path.join(dirs.other, `d${i}`)
      fs.mkdirSync(dir)
      await controller.addTransferRoot(dir)
    }
    await expect(controller.addTransferRoot(dirs.work)).rejects.toThrow(String(MAX_TRANSFER_ROOTS))
  })

  it('removes a folder', async () => {
    const { controller, dirs, saved } = setupController()
    await controller.addTransferRoot(dirs.work)
    await controller.addTransferRoot(dirs.other)
    const status = await controller.removeTransferRoot(dirs.work)
    expect(status.config.transferRoots).toEqual([dirs.other])
    expect(saved().transferRoots).toEqual([dirs.other])
  })
})

describe('ipc: transfer folders come from the main process dialog only', () => {
  function setupIpc({ unlocked = () => true, picked = 'C:\\picked' } = {}) {
    const handlers = {}
    const added = []
    const removed = []
    const controller = {
      addTransferRoot: async (dir) => { added.push(dir); return { config: { transferRoots: [dir] } } },
      removeTransferRoot: async (dir) => { removed.push(dir); return { config: { transferRoots: [] } } }
    }
    const pickTransferDirectory = vi.fn(async () => picked)
    registerMcpIpc({ handle: (channel, fn) => { handlers[channel] = fn } }, () => controller, unlocked, { pickTransferDirectory })
    return { handlers, added, removed, pickTransferDirectory }
  }

  it('adds the folder the dialog returned and ignores any path the renderer sends', async () => {
    const { handlers, added } = setupIpc()
    const result = await handlers['mcp-add-transfer-folder']({}, { path: 'C:\\Users\\me\\.ssh' })
    expect(added).toEqual(['C:\\picked'])
    expect(result).toEqual({ success: true, status: { config: { transferRoots: ['C:\\picked'] } } })
  })

  it('adds nothing when the dialog is cancelled', async () => {
    const { handlers, added } = setupIpc({ picked: null })
    expect(await handlers['mcp-add-transfer-folder']({})).toEqual({ success: false, cancelled: true })
    expect(added).toEqual([])
  })

  it('adds nothing while the app is locked, or when it locks while the dialog is open', async () => {
    const locked = setupIpc({ unlocked: () => false })
    expect((await locked.handlers['mcp-add-transfer-folder']({})).success).toBe(false)
    expect(locked.pickTransferDirectory).not.toHaveBeenCalled()
    let isUnlocked = true
    const during = setupIpc({ unlocked: () => isUnlocked })
    during.pickTransferDirectory.mockImplementation(async () => { isUnlocked = false; return 'C:\\picked' })
    expect((await during.handlers['mcp-add-transfer-folder']({})).success).toBe(false)
    expect(during.added).toEqual([])
  })

  it('removes by path, only when unlocked', async () => {
    const { handlers, removed } = setupIpc()
    expect((await handlers['mcp-remove-transfer-folder']({}, { path: 'C:\\picked' })).success).toBe(true)
    expect(removed).toEqual(['C:\\picked'])
    const locked = setupIpc({ unlocked: () => false })
    expect((await locked.handlers['mcp-remove-transfer-folder']({}, { path: 'C:\\picked' })).success).toBe(false)
    expect(locked.removed).toEqual([])
  })

  it('turns a refused folder into an error result', async () => {
    const handlers = {}
    const controller = { addTransferRoot: async () => { throw new Error('앱의 데이터 폴더를 포함합니다') } }
    registerMcpIpc({ handle: (channel, fn) => { handlers[channel] = fn } }, () => controller, () => true, { pickTransferDirectory: async () => 'C:\\' })
    expect(await handlers['mcp-add-transfer-folder']({})).toEqual({ success: false, error: '앱의 데이터 폴더를 포함합니다' })
  })
})
