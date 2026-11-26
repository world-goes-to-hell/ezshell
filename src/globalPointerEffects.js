// Windows desktop effects. Electron screen coordinates and window bounds are both in DIPs.
const MOVE_EFFECTS = ['none', 'spot', 'ghost', 'sparkle', 'rainbow', 'comet', 'bubble', 'petal', 'pixel', 'paw']
const CLICK_EFFECTS = ['none', 'press', 'ripple', 'pulse', 'heart', 'firework', 'starpop', 'word', 'ink']
const CURSOR_SETS = ['system', 'big', 'contrast', 'fine', 'paw', 'jelly', 'star', 'heart', 'pixel']
const LEVELS = [1, 2, 3]
const SIZES = [32, 48, 64]
const DISPLAY_EVENTS = ['display-added', 'display-removed', 'display-metrics-changed']
const MOVE_SAMPLE_MS = 16
// The first move after a rest waits for this at most (it was 80ms). It runs all the time the pointer rests, and one
// cursor read costs little: 32ms is about two Windows timer ticks (15.6ms), 31 reads a second
const IDLE_SAMPLE_MS = 32
const IDLE_AFTER_MS = 250
const CHANNEL = 'pointer-effects-frame'
// Windows puts a topmost window that comes later (the taskbar after a click, another app's always-on-top
// window) above the overlay, and the overlay never takes focus to come back: it is raised again this often
// while the pointer moves over it, and on every press
const RAISE_MS = 1000

function checkPointerEffects(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { enabled, move, click, moveLevel, clickLevel, ink, dark, reduced, set, size } = value
  if (typeof enabled !== 'boolean' || typeof dark !== 'boolean' || typeof reduced !== 'boolean' ||
      !MOVE_EFFECTS.includes(move) || !CLICK_EFFECTS.includes(click) || !CURSOR_SETS.includes(set) ||
      !LEVELS.includes(moveLevel) || !LEVELS.includes(clickLevel) || !SIZES.includes(size) ||
      typeof ink !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(ink)) return null
  return { enabled, move, click, moveLevel, clickLevel, ink, dark, reduced, set, size }
}

function contains(bounds, point) {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height
}

function displayPoint(displays, point) {
  const display = displays.find(({ bounds }) => contains(bounds, point))
  return display ? { id: display.id, x: point.x - display.bounds.x, y: point.y - display.bounds.y } : null
}

function overFocusedWindow(win, point, effectWindows) {
  return Boolean(win && !effectWindows.has(win) && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && contains(win.getBounds(), point))
}

const hasMove = config => config.move === 'spot' || (config.move !== 'none' && !config.reduced)

