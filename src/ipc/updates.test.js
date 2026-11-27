import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { registerUpdateIpc } = require('./updates.js')

describe.skipIf(process.platform === 'darwin')('automatic update shutdown', () => {
  let profile
  beforeEach(() => {
    vi.useFakeTimers()
    profile = mkdtempSync(join(tmpdir(), 'ezshell-update-ipc-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(profile, { recursive: true, force: true })
  })

  function setup(options = {}) {
    const handlers = new Map()
    const mainFrame = {}
    const sender = { mainFrame }
    const app = Object.assign(new EventEmitter(), {
      getVersion: () => '2.40.0', getPath: () => profile,
      quit: vi.fn(), exit: vi.fn()
    })
    const updater = Object.assign(new EventEmitter(), { install: vi.fn(() => true) })
    const ctx = {
      app, ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showErrorBox: vi.fn() },
      sessionsFilePath: join(profile, 'sessions.json'), fromMainWindow: event => event?.sender === sender,
      keepSessionsForUpdate: vi.fn(async () => true), finishSessionQuit: vi.fn(), ...options
    }
    const { setupAutoUpdater, finishQuit, isInstallingOnQuit } = registerUpdateIpc(ctx, updater)
    setupAutoUpdater()
    app.on('will-quit', finishQuit)
    return {
      app, updater, ctx, handlers, isInstallingOnQuit, event: { sender, senderFrame: mainFrame },
      download: () => updater.emit('update-downloaded', { version: '2.41.0' }),
      willQuit: () => {
        const event = { preventDefault: vi.fn() }
        app.emit('will-quit', event)
        return event
      }
    }
  }

  it('leaves the app open for invalid restart requests', () => {
    const { app, event, handlers, download } = setup()
    const restart = handlers.get('install-update')
    expect(() => restart(event)).toThrow('업데이트 설치를 시작할 수 없습니다.')
    download()
    expect(() => restart({ ...event, senderFrame: {} })).toThrow()
    expect(() => restart({ sender: { mainFrame: event.senderFrame }, senderFrame: event.senderFrame })).toThrow()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('waits for window closure, the host acknowledgement and cleanup before installing once', async () => {
    let resolveKeep
    const keep = vi.fn(() => new Promise(resolve => { resolveKeep = resolve }))
    const { app, updater, ctx, event, handlers, download, willQuit, isInstallingOnQuit } = setup({ keepSessionsForUpdate: keep })
    const otherCleanup = vi.fn()
    app.on('will-quit', otherCleanup)
    download()
    handlers.get('install-update')(event)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(isInstallingOnQuit()).toBe(false)
    expect(keep).not.toHaveBeenCalled()
    expect(updater.install).not.toHaveBeenCalled()
    expect(willQuit().preventDefault).toHaveBeenCalledOnce()
    expect(isInstallingOnQuit()).toBe(true)
    expect(willQuit().preventDefault).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(keep).toHaveBeenCalledOnce()
    expect(ctx.finishSessionQuit).not.toHaveBeenCalled()
    expect(updater.install).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()

    resolveKeep(true)
    await vi.advanceTimersByTimeAsync(5)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(ctx.finishSessionQuit).toHaveBeenCalledExactlyOnceWith({ updating: true, keepShells: true })
    expect(updater.install).toHaveBeenCalledExactlyOnceWith(true, true)
    expect(otherCleanup.mock.invocationCallOrder[0]).toBeLessThan(updater.install.mock.invocationCallOrder[0])
    expect(ctx.finishSessionQuit.mock.invocationCallOrder[0]).toBeLessThan(updater.install.mock.invocationCallOrder[0])
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('installs on ordinary close without reviving a canceled restart request', async () => {
    const { app, updater, ctx, event, handlers, download, willQuit } = setup()
    download()
    handlers.get('install-update')(event)
    await vi.advanceTimersByTimeAsync(5)
    expect(updater.install).not.toHaveBeenCalled()
    expect(ctx.keepSessionsForUpdate).not.toHaveBeenCalled()
    app.emit('window-all-closed')
    willQuit()
    await vi.advanceTimersByTimeAsync(5)
    expect(ctx.keepSessionsForUpdate).not.toHaveBeenCalled()
    expect(ctx.finishSessionQuit).toHaveBeenCalledExactlyOnceWith({ updating: true, keepShells: false })
    expect(updater.install).toHaveBeenCalledExactlyOnceWith(true, false)
  })

  it('finishes an ordinary quit without an update', async () => {
    const { app, updater, ctx, willQuit } = setup()
    expect(willQuit().preventDefault).not.toHaveBeenCalled()
    expect(ctx.finishSessionQuit).toHaveBeenCalledExactlyOnceWith({ updating: false, keepShells: false })
    await vi.advanceTimersByTimeAsync(5)
    expect(updater.install).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('cleans up without handoff if the host refuses keep, even if the installer cannot start', async () => {
    const { app, updater, ctx, event, handlers, download, willQuit } = setup()
    ctx.keepSessionsForUpdate.mockResolvedValue(false)
    updater.install.mockReturnValue(false)
    download()
    handlers.get('install-update')(event)
    willQuit()
    await vi.advanceTimersByTimeAsync(5)
    expect(ctx.finishSessionQuit).toHaveBeenCalledExactlyOnceWith({ updating: true, keepShells: false })
    expect(updater.install).toHaveBeenCalledExactlyOnceWith(true, true)
    expect(ctx.dialog.showErrorBox).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('shows an installer launch error reported just before exit', async () => {
    const { app, updater, ctx, download, willQuit } = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    updater.install.mockImplementation(() => {
      void Promise.resolve().then(() => updater.emit('error', new Error('spawn failed')))
      return true
    })
    download()
    willQuit()
    await vi.advanceTimersByTimeAsync(5)
    expect(ctx.dialog.showErrorBox).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(1)
  })
})
