import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createTestWindows } from './testWindows.js'

function setup(isPackaged = false, flag = '1') {
  class BrowserWindow extends EventEmitter {
    static fromWebContents() {}
    constructor(options) {
      super()
      this.options = options
      this.bounds = { x: options.x, y: options.y, width: 800, height: 600 }
      this.getBounds = () => this.bounds
      this.setBounds = vi.fn(bounds => { this.bounds = { ...this.bounds, ...bounds } })
      for (const name of ['show', 'showInactive', 'hide', 'focus', 'moveTop', 'setAlwaysOnTop', 'flashFrame', 'setFullScreen', 'maximize']) {
        this[name] = vi.fn()
      }
      this.initial = { ...this }
      this.isDestroyed = () => false
      this.webContents = new EventEmitter()
    }
  }
  const app = Object.assign(new EventEmitter(), { isPackaged, commandLine: { appendSwitch: vi.fn() } })
  const displays = [
    { bounds: { x: -1920, y: -800, width: 1920, height: 1080 } },
    { bounds: { x: 2400, y: 25, width: 2560, height: 1440 } }
  ]
  const screen = { getAllDisplays: () => displays }
  const dialog = { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showErrorBox: vi.fn() }
  const electron = { app, BrowserWindow, screen, dialog }
  const mode = createTestWindows(electron, { EZSHELL_TEST_HIDDEN_WINDOWS: flag })
  return { ...electron, mode, displays }
}

describe('hidden development windows', () => {
  it.each([[true, '1'], [false, '0']])('leaves native windows and dialogs alone (packaged %s, flag %s)', (packaged, flag) => {
    const { app, BrowserWindow, mode } = setup(packaged, flag)
    expect(mode.enabled).toBe(false)
    expect(mode.BrowserWindow).toBe(BrowserWindow)
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled()
  })

  it('constructs an inactive window beyond every display before showing it', () => {
    const { mode, BrowserWindow } = setup()
    const win = new mode.BrowserWindow({ x: 5, y: 30, alwaysOnTop: true, fullscreen: true })
    expect(win.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true, alwaysOnTop: false, fullscreen: false,
      webPreferences: { backgroundThrottling: false } })
    expect(win.getBounds().x).toBeGreaterThan(4960)
    expect(mode.BrowserWindow.fromWebContents).toBe(BrowserWindow.fromWebContents)
    expect(win.initial.showInactive).toHaveBeenCalledOnce()
    win.show()
    win.focus()
    win.moveTop()
    win.setAlwaysOnTop(true)
    win.flashFrame(true)
    win.setFullScreen(true)
    win.maximize()
    expect(win.initial.showInactive).toHaveBeenCalledTimes(2)
    for (const name of ['show', 'focus', 'moveTop', 'setAlwaysOnTop', 'flashFrame', 'setFullScreen', 'maximize']) {
      expect(win.initial[name]).not.toHaveBeenCalled()
    }
  })

  it('keeps explicit and renderer-driven resize requests beyond newly connected displays', () => {
    const { mode, displays } = setup()
    const win = new mode.BrowserWindow({ show: false })
    expect(win.initial.showInactive).not.toHaveBeenCalled()
    displays.push({ bounds: { x: 5000, y: 0, width: 1920, height: 1080 } })
    win.setBounds({ x: 30, y: 60, width: 1000, height: 640 })
    expect(win.getBounds()).toMatchObject({ width: 1000, height: 640 })
    expect(win.getBounds().x).toBeGreaterThan(6920)
    const preventDefault = vi.fn()
    win.webContents.emit('content-bounds-updated', { preventDefault }, { x: 200, y: -50, width: 780, height: 705 })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(win.getBounds()).toMatchObject({ width: 780, height: 705 })
    expect(win.getBounds().x).toBeGreaterThan(6920)
  })

  it('emulates maximize and restore through offscreen bounds and window events', () => {
    const { mode } = setup()
    const win = new mode.BrowserWindow()
    const normal = win.getBounds()
    const maximized = vi.fn()
    const restored = vi.fn()
    win.on('maximize', maximized)
    win.on('unmaximize', restored)
    win.maximize()
    expect(win.isMaximized()).toBe(true)
    expect(win.getBounds()).toMatchObject({ x: normal.x, width: 1920, height: 1080 })
    expect(win.getNormalBounds()).toEqual(normal)
    expect(maximized).toHaveBeenCalledOnce()
    win.unmaximize()
    expect(win.isMaximized()).toBe(false)
    expect(win.getBounds()).toEqual(normal)
    expect(restored).toHaveBeenCalledOnce()
  })

  it('cancels native dialogs and suppresses web contents focus and devtools', async () => {
    const { app, dialog } = setup()
    await expect(dialog.showOpenDialog()).resolves.toEqual({ canceled: true, filePaths: [] })
    await expect(dialog.showSaveDialog()).resolves.toEqual({ canceled: true })
    const contents = { focus: vi.fn(), openDevTools: vi.fn() }
    const native = { ...contents }
    app.emit('web-contents-created', {}, contents)
    contents.focus()
    contents.openDevTools()
    expect(native.focus).not.toHaveBeenCalled()
    expect(native.openDevTools).not.toHaveBeenCalled()
  })
})