function createGlobalPointerEffects({ BrowserWindow, getScreen, preload, loadPage, setWatching, platform = process.platform, allowNative = true, now = Date.now }) {
  const views = new Map()
  const effectWindows = new Set()
  let config = null
  let screen
  let displays = []
  let paused = true
  let timer
  let lastPoint = null
  let lastMoveAt = 0
  let lastSent = null
  // The choices to bring back after the app is unlocked (suspend / resume); stop() forgets them
  let wanted = null

  function send(view, packet) {
    if (view?.ready && !view.win.isDestroyed()) view.win.webContents.send(CHANNEL, packet)
  }

  // HWND_TOPMOST again: placed at the top of the topmost windows (Electron sets it only when the level changes)
  function raise(view, at = now()) {
    if (!view || view.win.isDestroyed()) return
    view.raisedAt = at
    view.win.setAlwaysOnTop(false)
    view.win.setAlwaysOnTop(true, 'screen-saver')
  }

  function paint(view) {
    send(view, { type: 'config', config })
    if (!paused && view.ready) view.win.showInactive()
  }

  function setDisplayBounds(view) {
    const { win, bounds, id } = view
    win.setBounds(bounds)
    const actual = win.getBounds()
    if (['x', 'y', 'width', 'height'].some(key => actual[key] !== bounds[key])) {
      console.warn(`[globalPointerEffects] display ${id} bounds expected=${JSON.stringify(bounds)} actual=${JSON.stringify(actual)}`)
    }
  }

  function open(display) {
    const win = new BrowserWindow({
      ...display.bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      focusable: false, skipTaskbar: true, type: 'toolbar', resizable: false, movable: false,
      fullscreenable: false, hasShadow: false, paintWhenInitiallyHidden: false,
      // Chromium can take a transparent, click-through topmost window for occluded and stop its frames
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
    })
    const view = { win, ready: false, id: display.id, bounds: display.bounds, raisedAt: 0 }
    views.set(display.id, view)
    effectWindows.add(win)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setIgnoreMouseEvents(true)
    win.setContentProtection(true)
    win.once('closed', () => {
      effectWindows.delete(win)
      if (views.get(display.id) === view) views.delete(display.id)
      if (lastSent?.id === display.id) lastSent = null
    })
    const contents = win.webContents
    const deny = event => event.preventDefault()
    contents.on('will-navigate', deny)
    contents.on('will-redirect', deny)
    contents.on('will-attach-webview', deny)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.once('render-process-gone', () => { if (!win.isDestroyed()) win.destroy() })
    contents.on('did-finish-load', () => {
      if (!config || views.get(display.id) !== view || win.isDestroyed()) return
      // Pin CSS pixels to DIPs even when the main window changes the app zoom.
      contents.setZoomMode('disabled')
      // Windows can resize a new window again while moving it onto a display with another DPI.
      setDisplayBounds(view)
      view.ready = true
      paint(view)
    })
    loadPage(win).catch(error => {
      if (!win.isDestroyed()) {
        console.error('[globalPointerEffects] Failed to load overlay:', error.message)
        win.destroy()
      }
    })
  }

  function syncDisplays() {
    displays = screen.getAllDisplays()
    const ids = new Set(displays.map(display => display.id))
    for (const [id, view] of views) if (!ids.has(id)) view.win.destroy()
    for (const display of displays) {
      const view = views.get(display.id)
      if (view) {
        view.bounds = display.bounds
        setDisplayBounds(view)
        send(view, { type: 'clear' })
      } else {
        open(display)
      }
    }
    lastSent = null
  }

  function leaveDisplay() {
    if (!lastSent) return
    send(views.get(lastSent.id), { type: 'leave' })
    lastSent = null
  }

  function sample(pressed = false) {
    const point = screen.getCursorScreenPoint()
    if (!lastPoint || point.x !== lastPoint.x || point.y !== lastPoint.y) lastMoveAt = now()
    lastPoint = point
    if (overFocusedWindow(BrowserWindow.getFocusedWindow(), point, effectWindows)) {
      leaveDisplay()
      return
    }
    const target = displayPoint(displays, point)
    if (lastSent?.id !== target?.id) leaveDisplay()
    const view = target && views.get(target.id)
    if (!view?.ready) return
    const { x, y } = target
    const moved = !lastSent || lastSent.x !== x || lastSent.y !== y
    if (pressed || (moved && now() - view.raisedAt >= RAISE_MS)) raise(view)
    if (hasMove(config) && moved) send(view, { type: 'move', x, y })
    lastSent = target
    if (pressed) send(view, { type: 'press', x, y })
  }

  function poll() {
    timer = undefined
    if (!config || paused || !hasMove(config)) return
    sample()
    timer = setTimeout(poll, now() - lastMoveAt < IDLE_AFTER_MS ? MOVE_SAMPLE_MS : IDLE_SAMPLE_MS)
    timer.unref?.()
  }

  function updatePolling() {
    if (!config || paused || !hasMove(config)) {
      clearTimeout(timer)
      timer = undefined
    } else if (!timer) {
      poll()
    }
  }

  function onNotificationState(state) {
    if (!config) return
    const next = state === null || (state >= 1 && state <= 4)
    if (next === paused) return
    paused = next
    lastSent = lastPoint = null
    if (paused) {
      for (const view of views.values()) {
        send(view, { type: 'clear' })
        view.win.hide()
      }
    } else {
      for (const view of views.values()) {
        if (!view.ready) continue
        view.win.showInactive()
        raise(view)
      }
    }
    updatePolling()
  }

  function stop() {
    wanted = null
    halt()
  }

  function halt() {
    if (!config) return
    config = null
    paused = true
    updatePolling()
    setWatching(false)
    for (const event of DISPLAY_EVENTS) screen.removeListener(event, syncDisplays)
    for (const { win } of views.values()) win.destroy()
    displays = []
    lastSent = lastPoint = null
  }

  function configure(request) {
    const next = checkPointerEffects(request)
    if (!next || platform !== 'win32') return false
    if (!allowNative) return true
    wanted = next
    if (!next.enabled || (!hasMove(next) && next.click === 'none')) {
      halt()
      return true
    }
    const starting = !config
    config = next
    lastSent = null
    if (starting) {
      screen = getScreen()
      for (const event of DISPLAY_EVENTS) screen.on(event, syncDisplays)
      syncDisplays()
      setWatching(true)
    } else {
      for (const view of views.values()) send(view, { type: 'config', config })
    }
    updatePolling()
    return true
  }

  return {
    configure, onNotificationState, stop,
    /** The app locked: no effects until it is unlocked, then the same choices (the window sends them only on change) */
    suspend: halt,
    resume() { if (wanted && !config) configure(wanted) },
    onPress() { if (config && !paused && config.click !== 'none') sample(true) }
  }
}

module.exports = { IDLE_SAMPLE_MS, MOVE_SAMPLE_MS, checkPointerEffects, displayPoint, overFocusedWindow, createGlobalPointerEffects }
