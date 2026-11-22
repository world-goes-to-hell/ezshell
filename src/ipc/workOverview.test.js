import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { registerWorkOverviewIpc } from './workOverview.js'

function setup({ fullscreen = false, locked = false, maximized = false } = {}) {
  const handlers = new Map()
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => handlers.set(name, handler) }
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: {} })
  const win = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false,
    isFullScreen: () => fullscreen,
    setFullScreen: vi.fn(value => { if (!value) win.emit('leave-full-screen') }),
    getBounds: vi.fn(() => ({ x: 80, y: 100, width: 1200, height: 800 })),
    getNormalBounds: () => ({ x: 120, y: 140, width: 1000, height: 700 }),
    isMaximized: () => maximized,
    unmaximize: vi.fn(),
    maximize: vi.fn(),
    setBounds: vi.fn()
  })
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  const thumbnail = bytes => ({ isEmpty: () => false, toJPEG: vi.fn(() => Buffer.from(bytes)) })
  const sources = [
    { display_id: '4', thumbnail: thumbnail([4]) },
    { display_id: '9', thumbnail: thumbnail([9]) }
  ]
  const desktopCapturer = { getSources: vi.fn().mockResolvedValue(sources) }
  const getDisplay = vi.fn(() => ({ id: 9, bounds }))
  const api = registerWorkOverviewIpc({ ipcMain, desktopCapturer, getDisplay, getWindow: () => win, isLocked: () => locked })
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  return {
    win, sources, getDisplay, desktopCapturer, api,
    show: (sender = event) => handlers.get('work-overview-show')(sender),
    hide: () => handlers.get('work-overview-hide')(event)
  }
}

describe('monitor work overview', () => {
  it('uses the app monitor’s image and restores the window on dismissal', async () => {
    const { show, hide, win, sources, getDisplay } = setup()
    expect(await show()).toEqual({ backdrop: new Uint8Array([9]) })
    expect(getDisplay).toHaveBeenCalledWith(win.getBounds())
    expect(sources[0].thumbnail.toJPEG).not.toHaveBeenCalled()
    expect(win.setFullScreen).toHaveBeenLastCalledWith(true)
    hide()
    expect(win.setFullScreen.mock.calls).toEqual([[true], [false]])
  })

  it('opens even if capture fails and leaves an existing fullscreen window fullscreen', async () => {
    const { show, hide, win, desktopCapturer } = setup({ fullscreen: true })
    desktopCapturer.getSources.mockRejectedValueOnce(new Error('Capture unavailable'))
    expect(await show()).toEqual({ backdrop: null })
    hide()
    expect(win.setFullScreen).not.toHaveBeenCalled()
  })

  it('cancels a pending capture and restores the window if the renderer exits', async () => {
    const { show, hide, win } = setup()
    const pending = show()
    hide()
    expect(await pending).toBeNull()
    expect(win.setFullScreen).not.toHaveBeenCalled()
    await show()
    win.webContents.emit('render-process-gone')
    expect(win.setFullScreen.mock.calls).toEqual([[true], [false]])
  })

  const other = { id: 4, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }

  it('opens on the monitor Tab Tab was pressed on and puts the window back afterwards', async () => {
    const { show, hide, win, sources, api } = setup()
    api.aimAt(other)
    expect(await show()).toEqual({ backdrop: new Uint8Array([4]) })
    expect(sources[1].thumbnail.toJPEG).not.toHaveBeenCalled()
    // Moved onto that monitor (same size, in the middle of its work area) before going fullscreen
    expect(win.setBounds).toHaveBeenCalledWith({ x: -1560, y: 120, width: 1200, height: 800 })
    expect(win.setBounds.mock.invocationCallOrder[0]).toBeLessThan(win.setFullScreen.mock.invocationCallOrder[0])
    hide()
    expect(win.setFullScreen.mock.calls).toEqual([[true], [false]])
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 80, y: 100, width: 1200, height: 800 })
  })

  it('brings a maximized window back maximized, and forgets an old aim', async () => {
    const maximized = setup({ maximized: true })
    maximized.api.aimAt(other)
    await maximized.show()
    expect(maximized.win.unmaximize).toHaveBeenCalled()
    maximized.hide()
    expect(maximized.win.setBounds).toHaveBeenLastCalledWith({ x: 120, y: 140, width: 1000, height: 700 })
    expect(maximized.win.maximize).toHaveBeenCalled()

    vi.useFakeTimers()
    try {
      const late = setup()
      late.api.aimAt(other)
      vi.advanceTimersByTime(5000)
      expect(await late.show()).toEqual({ backdrop: new Uint8Array([9]) })
      expect(late.win.setBounds).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays put when aimed at its own monitor or when the window is already fullscreen', async () => {
    const own = setup()
    own.api.aimAt({ id: 9, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
    await own.show()
    expect(own.win.setBounds).not.toHaveBeenCalled()
    const full = setup({ fullscreen: true })
    full.api.aimAt(other)
    await full.show()
    expect(full.win.setBounds).not.toHaveBeenCalled()
  })

  it('accepts requests only from the unlocked main renderer', async () => {
    const locked = setup({ locked: true })
    const unlocked = setup()
    expect(await locked.show()).toBeNull()
    expect(await unlocked.show({ sender: unlocked.win.webContents, senderFrame: {} })).toBeNull()
    expect(locked.desktopCapturer.getSources).not.toHaveBeenCalled()
    expect(unlocked.desktopCapturer.getSources).not.toHaveBeenCalled()
  })
})
