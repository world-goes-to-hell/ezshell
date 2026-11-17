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

/** Attaches to the app's main page (E2E_CDP) */
async function connect() {
  let list = []
  for (let i = 0; i < 60 && !list.some((t) => t.type === 'page'); i++) {
    try { list = await (await fetch(process.env.E2E_CDP + '/json')).json() } catch { /* not up yet */ }
    await sleep(500)
  }
  const page = list.find((t) => t.type === 'page')
  if (!page) throw new Error('the app has no page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => { ws.onopen = resolve })
  let id = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
  }
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id
    pending.set(n, resolve)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
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

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    if (r.result?.data && process.env.E2E_OUT) fs.writeFileSync(path.join(process.env.E2E_OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  }

  return { send, js, until, move, click, center, pointer, type, enter, item, pick, hover, openSubmenu, shot }
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

module.exports = { sleep, createChecks, connect, unlock, connectSsh, SET, PANEL }
