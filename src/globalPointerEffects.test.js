import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkPointerEffects, createGlobalPointerEffects, displayPoint, overFocusedWindow } from './globalPointerEffects.js'
import { CURSOR_SET_IDS, CURSOR_SIZES } from './renderer/lib/pointerCursors'
import { CLICK_EFFECTS, MOVE_EFFECTS } from './renderer/lib/pointerPrefs'

const config = { enabled: true, move: 'spot', click: 'ripple', moveLevel: 1, clickLevel: 3,
  set: 'paw', size: 64, ink: '#ab34ef', dark: false, reduced: false }
const left = { id: 21, bounds: { x: -800, y: -30, width: 800, height: 600 } }
const right = { id: 42, bounds: { x: 0, y: 0, width: 1200, height: 700 } }

function setup(options = {}) {
  vi.useFakeTimers()
  const wins = []
  const setWatching = vi.fn()
  const screen = new EventEmitter()
  const desktop = { displays: [left, right], point: { x: -500, y: 70 }, focused: null }
  screen.getAllDisplays = () => desktop.displays
  screen.getCursorScreenPoint = vi.fn(() => desktop.point)
  const getScreen = vi.fn(() => screen)
  class BrowserWindow extends EventEmitter {
    static getFocusedWindow() { return desktop.focused }
    constructor(options) {
      super()
      this.options = options
      const { x, y, width, height } = options
      this.bounds = { x, y, width, height }
      this.webContents = Object.assign(new EventEmitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn(), setZoomMode: vi.fn() })
      this.setBounds = vi.fn(bounds => { this.bounds = bounds })
      this.showInactive = vi.fn()
      this.hide = vi.fn()
      this.setAlwaysOnTop = vi.fn()
      this.setIgnoreMouseEvents = vi.fn()
      this.setContentProtection = vi.fn()
      this.destroyed = false
      wins.push(this)
    }
    isDestroyed() { return this.destroyed }
    getBounds() { return this.bounds }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  const loadPage = vi.fn(async () => {})
  const effects = createGlobalPointerEffects({ BrowserWindow, getScreen, setWatching, preload: 'overlay.js', loadPage, platform: 'win32', ...options })
  return { effects, desktop, wins, setWatching, getScreen, screen, loadPage }
}

const packets = win => win.webContents.send.mock.calls.map(([channel, packet]) => {
  expect(channel).toBe('pointer-effects-frame')
  return packet
})

afterEach(() => vi.useRealTimers())

describe('desktop pointer effect settings', () => {
  it('accepts all choices the settings can send and projects known fields only', () => {
    expect(checkPointerEffects({ ...config, terminal: true, path: 'ignored' })).toEqual(config)
    for (const move of MOVE_EFFECTS) expect(checkPointerEffects({ ...config, move })).not.toBeNull()
    for (const click of CLICK_EFFECTS) expect(checkPointerEffects({ ...config, click })).not.toBeNull()
    for (const set of CURSOR_SET_IDS) expect(checkPointerEffects({ ...config, set })).not.toBeNull()
    for (const size of CURSOR_SIZES) expect(checkPointerEffects({ ...config, size })).not.toBeNull()
  })

  it.each([
    { enabled: 1 }, { reduced: 'false' }, { dark: null }, { ink: 'red' }, { ink: '#abcdefg' }, { ink: '#0000' },
    { move: 'unknown' }, { click: 'rs' }, { set: 'constructor' }, { moveLevel: '1' }, { clickLevel: 4 }, { size: 1024 }
  ])('rejects an invalid field %o', patch => {
    expect(checkPointerEffects({ ...config, ...patch })).toBeNull()
  })
})

it('uses monitor bounds in DIPs, including negative origins and a shared monitor edge', () => {
  expect(displayPoint([left, right], { x: -800, y: -30 })).toEqual({ id: 21, x: 0, y: 0 })
  expect(displayPoint([left, right], { x: 0, y: 50 })).toEqual({ id: 42, x: 0, y: 50 })
  expect(displayPoint([left, right], { x: 0, y: -1 })).toBeNull()
})

it('suppresses only over the focused visible app window and excludes effect windows', () => {
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getBounds: () => left.bounds }
  const point = { x: -700, y: 100 }
  expect(overFocusedWindow(win, point, new Set())).toBe(true)
  expect(overFocusedWindow(win, point, new Set([win]))).toBe(false)
  expect(overFocusedWindow(null, point, new Set())).toBe(false)
  expect(overFocusedWindow(win, { x: 1, y: 1 }, new Set())).toBe(false)
  expect(overFocusedWindow({ ...win, isMinimized: () => true }, point, new Set())).toBe(false)
})

