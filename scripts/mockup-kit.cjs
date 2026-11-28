#!/usr/bin/env node
// The mockup starter kit (docs/plan/2026-11-28-mockup-kit.md): a snapshot of the real app's screen and all
// of its CSS, so a mockup starts from ezShell's own design instead of a palette an agent makes up.
//
//   npm run build && npm run mockup:kit
//
// Starts the built app like the screen tests (hidden windows, a fresh profile, the fake agents of
// e2e/support/localAgentApp.js), opens a local project with an agent tab and the workspace panel, then writes
//   mockups/_kit/ezshell.css   every style rule the page has, fonts and images copied beside it
//   mockups/_kit/app.html      the screen as static HTML (no scripts) linking ezshell.css
//   mockups/_kit/themes.json   the theme ids the CSS knows (data-theme on <html>)
'use strict'
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const KIT = path.join(ROOT, 'mockups', '_kit')
// `-- --theme minimal-light`: the snapshot in another theme (themes.json lists the ids). The default theme's
// snapshot is app.html; another theme's is app.<id>.html beside it, sharing ezshell.css.
const themeArg = process.argv.indexOf('--theme')
const THEME = themeArg > 0 ? process.argv[themeArg + 1] : null
if (THEME !== null && !/^[a-z0-9-]{1,60}$/.test(THEME ?? '')) throw new Error('--theme needs a theme id from mockups/_kit/themes.json')
const PORT = Number(process.env.MOCKUP_KIT_PORT) || 19420
process.env.E2E_CDP = `http://127.0.0.1:${PORT}`
const { connect, sleep, unlock, openLocalAgent } = require(path.join(ROOT, 'e2e', 'support', 'driver.js'))

async function portAnswers() {
  try { await fetch(`${process.env.E2E_CDP}/json/version`); return true } catch { return false }
}

/** A small repository with an uncommitted change, so the workspace panel has something to show */
function sampleProject(profile) {
  const folder = path.join(profile, 'sample-service')
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true })
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Mockup', '-c', 'user.email=mockup@example.invalid', ...args], { cwd: folder, stdio: 'pipe', windowsHide: true })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(folder, 'README.md'), '# sample-service\n')
  fs.writeFileSync(path.join(folder, 'src', 'app.js'), 'export const start = () => {}\n')
  git('add', '.')
  git('commit', '-q', '-m', 'Start')
  fs.appendFileSync(path.join(folder, 'src', 'app.js'), 'export const stop = () => {}\n')
  fs.writeFileSync(path.join(folder, 'src', 'routes.js'), 'export const routes = []\n')
  return folder
}

// Runs in the page: every rule of every stylesheet, and the url(...) files they use
const COLLECT_CSS = `(() => {
  const parts = []
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    parts.push('/* ' + (sheet.href ? sheet.href.split('/').pop() : 'inline') + ' */')
    // url(...) is relative to its own stylesheet: made absolute here, copied beside the kit by the script
    const base = sheet.href || location.href
    for (const rule of rules) parts.push(rule.cssText.replace(/url\\((['"]?)([^'")]+)\\1\\)/g, (whole, quote, ref) => {
      if (/^(data:|#)/.test(ref)) return whole
      try { return 'url("' + new URL(ref, base).href + '")' } catch { return whole }
    }))
  }
  return parts.join('\\n')
})()`

