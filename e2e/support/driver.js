// What the newer specs share: the CDP connection to the app under test, pointer and keyboard input,
// getting past the lock screen, and opening an SSH tab on the test server (e2e/support/sshd.js).
// The older specs carry their own copy of these lines; new ones should start from here.
const fs = require('fs')
const path = require('path')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** PASS/FAIL lines and the exit code the runner looks at */
function createChecks() {
  let failures = 0
  return {
    check(name, ok, detail = '') {
      if (!ok) failures++
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`)
    },
    finish() {
      console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
      process.exit(failures ? 1 : 0)
    }
  }
}

/** The app's windows, as CDP page targets */
async function pages() {
  try {
    return (await (await fetch(process.env.E2E_CDP + '/json')).json()).filter((t) => t.type === 'page')
  } catch {
    return []
  }
}

/** The main window's page: the startup splash and detached windows carry a `...Mode=true` query */
const isMainPage = (target) => Boolean(target.url) && target.url !== 'about:blank' && !/Mode=/.test(target.url)

/** Waits for a window whose page matches (for example `t => t.url.includes('terminalMode')`) */
async function findPage(match, ms = 30000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const page = (await pages()).find(match)
    if (page) return page
    await sleep(300)
  }
  return null
}

/** Attaches to a window of the app: the main one, or the one `match` picks */
async function connect(match = isMainPage, { focus = true } = {}) {
  const page = await findPage(match)
  if (!page) throw new Error('the app has no such page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => { ws.onopen = resolve })
  let id = 0
  const pending = new Map()
  // CDP events of this page (for example Log.entryAdded after `send('Log.enable')`)
  const events = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
    else if (message.method) events.push(message)
  }
  const send = (method, params = {}) => new Promise((resolve) => {
    if (process.env.EZSHELL_TEST_HIDDEN_WINDOWS === '1') {
      if (method === 'Page.bringToFront') {
        method = 'Emulation.setFocusEmulationEnabled'
        params = { enabled: true }
      } else if (method === 'Browser.setWindowBounds') {
        const { width, height } = params.bounds
        if (width === undefined && height === undefined) return resolve({ result: {} })
        params = { ...params, bounds: { width, height } }
      }
    }
    const n = ++id
    pending.set(n, resolve)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  if (focus && process.env.EZSHELL_TEST_HIDDEN_WINDOWS === '1') {
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
    return r.result?.result?.value
  }
  const until = async (expression, ms = 15000) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (await js(expression)) return true
      await sleep(250)
    }
    return false
  }

  // Pointer: moved in steps (submenus and the pane grip follow the pointer's path)
  let at = [600, 400]
  const rawMouse = (type, x, y, button = 'none') => send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: button === 'none' ? 0 : 1 })
  const move = async (x, y) => {
    const [fx, fy] = at
    for (let i = 1; i <= 10; i++) { await rawMouse('mouseMoved', fx + (x - fx) * i / 10, fy + (y - fy) * i / 10); await sleep(15) }
    at = [x, y]
  }
  const click = async (x, y, button = 'left') => { await move(x, y); await rawMouse('mousePressed', x, y, button); await rawMouse('mouseReleased', x, y, button) }
  const center = (expr) => js(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  const pointer = () => at

  // Keyboard
  const type = async (text) => { for (const ch of text) { await send('Input.insertText', { text: ch }); await sleep(8) } }
  const enter = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }

  // Terminal right-click menu
  const item = (label) => `[...document.querySelectorAll('.terminal-menu-item')].find(i => i.textContent.trim() === ${JSON.stringify(label)})`
  const pick = async (label) => {
    // A submenu's items are not there the moment it opens
    await until(`!!${item(label)}`, 3000)
    const c = await center(item(label))
    if (!c) throw new Error('no menu item ' + label)
    await click(c[0], c[1])
    await sleep(350)
  }
  const hover = async (label) => {
    const c = await center(item(label))
    if (!c) throw new Error('no menu item ' + label)
    await move(c[0] - 3, c[1]); await sleep(60); await move(c[0], c[1]); await sleep(450)
  }
  /** Right-clicks at a point and opens a submenu of the terminal menu */
  const openSubmenu = async (x, y, label) => {
    await click(x, y, 'right')
    await until(`!!document.querySelector('.terminal-menu-item')`, 4000)
    await sleep(150)
    // The submenu opens from the pointer's path; on a busy machine the first try can miss
    for (let i = 0; i < 4; i++) {
      await hover(label)
      if (await js(`document.querySelectorAll('.terminal-menu').length >= 2`)) return
      await move(at[0] - 40, at[1] - 6)
    }
    throw new Error('the submenu did not open: ' + label)
  }
  /** Right-click, submenu, item; tried again once from the start (a menu can close under a moving pointer) */
  const menuPick = async (x, y, submenu, label) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await openSubmenu(x, y, submenu)
        await pick(label)
        return
      } catch (error) {
        if (attempt >= 1) throw error
        console.log(`  (menu retry: ${error.message})`)
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await sleep(500)
      }
    }
  }

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    if (r.result?.data && process.env.E2E_OUT) fs.writeFileSync(path.join(process.env.E2E_OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  }

  return { send, js, until, move, click, center, pointer, type, enter, item, pick, hover, openSubmenu, menuPick, shot, events, close: () => ws.close() }
}

/** Sets an input's value the way React notices */
const SET = `(el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }`

/** A fresh profile asks for a new master password; then the start screen is up */
async function unlock({ js, until }) {
  await until(`document.querySelectorAll('input[type=password]').length > 0 || !!document.querySelector('.btn-quick-connect')`, 20000)
  if (await js(`document.querySelectorAll('input[type=password]').length > 0`)) {
    await js(`(() => { const set = ${SET}; [...document.querySelectorAll('input[type=password]')].forEach(i => set(i, 'test-pass-1234')); document.querySelector('button[type=submit]').click() })()`)
  }
  if (!(await until(`!!document.querySelector('.btn-quick-connect')`))) throw new Error('the start screen did not appear')
  await sleep(800)
}

/** The SSH tab in front (a tab behind is hidden with visibility, not display) */
const PANEL = `[...document.querySelectorAll('.terminal-panel')].find(p => p.offsetParent !== null && getComputedStyle(p).visibility !== 'hidden')`

/** Opens the local project dialog with the registered folders (command palette "로컬 작업 열기"). */
async function openLocalProject({ send, js, until }) {
  // Not from inside a terminal: the shell can take the key first
  await js(`document.activeElement?.blur()`)
  const key = { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: process.platform === 'darwin' ? 4 : 2 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  const item = `[...document.querySelectorAll('.command-item')].find(i => i.textContent.includes('로컬 작업 열기'))`
  if (!(await until(`!!${item}`, 4000))) throw new Error('the command palette did not open')
  await js(`${item}.click()`)
  if (!(await until(`!!document.querySelector('.local-project-dialog')`))) throw new Error('local project dialog did not open')
}

/**
 * Opens a local terminal tab running an agent ('claude' / 'codex') in a folder. The dialog opens the
 * user's shell only, so this goes through the page's own event (OPEN_LOCAL_TERMINAL_EVENT in lib/localProjectList.ts).
 */
async function openLocalAgent({ js }, agent, cwd) {
  // The tab is named after the folder, as the dialog names it
  const workspaceLabel = cwd ? require('path').basename(cwd) : undefined
  await js(`window.dispatchEvent(new CustomEvent('ezshell:open-local-terminal', { detail: ${JSON.stringify({ agent, cwd, workspaceLabel })} }))`)
}

/** Picks a work group from the selector at the start of the tab strip (the group's name as shown) */
async function pickTabGroup({ js, until, center, click }, name) {
  const at = await center(`document.querySelector('.tab-group-select')`)
  await click(at[0], at[1])
  const option = `[...document.querySelectorAll('.tab-group-option')].find(o => o.querySelector('.tab-group-option-name')?.textContent === ${JSON.stringify(name)})`
  if (!(await until(`!!${option}`, 4000))) throw new Error(`no work group named ${name}`)
  const spot = await center(option)
  await click(spot[0], spot[1])
}

async function selectThemeTab({ js, until }, label) {
  const tab = `[...document.querySelectorAll('[role=tablist][aria-label="테마 설정"] > [role=tab]')]
    .find(tab => tab.textContent.trim() === ${JSON.stringify(label)})`
  if (!await until(`!!${tab}`)) throw new Error(`No theme settings tab named ${label}`)
  await js(`${tab}.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
  if (!await until(`${tab}.getAttribute('aria-selected') === 'true'`)) throw new Error(`Theme settings tab ${label} did not open`)
}

/** Quick connect to the test server; trusts its host key the first time. Resolves when a shell is on screen. */
async function connectSsh(driver) {
  const { send, js, until, click, center } = driver
  const before = await js(`document.querySelectorAll('.terminal-tab').length`)
  await js(`document.querySelector('.btn-quick-connect').click()`)
  await until(`!!document.querySelector('input[placeholder="192.168.1.1"]')`)
  await js(`(() => { const set = ${SET}; set(document.querySelector('input[placeholder="192.168.1.1"]'), '127.0.0.1'); const port = [...document.querySelectorAll('.modal-content input')].find(i => i.value === '22'); if (port) set(port, '${process.env.E2E_SSH_PORT}'); set(document.querySelector('input[placeholder="root"]'), 'tester'); set(document.querySelector('input[placeholder="••••••••"]'), 'x') })()`)
  await js(`document.querySelector('.modal-content button[type=submit]').click()`)
  const trust = `[...document.querySelectorAll('button')].find(b => b.textContent.includes('신뢰하고 접속'))`
  const tabOpened = `document.querySelectorAll('.terminal-tab').length > ${before}`
  // Either the host key question (first connection of this profile) or the tab
  await until(`!!${trust} || ${tabOpened}`, 15000)
  if (await js(`!!${trust}`)) {
    await send('Page.bringToFront')
    // The button arms a moment after the dialog shows
    for (let i = 0; i < 8 && await js(`!!${trust}`); i++) {
      await sleep(1000)
      const c = await center(trust)
      if (c) await click(c[0], c[1])
    }
  }
  const ok = await until(`${tabOpened} && (${PANEL}?.querySelector('.terminal-container .xterm-rows')?.textContent || '').includes('fake shell')`, 20000)
  await sleep(800)
  return ok
}

/**
 * Console errors and Content Security Policy refusals of a page so far. `Log.enable` replays the
 * entries the browser kept, so this also sees what happened before the spec attached.
 */
async function pageProblems(page) {
  await page.send('Log.enable')
  await sleep(400)
  return page.events
    .filter((e) => e.method === 'Log.entryAdded' && (e.params.entry.level === 'error' || /Content Security Policy/i.test(e.params.entry.text)))
    .map((e) => e.params.entry.text.slice(0, 240))
}

module.exports = { pageProblems, sleep, createChecks, connect, pages, findPage, isMainPage, unlock, connectSsh, openLocalProject, openLocalAgent, pickTabGroup, selectThemeTab, SET, PANEL }
