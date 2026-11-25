import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const cryptoUtil = require('../crypto.js')
const { saveRestoreTabs, takeRestoreTabs } = require('../restoreTabs.js')
const { registerRestoreTabsIpc } = require('./restoreTabs.js')

const password = 'restore-test-password'
const record = title => ({ version: 1, tabs: title ? [{ kind: 'local', title }] : [] })
const profiles = []

function setup() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-tabs-ipc-'))
  profiles.push(profile)
  const file = path.join(profile, 'restore-tabs.json')
  const handlers = new Map()
  const ipcMain = Object.assign(new EventEmitter(), { handle: (name, handler) => handlers.set(name, handler) })
  const app = Object.assign(new EventEmitter(), { getPath: () => profile, quit: vi.fn() })
  const sender = { mainFrame: {}, send: vi.fn(), isCrashed: () => false }
  const primary = { sender, senderFrame: sender.mainFrame }
  const subframe = { sender, senderFrame: {} }
  const win = Object.assign(new EventEmitter(), { webContents: sender, close: vi.fn(), isDestroyed: () => false })
  const autoUpdater = new EventEmitter()
  const ctx = { ipcMain, app, fromMainWindow: event => event.sender === sender, isAppLocked: false, currentMasterPassword: password }
  const service = registerRestoreTabsIpc(ctx, autoUpdater)
  service.trackClose(win)
  return {
    file, ctx, win, sender, service, subframe, autoUpdater,
    checkpoint: (value, event = primary) => ipcMain.emit('restore-tabs-checkpoint', event, value),
    take: (event = primary) => handlers.get('restore-tabs-take')(event),
    update: (value, event = primary) => handlers.get('restore-tabs-save')(event, value),
    closeRecord: (id, value) => ipcMain.emit('restore-tabs-close-record', primary, { id, record: value }),
    raw: () => fs.readFileSync(file, 'utf8'),
    saved: () => {
      const { data, source } = JSON.parse(fs.readFileSync(file, 'utf8'))
      return { record: JSON.parse(cryptoUtil.decrypt(data, password)), source }
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const profile of profiles.splice(0)) {
    for (const name of fs.readdirSync(profile)) fs.unlinkSync(path.join(profile, name))
    fs.rmdirSync(profile)
  }
})

it('coalesces live checkpoints and only offers the previous process record once', async () => {
  const app = setup()
  saveRestoreTabs(app.file, record('이전 실행'), password, { source: 'close' })
  app.checkpoint(record('너무 이른 기록'))
  expect(app.take()?.record).toEqual(record('이전 실행'))
  app.checkpoint(record('첫 배치'))
  app.checkpoint(record('최신 배치'))
  expect(fs.existsSync(app.file)).toBe(false)
  await vi.waitFor(() => expect(fs.existsSync(app.file)).toBe(true), { timeout: 4000 })
  expect(app.saved()).toEqual({ record: record('최신 배치'), source: 'close' })
  expect(app.take()).toBeNull()
  const written = app.raw()
  app.service.rememberBeforeLock(record('최신 배치'))
  expect(app.raw()).toBe(written)
  app.service.rememberBeforeLock(record())
  expect(fs.existsSync(app.file)).toBe(false)
})

it.skipIf(process.platform !== 'win32')('flushes pending checkpoints synchronously on Windows session events', () => {
  const app = setup()
  expect(app.take()).toBeNull()
  app.checkpoint(record('첫 배치'))
  const event = { preventDefault: vi.fn() }
  app.win.emit('query-session-end', event)
  expect(app.saved().record).toEqual(record('첫 배치'))
  app.checkpoint(record('마지막 배치'))
  app.win.emit('session-end', event)
  expect(app.saved().record).toEqual(record('마지막 배치'))
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(app.sender.send).not.toHaveBeenCalled()
})

it('keeps the lock snapshot over an outstanding background save and checks the primary frame', async () => {
  vi.useFakeTimers()
  let finishBackground
  const encrypt = vi.spyOn(cryptoUtil, 'encryptAsync').mockImplementation(() => new Promise(resolve => { finishBackground = resolve }))
  const app = setup()
  app.take()
  expect(app.update(record('잘못된 프레임'), app.subframe).success).toBe(false)
  app.checkpoint(record('백그라운드 기록'))
  vi.runOnlyPendingTimers()
  expect(encrypt).toHaveBeenCalledOnce()
  app.service.rememberBeforeLock(record('잠그기 직전'))
  app.ctx.isAppLocked = true
  app.ctx.currentMasterPassword = null
  const locked = app.raw()
  app.checkpoint(record('잠근 뒤'))
  expect(app.take()).toBeNull()
  finishBackground({ old: true })
  await Promise.resolve()
  await Promise.resolve()
  vi.useRealTimers()
  app.win.emit('session-end')
  expect(app.saved().record).toEqual(record('잠그기 직전'))
  app.ctx.isAppLocked = false
  app.ctx.currentMasterPassword = password
  app.checkpoint(record('하위 프레임'), app.subframe)
  app.win.emit('session-end')
  expect(app.raw()).toBe(locked)
})

it('preserves an explicit update checkpoint across lock and shutdown events', () => {
  const app = setup()
  app.take()
  app.checkpoint(record('기존 탭'))
  expect(app.update(record('업데이트 전'))).toEqual({ success: true })
  app.checkpoint(record('다른 탭'))
  app.service.rememberBeforeLock(record('잠그기 직전'))
  app.autoUpdater.emit('before-quit-for-update')
  app.win.emit('query-session-end')
  expect(app.saved()).toEqual({ record: record('업데이트 전'), source: 'update' })
  expect(app.take()?.record).toEqual(record('업데이트 전'))
  expect(app.take()).toBeNull()
})

it('takes the current renderer record on a normal close', () => {
  const app = setup()
  app.take()
  app.checkpoint(record('이전 배치'))
  app.win.emit('close', { preventDefault: vi.fn() })
  const [channel, id] = app.sender.send.mock.calls[0]
  expect(channel).toBe('restore-tabs-before-close')
  app.closeRecord(id, record('닫는 순간'))
  expect(app.saved().record).toEqual(record('닫는 순간'))
  expect(app.win.close).toHaveBeenCalledOnce()
})

it('can save the same layout under the new master password after a reset', () => {
  const app = setup()
  app.take()
  const tabs = record('열린 탭')
  app.service.rememberBeforeLock(tabs)
  app.service.discardForPasswordReset()
  expect(fs.existsSync(app.file)).toBe(false)

  const newPassword = 'changed-master-password'
  app.ctx.currentMasterPassword = newPassword
  app.service.rememberBeforeLock(tabs)
  expect(takeRestoreTabs(app.file, newPassword)).toMatchObject({ source: 'close', record: tabs })
})