// Runs in the page: the document as static HTML. Scripts go; form values stay as attributes.
const COLLECT_HTML = `(() => {
  for (const input of document.querySelectorAll('input, textarea')) {
    if (input.type === 'password') continue
    if (input.tagName === 'TEXTAREA') input.textContent = input.value
    else input.setAttribute('value', input.value)
  }
  const copy = document.documentElement.cloneNode(true)
  for (const node of copy.querySelectorAll('script, link[rel="modulepreload"], link[rel="stylesheet"], style, iframe, webview')) node.remove()
  return copy.outerHTML
})()`

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out', 'renderer', 'index.html'))) throw new Error('out/ is missing: run `npm run build` first')
  if (await portAnswers()) throw new Error(`port ${PORT} is in use: set MOCKUP_KIT_PORT`)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ezshell-mockup-kit-'))
  // EZSHELL_TEST_GIT: the fixture app keeps git on PATH (it strips PATH to its fake agents otherwise)
  const env = { ...process.env, EZSHELL_TEST_HIDDEN_WINDOWS: '1', EZSHELL_TEST_GIT: '1' }
  for (const name of Object.keys(env)) if (/^EZSHELL_(?!TEST_)/.test(name)) delete env[name]
  const app = spawn(require(path.join(ROOT, 'node_modules', 'electron')), [
    path.join(ROOT, 'e2e', 'support', 'localAgentApp.js'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'
  ], { cwd: ROOT, stdio: 'ignore', env })
  try {
    for (let tries = 0; tries < 240 && !(await portAnswers()); tries++) await sleep(250)
    const driver = await connect()
    const { js, send, until } = driver
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    if (THEME) {
      // The theme store's own saved form (stores/themeStore.ts, persist name 'theme-store'), then a reload
      await js(`localStorage.setItem('theme-store', ${JSON.stringify(JSON.stringify({ state: { currentThemeId: THEME }, version: 0 }))}); location.reload()`)
      await sleep(3000)
    }
    await unlock(driver)
    if (THEME && await js(`document.documentElement.dataset.theme`) !== THEME) throw new Error(`the app did not take the theme ${THEME}`)
    const folder = sampleProject(profile)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([folder]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    await openLocalAgent(driver, 'claude', folder)
    await until(`document.body.textContent.includes('fixture ready')`, 30000)
    await js(`document.querySelector('.workspace-indicator')?.click()`)
    if (await until(`!!document.querySelector('#workspace-tab-changes')`, 8000)) {
      await js(`document.querySelector('#workspace-tab-changes').click()`)
      await until(`!!document.querySelector('.workspace-git-file')`, 8000)
    }
    await sleep(1500)

    if (!THEME) fs.rmSync(KIT, { recursive: true, force: true })
    fs.mkdirSync(path.join(KIT, 'assets'), { recursive: true })
    const page = THEME ? `app.${THEME}` : 'app'
    // The real screen at the same moment, to compare a mockup made from app.html against
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const png = shot?.result?.data ?? shot?.data
    if (png) fs.writeFileSync(path.join(KIT, `${page}-real.png`), Buffer.from(png, 'base64'))
    // url(...) of the app's own files (fonts, images): copied beside the CSS, the rest left as it is
    let css = await js(COLLECT_CSS)
    const pageUrl = await js('location.href')
    css = css.replace(/url\((['"]?)([^'")]+)\1\)/g, (whole, _quote, ref) => {
      if (/^(data:|#)/.test(ref)) return whole
      let source
      try { source = new URL(ref, pageUrl) } catch { return whole }
      if (source.protocol !== 'file:') return whole
      const file = decodeURIComponent(source.pathname.replace(/^\/([A-Za-z]:)/, '$1'))
      if (!fs.existsSync(file)) return whole
      const name = path.basename(file)
      fs.copyFileSync(file, path.join(KIT, 'assets', name))
      return `url("assets/${name}")`
    })
    fs.writeFileSync(path.join(KIT, 'ezshell.css'), css)
    const themes = [...new Set([...css.matchAll(/\[data-theme="([^"]+)"\]/g)].map(match => match[1]))].sort()
    fs.writeFileSync(path.join(KIT, 'themes.json'), JSON.stringify(themes, null, 1) + '\n')
    const html = (await js(COLLECT_HTML))
      .replace(/<head>/, '<head>\n<meta charset="utf-8">\n<link rel="stylesheet" href="ezshell.css">')
      .split(folder).join('C:\\work\\sample-service')
      .split(profile).join('C:\\work')
      // Started from out/main the app reports Electron's version; the mockup shows ezShell's
      .replace(/>v\d+\.\d+\.\d+</, `>v${require(path.join(ROOT, 'package.json')).version}<`)
    fs.writeFileSync(path.join(KIT, `${page}.html`), '<!doctype html>\n' + html)
    driver.close?.()
    console.log(`mockups/_kit: ezshell.css ${(css.length / 1024).toFixed(0)}KB, ${page}.html ${(html.length / 1024).toFixed(0)}KB, ${themes.length} themes`)
  } finally {
    app.kill()
    await sleep(500)
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* A file was still held */ }
  }
}

main().then(() => process.exit(0), error => {
  console.error(error.message)
  process.exit(1)
})
