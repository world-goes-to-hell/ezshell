// An SSH tab connects to the test server (host key asked once), and `SFTP 를 현재 폴더로` opens the
// SFTP panel at the terminal's folder, follows a `cd`, and lists the folder's files.
// Run by e2e/run.js, which starts e2e/support/sshd.js for specs named ssh-*.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`) }
;(async () => {
  let list = []
  for (let i = 0; i < 60 && !list.some((t) => t.type === 'page'); i++) { try { list = await (await fetch(process.env.E2E_CDP + '/json')).json() } catch {} await sleep(500) }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res) => { ws.onopen = res })
  let id = 0; const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
  const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value }
  const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(250) } return false }
  let at = [600, 400]
  const rawMouse = (type, x, y, button = 'none') => send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: button === 'none' ? 0 : 1 })
  const move = async (x, y) => { const [fx, fy] = at; for (let i = 1; i <= 10; i++) { await rawMouse('mouseMoved', fx + (x - fx) * i / 10, fy + (y - fy) * i / 10); await sleep(15) } at = [x, y] }
  const click = async (x, y, button = 'left') => { await move(x, y); await rawMouse('mousePressed', x, y, button); await rawMouse('mouseReleased', x, y, button) }
  const center = (expr) => js(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  const item = (label) => `[...document.querySelectorAll('.terminal-menu-item')].find(i => i.textContent.trim() === ${JSON.stringify(label)})`
  const type = async (text) => { for (const ch of text) { await send('Input.insertText', { text: ch }); await sleep(8) } }
  const enter = async () => { for (const t of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type: t, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: t === 'keyDown' ? '\r' : undefined }) }
  const SET = `(el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }`
  // The remote pane's path: the last path bar in the SFTP panel
  const remotePath = () => js(`(() => { const bars = [...document.querySelectorAll('.sftp-panel input, .sftp-panel [class*="path"]')].map(e => (e.value ?? e.textContent ?? '').trim()).filter(Boolean); return JSON.stringify(bars) })()`)
  const sync = async () => {
    const term = await center(`document.querySelector('.terminal-container:not(.split-terminal) .xterm-screen')`)
    await click(term[0], term[1] - 60, 'right'); await sleep(400)
    const tools = await center(item('편의')); await move(tools[0] - 3, tools[1]); await sleep(60); await move(tools[0], tools[1]); await sleep(450)
    const go = await center(item('SFTP 를 현재 폴더로'))
    if (!go) throw new Error('no menu item')
    await click(go[0], go[1]); await sleep(1500)
  }

  await until(`document.querySelectorAll('input[type=password]').length > 0 || !!document.querySelector('.btn-quick-connect')`, 20000)
  if (await js(`document.querySelectorAll('input[type=password]').length > 0`)) await js(`(() => { const set = ${SET}; [...document.querySelectorAll('input[type=password]')].forEach(i => set(i, 'test-pass-1234')); document.querySelector('button[type=submit]').click() })()`)
  await until(`!!document.querySelector('.btn-quick-connect')`)
  await js(`document.querySelector('.btn-quick-connect').click()`)
  await until(`!!document.querySelector('input[placeholder="192.168.1.1"]')`)
  await js(`(() => { const set = ${SET}; set(document.querySelector('input[placeholder="192.168.1.1"]'), '127.0.0.1'); const port = [...document.querySelectorAll('.modal-content input')].find(i => i.value === '22'); if (port) set(port, '${process.env.E2E_SSH_PORT}'); set(document.querySelector('input[placeholder="root"]'), 'tester'); set(document.querySelector('input[placeholder="••••••••"]'), 'x') })()`)
  await js(`document.querySelector('.modal-content button[type=submit]').click()`)
  const trust = `[...document.querySelectorAll('button')].find(b => b.textContent.includes('신뢰하고 접속'))`
  if (await until(`!!${trust}`, 15000)) { await send('Page.bringToFront'); for (let i = 0; i < 8 && await js(`!!${trust}`); i++) { await sleep(1000); const c = await center(trust); if (c) await click(c[0], c[1]) } }
  check('SSH tab connected', await until(`!!document.querySelector('.terminal-container .xterm-rows')`, 15000))
  await sleep(1500)

  // 1. Panel closed: opens at the terminal's folder
  await sync()
  check('SFTP panel opens', await until(`!!document.querySelector('.sftp-panel')`, 5000))
  await sleep(1000)
  let paths = await remotePath()
  check('at /var (the folder in the prompt)', paths.includes('"/var"'), paths)

  // 2. Panel open: goes to the new folder
  const term = await center(`document.querySelector('.terminal-container:not(.split-terminal) .xterm-screen')`)
  await click(term[0], term[1] - 60); await sleep(300)
  await type('etc'); await enter(); await sleep(800)
  await sync()
  paths = await remotePath()
  check('follows to /etc', paths.includes('"/etc"'), paths)
  check('and lists the files of that folder', await until(`(document.querySelector('.sftp-panel')?.textContent || '').includes('hosts')`, 8000))

  // 3. Home (~) is asked from the server
  await click(term[0], term[1] - 60); await sleep(300)
  await type('home'); await enter(); await sleep(800)
  await sync()
  paths = await remotePath()
  check('~ becomes the login folder (/ on the test server)', paths.includes('"/"') && !paths.includes('"/etc"'), paths)
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
