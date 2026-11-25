const modes = new WeakMap()
const backgroundSwitches = [
  'disable-backgrounding-occluded-windows',
  'disable-renderer-backgrounding',
  'disable-background-timer-throttling'
]
const noop = () => {}

function parkingPoint(displays) {
  return {
    x: Math.max(0, ...displays.map(({ bounds }) => bounds.x + bounds.width)) + 64,
    y: Math.min(0, ...displays.map(({ bounds }) => bounds.y))
  }
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Opt-in for development apps only, with no renderer access to the mode switch. */
function createTestWindows(electron, env = process.env) {
  const { app, BrowserWindow } = electron
  if (app.isPackaged || env.EZSHELL_TEST_HIDDEN_WINDOWS !== '1') return { enabled: false, BrowserWindow }
  if (modes.has(app)) return modes.get(app)

  for (const flag of backgroundSwitches) app.commandLine.appendSwitch(flag)
  app.on('web-contents-created', (_event, contents) => {
    contents.focus = noop
    contents.openDevTools = noop
  })
  const { dialog, shell, Menu } = electron
  dialog.showErrorBox = noop
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  dialog.showSaveDialog = async () => ({ canceled: true })
  if (shell) {
    shell.openExternal = async () => {}
    shell.openPath = async () => 'Native windows are disabled during hidden tests'
    shell.showItemInFolder = noop
  }
  if (Menu) Menu.prototype.popup = noop

  const active = new Set()
  const displays = () => electron.screen.getAllDisplays()
  const parkAll = () => {
    for (const { win, park } of active) {
      if (!win.isDestroyed()) park()
    }
  }
  app.whenReady?.().then(() => {
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) electron.screen.on(event, parkAll)
  })

  const TestWindow = new Proxy(BrowserWindow, {
    construct(NativeWindow, [options = {}]) {
      const win = new NativeWindow({
        ...options, ...parkingPoint(displays()),
        show: false, focusable: false, skipTaskbar: true, alwaysOnTop: false,
        fullscreen: false, fullscreenable: false,
        webPreferences: { ...options.webPreferences, backgroundThrottling: false }
      })
      const nativeSetBounds = win.setBounds.bind(win)
      const nativeShowInactive = win.showInactive.bind(win)
      const park = (bounds = win.getBounds()) => {
        const screens = displays()
        nativeSetBounds({ ...bounds, ...parkingPoint(screens) })
        return !screens.some(({ bounds }) => overlaps(win.getBounds(), bounds))
      }
      win.setBounds = bounds => park(bounds)
      win.setPosition = () => park()
      win.center = () => park()
      win.show = win.showInactive = () => {
        if (park()) nativeShowInactive()
      }
      for (const name of [
        'focus', 'moveTop', 'setAlwaysOnTop', 'flashFrame', 'setFullScreen', 'setSimpleFullScreen',
        'setKiosk', 'restore', 'setFocusable', 'setSkipTaskbar'
      ]) win[name] = noop
      // Exercise resize and restore without calling native maximize, which moves to a real display.
      let normalBounds = null
      win.getNormalBounds = () => normalBounds ?? win.getBounds()
      win.isMaximized = () => normalBounds !== null
      win.maximize = () => {
        if (normalBounds || win.isMaximizable?.() === false) return
        const display = electron.screen.getPrimaryDisplay?.() ?? displays()[0]
        const area = display?.workArea ?? display?.bounds
        if (!area) return
        normalBounds = win.getBounds()
        park({ width: area.width, height: area.height })
        win.emit('maximize')
      }
      win.unmaximize = () => {
        if (!normalBounds) return
        const bounds = normalBounds
        normalBounds = null
        park(bounds)
        win.emit('unmaximize')
      }
      // Renderer resizeTo/moveTo requests are separate from the app's BrowserWindow methods.
      win.webContents.on('content-bounds-updated', (event, bounds) => {
        event.preventDefault()
        park(bounds)
      })
      const record = { win, park }
      active.add(record)
      win.once('closed', () => active.delete(record))
      if (options.show !== false) win.showInactive()
      return win
    }
  })
  const mode = { enabled: true, BrowserWindow: TestWindow }
  modes.set(app, mode)
  return mode
}

module.exports = { createTestWindows }