describe('desktop effects windows', () => {
  it('validates without native side effects in screen tests and stays disabled outside Windows', () => {
    const dry = setup({ allowNative: false })
    expect(dry.effects.configure(config)).toBe(true)
    expect(dry.effects.configure({ ...config, ink: 'red' })).toBe(false)
    expect(dry.getScreen).not.toHaveBeenCalled()
    expect(dry.setWatching).not.toHaveBeenCalled()
    const mac = setup({ platform: 'darwin' })
    expect(mac.effects.configure(config)).toBe(false)
    expect(mac.wins).toHaveLength(0)
  })

  it('routes position changes and presses only to their display, leaving the prior spotlight', () => {
    const { effects, desktop, wins, setWatching, screen } = setup()
    expect(effects.configure(config)).toBe(true)
    expect(wins).toHaveLength(2)
    expect(wins[0].options).toMatchObject({ ...left.bounds, transparent: true, frame: false, focusable: false,
      skipTaskbar: true, type: 'toolbar', show: false })
    expect(wins[0].setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
    expect(wins[0].setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(wins[0].setContentProtection).toHaveBeenCalledWith(true)
    expect(setWatching.mock.calls).toEqual([[true]])
    for (const win of wins) win.webContents.emit('did-finish-load')
    expect(wins[0].webContents.setZoomMode).toHaveBeenCalledWith('disabled')
    expect(wins[0].setBounds).toHaveBeenCalledWith(left.bounds)
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled()
    effects.onNotificationState(5)
    expect(wins[0].showInactive).toHaveBeenCalledOnce()
    expect(packets(wins[0])).toEqual([{ type: 'config', config }, { type: 'move', x: 300, y: 100 }])
    vi.advanceTimersByTime(320)
    expect(packets(wins[0])).toHaveLength(2)
    screen.getCursorScreenPoint.mockClear()
    vi.advanceTimersByTime(320)
    expect(screen.getCursorScreenPoint.mock.calls.length).toBeLessThanOrEqual(5)

    desktop.point = { x: 30, y: 40 }
    effects.onPress()
    expect(packets(wins[0]).at(-1)).toEqual({ type: 'leave' })
    expect(packets(wins[1]).slice(-2)).toEqual([{ type: 'move', x: 30, y: 40 }, { type: 'press', x: 30, y: 40 }])

    desktop.focused = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getBounds: () => right.bounds }
    const priorPackets = packets(wins[0])
    effects.onPress()
    expect(packets(wins[1]).at(-1)).toEqual({ type: 'leave' })
    expect(packets(wins[0])).toEqual(priorPackets)
    expect(packets(wins[1]).filter(packet => packet.type === 'press')).toHaveLength(1)

    effects.stop()
    expect(setWatching.mock.calls).toEqual([[true], [false]])
    expect(wins.every(win => win.isDestroyed())).toBe(true)
    expect(screen.listenerCount('display-added')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([1, 3])('clears and hides every overlay in Windows state %d and adjusts display geometry while paused', state => {
    const { effects, desktop, wins, screen } = setup()
    effects.configure(config)
    for (const win of wins) win.webContents.emit('did-finish-load')
    effects.onNotificationState(5)
    effects.onNotificationState(state)
    const before = screen.getCursorScreenPoint.mock.calls.length
    expect(wins[0].hide).toHaveBeenCalledOnce()
    expect(packets(wins[0]).at(-1)).toEqual({ type: 'clear' })
    effects.onPress()
    vi.advanceTimersByTime(250)
    expect(screen.getCursorScreenPoint).toHaveBeenCalledTimes(before)

    const changed = { ...left, bounds: { ...left.bounds, width: 820 } }
    desktop.displays = [changed]
    screen.emit('display-removed')
    expect(wins[1].isDestroyed()).toBe(true)
    expect(wins[0].setBounds).toHaveBeenCalledWith(changed.bounds)
    desktop.displays = [changed, right]
    screen.emit('display-added')
    wins[2].webContents.emit('did-finish-load')
    expect(wins[2].showInactive).not.toHaveBeenCalled()
    effects.onNotificationState(5)
    expect(wins[2].showInactive).toHaveBeenCalledOnce()
    effects.configure({ ...config, enabled: false })
    expect(wins.every(win => win.isDestroyed())).toBe(true)
  })

  it('samples positions only on press while a click-only effect is active', () => {
    const { effects, screen, wins } = setup()
    effects.configure({ ...config, move: 'none' })
    wins[0].webContents.emit('did-finish-load')
    effects.onNotificationState(5)
    vi.advanceTimersByTime(1000)
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled()
    effects.onPress()
    expect(packets(wins[0]).at(-1)).toEqual({ type: 'press', x: 300, y: 100 })
    expect(screen.getCursorScreenPoint).toHaveBeenCalledOnce()
    effects.configure(config)
    expect(vi.getTimerCount()).toBe(1)
    effects.configure({ ...config, move: 'none' })
    expect(vi.getTimerCount()).toBe(0)
    effects.stop()
  })

  it('logs the requested and actual window bounds if Windows still clamps the overlay', () => {
    const { effects, wins } = setup()
    effects.configure(config)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      wins[0].getBounds = () => ({ ...left.bounds, width: 799 })
      wins[0].webContents.emit('did-finish-load')
      expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/display 21 bounds expected=.*"width":800.*actual=.*"width":799/))
    } finally { warning.mockRestore(); effects.stop() }
  })
})
