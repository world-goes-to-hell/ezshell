import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { registerWorkOverviewIpc } from './workOverview.js'

function setup({ fullscreen = false, locked = false } = {}) {
  const handlers = new Map()
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => handlers.set(name, handler) }
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: {} })
  const win = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false,
    isFullScreen: () => fullscreen,
    setFullScreen: vi.fn(),
    getBounds: () => ({ x: 80, y: 100, width: 1200, height: 800 })
  })
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 }
  const thumbnail = bytes => ({ isEmpty: () => false, toJPEG: vi.fn(() => Buffer.from(bytes)) })
  const sources = [
    { display_id: '4', thumbnail: thumbnail([4]) },
    { display_id: '9', thumbnail: thumbnail([9]) }
  ]
  const desktopCapturer = { getSources: vi.fn().mockResolvedValue(sources) }
  const getDisplay = vi.fn(() => ({ id: 9, bounds }))
  registerWorkOverviewIpc({ ipcMain, desktopCapturer, getDisplay, getWindow: () => win, isLocked: () => locked })
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  return {
    win, sources, getDisplay, desktopCapturer,
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

  it('accepts requests only from the unlocked main renderer', async () => {
    const locked = setup({ locked: true })
    const unlocked = setup()
    expect(await locked.show()).toBeNull()
    expect(await unlocked.show({ sender: unlocked.win.webContents, senderFrame: {} })).toBeNull()
    expect(locked.desktopCapturer.getSources).not.toHaveBeenCalled()
    expect(unlocked.desktopCapturer.getSources).not.toHaveBeenCalled()
  })
})
