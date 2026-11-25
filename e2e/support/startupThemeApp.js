// One process seeds the built app's storage. A fresh process observes its normal startup and reveal.
const electron = require('electron')
const { app, systemPreferences } = electron
const { BrowserWindow } = require('../../out/main/src/testWindows.js').createTestWindows(electron)
const fs = require('node:fs')
const path = require('node:path')

const built = path.resolve(__dirname, '../../out')
const themeId = process.env.E2E_STARTUP_THEME
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(read, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read()
    if (value) return value
    await pause(25)
  }
  throw new Error(description)
}

async function observeSplash(splash, getMainWindow) {
  const contents = splash.webContents
  const violations = []
  contents.on('console-message', ({ message }) => {
    if (/Content Security Policy/i.test(message)) violations.push(message)
  })
  const finished = new Promise(resolve => splash.once('closed', resolve))
  const snapshot = await until(() => contents.executeJavaScript(`(() => {
    const root = document.querySelector('.startup')
    const terminal = root?.querySelector('.boot-term')
    if (!terminal?.querySelector('.boot-line')?.textContent.includes('ezshell --boot')) return null
    if (['covering', 'leaving'].includes(terminal.dataset.phase)) return null
    const controls = terminal.querySelector('.boot-buttons')
    const title = terminal.querySelector('.boot-title')
    const css = getComputedStyle(terminal)
    const palette = ['--t-bg', '--t-fg', '--t-green', '--t-blue', '--t-cursor'].map(name => css.getPropertyValue(name).trim())
    return {
      savedTheme: JSON.parse(localStorage.getItem('theme-store')).state.currentThemeId,
      theme: root.dataset.theme,
      chrome: root.dataset.chrome ?? 'default',
      palette, bodyColor: css.backgroundColor, inkColor: css.color,
      bodyRadius: css.borderTopLeftRadius,
      outsideColor: getComputedStyle(document.body).backgroundColor,
      controlColor: getComputedStyle(controls.firstElementChild).backgroundColor,
      controlsOnLeft: controls.getBoundingClientRect().left < title.getBoundingClientRect().left,
      bounds: terminal.getBoundingClientRect().toJSON()
    }
  })()`), 'the built startup terminal did not show the command')
  const { bounds, ...result } = snapshot
  const shot = await contents.capturePage({
    x: Math.floor(bounds.left) - 12, y: Math.floor(bounds.top) - 12,
    width: Math.ceil(bounds.width) + 24, height: Math.ceil(bounds.height) + 24
  })
  if (shot.isEmpty()) throw new Error('the startup screenshot is empty')
  fs.writeFileSync(path.join(process.env.E2E_OUT, `startup-theme-${themeId}.png`), shot.toPNG())
  await finished
  const main = getMainWindow()
  const mainTheme = await main.webContents.executeJavaScript('document.documentElement.dataset.theme')
  fs.writeFileSync(path.join(app.getPath('userData'), 'startup-theme.json'),
    JSON.stringify({ ...result, mainTheme, mainShown: main.isVisible(), violations }))
}

async function seedTheme() {
  const seed = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  await seed.loadFile(path.join(built, 'renderer/index.html'))
  const choice = JSON.stringify({ state: { currentThemeId: themeId }, version: 0 })
  await seed.webContents.executeJavaScript(`localStorage.setItem('theme-store', ${JSON.stringify(choice)})`)
  seed.webContents.session.flushStorageData()
  app.quit()
}

function observeApp() {
  let main
  app.on('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', () => {
      const url = window.webContents.getURL()
      if (url.includes('startupMode=true')) {
        observeSplash(window, () => main).then(() => app.exit(0), fail)
      } else if (url.endsWith('/index.html')) {
        main = window
      }
    })
  })
  const animationSettings = systemPreferences.getAnimationSettings.bind(systemPreferences)
  systemPreferences.getAnimationSettings = () => ({ ...animationSettings(), prefersReducedMotion: false })
  require(path.join(built, 'main/index.js'))
}

function fail(error) {
  console.error(error)
  app.exit(1)
}

if (app.commandLine.hasSwitch('seed-startup-theme')) app.whenReady().then(seedTheme).catch(fail)
else observeApp()
