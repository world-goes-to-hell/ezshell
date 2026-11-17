// A detached window (MCP activity) opens where the last one of its kind was left: place, size,
// maximized, and the default when the saved place is on no screen. Run by e2e/run.js.
const fs = require('fs'), path = require('path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`) }
const PROFILE = process.env.E2E_PROFILE
const pages = async () => (await (await fetch(process.env.E2E_CDP + '/json')).json()).filter((t) => t.type === 'page')
const connect = async (target) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res) => { ws.onopen = res })
  let id = 0; const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
  const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value }
  return { send, js, close: () => ws.close() }
}
const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(250) } return null }
const SET = `(el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }`
const activityPage = () => until(async () => (await pages()).find((p) => p.url.includes('mcpActivityMode')))
const bounds = (page) => page.js(`({ left: window.screenX, top: window.screenY, width: window.outerWidth, height: window.outerHeight })`)
const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(PROFILE, 'detached-window-state.json'), 'utf-8')) } catch { return null } }

;(async () => {
  const mainTarget = await until(async () => { try { return (await pages()).find((p) => !p.url.includes('Mode=')) } catch { return null } }, 40000)
  const main = await connect(mainTarget)
  await until(() => main.js(`document.querySelectorAll('input[type=password]').length > 0 || !!document.querySelector('.btn-quick-connect')`))
  if (await main.js(`document.querySelectorAll('input[type=password]').length > 0`)) await main.js(`(() => { const set = ${SET}; [...document.querySelectorAll('input[type=password]')].forEach(i => set(i, 'test-pass-1234')); document.querySelector('button[type=submit]').click() })()`)
  await until(() => main.js(`!!document.querySelector('.btn-quick-connect')`))
  await sleep(800)

  // 1) first open: default size
  console.log('open:', JSON.stringify(await main.js(`window.electronAPI.openMcpActivityWindow()`)))
  let page = await connect(await activityPage())
  let b = await bounds(page)
  console.log('first bounds', JSON.stringify(b))
  check('with nothing saved the window opens at its default size', b && Math.abs(b.width - 960) <= 2 && Math.abs(b.height - 680) <= 2, JSON.stringify(b))

  // 2) move and resize it, then close
  const target = { left: b.left + 137, top: b.top + 91, width: 1040, height: 610 }
  await page.js(`(window.resizeTo(${target.width}, ${target.height}), window.moveTo(${target.left}, ${target.top}))`)
  await sleep(1200)
  b = await bounds(page)
  check('the window was moved and resized', b.left === target.left && b.top === target.top && b.width === target.width && b.height === target.height, JSON.stringify(b))
  check('the place is saved while the window is open (after it settles)', saved()?.mcpActivity?.x === target.left && saved()?.mcpActivity?.width === target.width, JSON.stringify(saved()))
  await page.js(`window.close()`).catch(() => {})
  page.close()
  await until(async () => !(await pages()).some((p) => p.url.includes('mcpActivityMode')))
  await sleep(500)

  // 3) open again: same place
  await main.js(`window.electronAPI.openMcpActivityWindow()`)
  page = await connect(await activityPage())
  b = await bounds(page)
  check('the next window of the kind opens at the remembered place and size', b.left === target.left && b.top === target.top && b.width === target.width && b.height === target.height, JSON.stringify(b))
  check('only the kind that was moved is in the file', JSON.stringify(Object.keys(saved() || {})) === '["mcpActivity"]', JSON.stringify(saved()))

  // 4) maximized is remembered
  await page.js(`window.electronAPI.maximizeWindow()`)
  await sleep(1200)
  check('maximizing is saved with the size before it', saved()?.mcpActivity?.isMaximized === true && saved()?.mcpActivity?.width === target.width, JSON.stringify(saved()))
  await page.js(`window.close()`).catch(() => {})
  page.close()
  await until(async () => !(await pages()).some((p) => p.url.includes('mcpActivityMode')))
  await sleep(500)
  await main.js(`window.electronAPI.openMcpActivityWindow()`)
  page = await connect(await activityPage())
  await sleep(600)
  b = await bounds(page)
  const screenSize = await page.js(`({ w: screen.availWidth, h: screen.availHeight })`)
  check('the next window opens maximized', b.width >= screenSize.w && b.height >= screenSize.h, JSON.stringify([b, screenSize]))

  // 5) a place off every screen is not used
  await page.js(`window.close()`).catch(() => {})
  page.close()
  await until(async () => !(await pages()).some((p) => p.url.includes('mcpActivityMode')))
  await sleep(500)
  fs.writeFileSync(path.join(PROFILE, 'detached-window-state.json'), JSON.stringify({ mcpActivity: { x: 90000, y: 90000, width: 1040, height: 610, isMaximized: false } }))
  await main.js(`window.electronAPI.openMcpActivityWindow()`)
  page = await connect(await activityPage())
  b = await bounds(page)
  check('a saved place that is on no screen falls back to the default', b.left < 20000 && Math.abs(b.width - 960) <= 2, JSON.stringify(b))

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
