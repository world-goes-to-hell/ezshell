// Changing an app shortcut in the settings: refused combinations, saving, the old key stops working,
// reset. Run by e2e/run.js (fresh profile, no server needed).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { findPage, isMainPage } = require('../support/driver')
let failures = 0
const check = (n, ok, d = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`) }
;(async () => {
  const mainPage = await findPage(isMainPage)
  if (!mainPage) throw new Error('the app has no main page')
  const ws = new WebSocket(mainPage.webSocketDebuggerUrl)
  await new Promise((res) => { ws.onopen = res })
  let id = 0; const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })) })
  const js = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value }
  const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(200) } return false }
  const VK = { j: 74, p: 80, n: 78, c: 67, k: 75 }
  const combo = async (letter, { ctrl = false, shift = false } = {}) => {
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0)
    const base = { key: letter, code: 'Key' + letter.toUpperCase(), windowsVirtualKeyCode: VK[letter], modifiers }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(350)
  }
  const esc = async () => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(350)
  }
  const SET = `(el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }`
  // Without OS focus (another window in front) a dialog's closing animation did not finish and it stayed
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const palette = () => js(`!!document.querySelector('.command-palette')`)
  const row = (name) => `[...document.querySelectorAll('.shortcut-item')].find(r => r.querySelector('.shortcut-description')?.textContent === ${JSON.stringify(name)})`
  const keysOf = (name) => js(`[...${row(name)}.querySelectorAll('.shortcut-key')].map(k => k.textContent).join('+')`)
  const openShortcuts = async () => {
    // Ctrl+, opens the settings
    const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 }
    await js(`document.activeElement && document.activeElement.blur()`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma })
    if (!(await until(`!!document.querySelector('.settings-tab-trigger')`, 5000))) console.log('settings did not open; buttons:', await js(`[...document.querySelectorAll('button')].map(b => b.title || b.getAttribute('aria-label') || b.textContent.trim().slice(0, 12)).filter(Boolean).slice(0, 30).join(' | ')`))
    // Radix tabs switch on mousedown, not on click
    await js(`[...document.querySelectorAll('.settings-tab-trigger')].find(t => t.textContent.includes('단축키')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
    return until(`!!${row('명령 팔레트 열기')}`, 5000)
  }

  await until(`document.querySelectorAll('input[type=password]').length > 0 || !!document.querySelector('.btn-quick-connect')`, 20000)
  if (await js(`document.querySelectorAll('input[type=password]').length > 0`)) await js(`(() => { const set = ${SET}; [...document.querySelectorAll('input[type=password]')].forEach(i => set(i, 'test-pass-1234')); document.querySelector('button[type=submit]').click() })()`)
  await until(`!!document.querySelector('.btn-quick-connect')`)
  await sleep(800)
  await js(`document.activeElement && document.activeElement.blur()`)

  await combo('p', { ctrl: true })
  check('the default Ctrl+P opens the command palette', await palette())
  // The sidebar's bottom buttons were taken out: what they opened is found here
  const finds = async (query, title) => {
    await js(`(() => { const set = ${SET}; set(document.querySelector('.command-palette input'), ${JSON.stringify(query)}) })()`)
    return until(`document.querySelector('.command-palette')?.textContent.includes(${JSON.stringify(title)})`, 3000)
  }
  check('the palette finds the agent messages, local project, batch command and stats',
    await finds('메시지', '에이전트 메시지 열기') && await finds('로컬 작업', '로컬 작업 열기') && await finds('배치', '배치 명령 실행') && await finds('통계', '세션 통계'))
  check('the empty start screen offers only New Connection and local work is in the sidebar',
    await js(`document.querySelectorAll('.welcome-screen button').length === 1 &&
      document.querySelector('.welcome-screen button')?.textContent.trim() === '새 연결' &&
      !!document.querySelector('.sidebar .local-terms-btn[aria-label="새 로컬 터미널"]')`))
  await esc()
  check('Esc closes it', await until(`!document.querySelector('.command-palette')`, 3000))

  await js("document.querySelector('.welcome-screen button').click()")
  check('New Connection on the empty start screen opens the connection form',
    await until('!!document.querySelector(\'input[placeholder="192.168.1.1"]\')', 5000))
  await esc()
  // The form leaves after its closing animation; checked below, so wait for it to be gone
  check('Esc closes the connection form', await until('!document.querySelector(\'input[placeholder="192.168.1.1"]\')', 5000))

  check('the shortcuts tab lists the shortcuts in Korean', await openShortcuts(), String(await js(`[...document.querySelectorAll('.shortcut-description')].slice(0, 4).map(d => d.textContent).join(', ')`)))
  check('with the default keys', (await keysOf('명령 팔레트 열기')) === 'Ctrl+P', await keysOf('명령 팔레트 열기'))
  // Two rows since Ctrl+Alt+Shift was added beside Ctrl+Win+Alt; neither can be changed
  if (process.platform === 'win32') check('area capture shows the fixed Windows key combinations',
    await js(`(() => {
      const rows = [...document.querySelectorAll('.shortcut-item')].filter(r => r.querySelector('.shortcut-description')?.textContent === '영역 캡처')
      const keys = rows.map(r => [...r.querySelectorAll('.shortcut-key')].map(k => k.textContent).join('+')).sort().join(',')
      return keys === 'Ctrl+Alt+Shift,Ctrl+Win+Alt' && rows.every(r => !r.querySelector('.shortcut-change-btn'))
    })()`))

  // Start recording, press a combination another shortcut uses
  await js(`${row('명령 팔레트 열기')}.querySelector('.shortcut-change-btn').click()`)
  check('pressing the keys starts recording', await until(`!!document.querySelector('.shortcut-change-btn.is-recording')`, 3000))
  await combo('n', { ctrl: true })
  const conflict = await js(`document.querySelector('.shortcut-problem')?.textContent || ''`)
  check('a combination another shortcut uses is refused, saying which', conflict.includes('새 연결'), conflict)
  check('and that other shortcut did not run (no new-connection dialog)', await js(`!document.querySelector('input[placeholder="192.168.1.1"]')`))
  await combo('c', { ctrl: true })
  const reserved = await js(`document.querySelector('.shortcut-problem')?.textContent || ''`)
  check('a clipboard key is refused with the reason', reserved.includes('복사'), reserved)
  await combo('j', { ctrl: true })
  check('a free combination is saved', (await keysOf('명령 팔레트 열기')) === 'Ctrl+J' && !(await js(`!!document.querySelector('.shortcut-change-btn.is-recording')`)), await keysOf('명령 팔레트 열기'))
  check('the row is marked as changed, with the default shown', await js(`${row('명령 팔레트 열기')}.classList.contains('custom') && ${row('명령 팔레트 열기')}.textContent.includes('기본값 Ctrl+P')`))
  check('it is stored', (await js(`localStorage.getItem('customShortcuts')`)) === '{"command-palette":["Ctrl","J"]}', String(await js(`localStorage.getItem('customShortcuts')`)))

  // Esc cancels a recording without closing the settings
  await js(`${row('새 연결')}.querySelector('.shortcut-change-btn').click()`)
  await sleep(300)
  await esc()
  check('Esc cancels a recording and the settings stay open', !(await js(`!!document.querySelector('.shortcut-change-btn.is-recording')`)) && await js(`!!document.querySelector('.settings-tab-trigger')`))
  check('the cancelled shortcut is unchanged', (await keysOf('새 연결')) === 'Ctrl+N', await keysOf('새 연결'))

  // Close settings, use the new binding
  await esc()
  await until(`!document.querySelector('.settings-tab-trigger')`, 4000)
  await js(`document.activeElement && document.activeElement.blur()`)
  await combo('p', { ctrl: true })
  check('the old Ctrl+P no longer opens the palette', !(await palette()))
  await combo('j', { ctrl: true })
  check('the new Ctrl+J does', await palette())
  await esc()

  // Reset
  await openShortcuts()
  await js(`${row('명령 팔레트 열기')}.querySelector('.shortcut-reset-btn').click()`)
  await sleep(400)
  check('되돌리기 restores the default', (await keysOf('명령 팔레트 열기')) === 'Ctrl+P' && (await js(`localStorage.getItem('customShortcuts')`)) === '{}', `${await keysOf('명령 팔레트 열기')} ${await js(`localStorage.getItem('customShortcuts')`)}`)

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
