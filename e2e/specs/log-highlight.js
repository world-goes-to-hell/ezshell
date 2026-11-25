// Error and warning lines printed in a terminal are tinted, command lines and INFO lines are not,
// the tint follows the lines as output scrolls, and the menu turns it off and on.
// Run by e2e/run.js (fresh profile, no server needed).
const fs = require('fs'), path = require('path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { connect } = require('../support/driver')
let failures = 0
const check = (n, ok, d = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`) }
;(async () => {
  const { send, js } = await connect()
  const shot = async (name) => { await send('Page.bringToFront'); const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(5000).then(() => null)]); if (r?.result?.data) fs.writeFileSync(path.join(process.env.E2E_OUT, `loghl-${name}.png`), Buffer.from(r.result.data, 'base64')) }
  const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(200) } return false }
  let at = [600, 400]
  const rawMouse = async (type, x, y, button = 'none') => send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: button === 'none' ? 0 : 1 })
  const mouse = async (type, x, y, button = 'none') => {
    if (type === 'mouseMoved') { const [fx, fy] = at; for (let i = 1; i <= 10; i++) { await rawMouse('mouseMoved', fx + (x - fx) * i / 10, fy + (y - fy) * i / 10); await sleep(15) } at = [x, y]; return }
    return rawMouse(type, x, y, button)
  }
  const click = async (x, y, button = 'left') => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, button); await mouse('mouseReleased', x, y, button) }
  const center = (expr) => js(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  const item = (label) => `[...document.querySelectorAll('.terminal-menu-item')].find(i => i.textContent.trim() === ${JSON.stringify(label)})`
  const pick = async (label) => { const c = await center(item(label)); if (!c) throw new Error('no item ' + label); await click(c[0], c[1]); await sleep(350) }
  const hover = async (label) => { const c = await center(item(label)); if (!c) throw new Error('no item ' + label); await mouse('mouseMoved', c[0] - 3, c[1]); await sleep(60); await mouse('mouseMoved', c[0], c[1]); await sleep(450) }
  const SET = `(el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }`

  const PANES = `[...document.querySelectorAll('.local-terminal-tab')].filter(t => t.offsetParent !== null && getComputedStyle(t).visibility !== 'hidden').flatMap(t => [...t.querySelectorAll(':scope > .local-terminal-pane')])`
  const rects = () => js(`${PANES}.map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })`)
  const texts = () => js(`${PANES}.map(el => [...el.querySelectorAll('.xterm-rows > div')].map(r => r.textContent).join('\\n'))`)
  const typeIn = async (index, text) => {
    await js(`${PANES}[${index}].querySelector('.xterm-helper-textarea').focus()`)
    await send('Input.insertText', { text })
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    // PowerShell can take a while on a busy machine: wait for the echoed word instead of a fixed time
    // The last word is echoed by the command: wait until it shows once more than it was typed
    const word = text.replace(/^.*echo /, '')
    const typed = text.split(word).length - 1
    await until(`(${PANES}[${index}]?.textContent || '').split(${JSON.stringify(word)}).length - 1 > ${typed}`, 30000)
    await sleep(300)
  }
  let GROUP = '편의'
  const menuAt = async (index) => {
    const r = await rects()
    await click(r[index][0] + r[index][2] / 2, r[index][1] + r[index][3] / 2, 'right'); await until(`!!document.querySelector('.terminal-menu-item')`, 4000); await sleep(150)
    // The submenu opens from the pointer's path; on a busy machine the first try can miss
    for (let i = 0; i < 4; i++) {
      await hover(GROUP)
      if (await js(`document.querySelectorAll('.terminal-menu').length >= 2`)) break
      await mouse('mouseMoved', at[0] - 40, at[1] - 6)
    }
  }
  const subItems = () => js(`[...[...document.querySelectorAll('.terminal-menu')].pop().querySelectorAll('.terminal-menu-item')].map(i => i.textContent.trim() + (i.hasAttribute('data-disabled') ? '(x)' : '')).join(',')`)
  const ready = (count) => until(`${PANES}.length === ${count} && ${PANES}.every(el => /PS [A-Z]:/.test(el.textContent))`, 90000)
  const tabCount = () => js(`document.querySelectorAll('.terminal-tab').length`)

  await until(`document.querySelectorAll('input[type=password]').length > 0 || !!document.querySelector('.btn-quick-connect')`, 20000)
  if (await js(`document.querySelectorAll('input[type=password]').length > 0`)) await js(`(() => { const set = ${SET}; [...document.querySelectorAll('input[type=password]')].forEach(i => set(i, 'test-pass-1234')); document.querySelector('button[type=submit]').click() })()`)
  await until(`!!document.querySelector('.btn-quick-connect')`)
  await sleep(800)
  // The sidebar's button, as local-split does (looking for any button with 로컬 터미널 in its text hit another one first)
  await until(`!!document.querySelector('.local-terms-btn[aria-label="새 로컬 터미널"]')`)
  await js(`document.querySelector('.local-terms-btn[aria-label="새 로컬 터미널"]').click()`)
  check('a local terminal tab opens with a PowerShell prompt', await ready(1), String((await texts())[0] || '').slice(-80))


  const marks = () => js(`(() => { const pane = ${PANES}[0]; const rows = [...pane.querySelectorAll('.xterm-rows > div')]; const h = rows[0].getBoundingClientRect().height; const top0 = rows[0].getBoundingClientRect().top; return [...pane.querySelectorAll('.terminal-log-row')].map(d => { const r = d.getBoundingClientRect(); const i = Math.round((r.top - top0) / h); return (d.classList.contains('is-error') ? 'E' : d.classList.contains('is-warn') ? 'W' : '?') + '|' + (rows[i]?.textContent || '').trim().slice(0, 60) + '|' + Math.round(r.width) + 'x' + Math.round(r.height) + '/' + Math.round(h) }) })()`)
  await typeIn(0, "'10:00:01 INFO started','10:00:02 ERROR db-down','10:00:03 WARN slow-query','java.lang.NullPointerException: boom','    at com.example.Main.run(Main.java:12)','10:00:04 INFO sent ERROR report','LOGEND' | % { $_ }; echo LOGEND")
  await sleep(600)
  let m = await marks()
  console.log(m.join('\n'))
  const out = m.filter(x => !x.includes('PS '))
  check('the error line, the exception and its stack frame are marked as errors', ['ERROR db-down', 'NullPointerException', 'at com.example'].every(w => out.some(x => x.startsWith('E|') && x.includes(w))))
  check('the warning line is marked as a warning', out.some(x => x.startsWith('W|') && x.includes('WARN slow-query')))
  check('INFO lines are not marked (also the one that mentions ERROR)', !m.some(x => x.includes('INFO')))
  check('the typed command line is not marked', !m.some(x => x.includes('PS ')), m.filter(x => x.includes('PS ')).join(' ; '))
  check('exactly four rows are marked', m.length === 4, String(m.length))
  check('a mark is one row high and as wide as the terminal', m.every(x => { const [w, hh, h] = x.split('|')[2].split(/[x/]/).map(Number); return Math.abs(hh - h) <= 1 && w > 300 }))
  await shot('1-marked')

  // More output scrolls the marked lines: the marks move with them
  await typeIn(0, "1..6 | % { \"filler $_\" }; echo FILLEND")
  await sleep(500)
  m = await marks()
  check('after more output the same four lines are still the marked ones', m.length === 4 && m.some(x => x.includes('ERROR db-down')) && m.some(x => x.includes('WARN slow-query')), m.join(' ; '))

  await menuAt(0)
  await pick('오류·경고 줄 강조 끄기')
  await sleep(400)
  check('turning it off in the menu removes the marks', (await marks()).length === 0 && (await js(`localStorage.getItem('terminalLogHighlight')`)) === 'off')
  await menuAt(0)
  await pick('오류·경고 줄 강조 켜기')
  await sleep(400)
  check('turning it on brings them back', (await marks()).length === 4)

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
