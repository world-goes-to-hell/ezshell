// A local terminal tab splits into panes of its own shells, a pane moves to a tab keeping its shell,
// and the vacated place merges back. Run by e2e/run.js (fresh profile, no server needed).
const fs = require('fs'), path = require('path')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { connect } = require('../support/driver')
let failures = 0
const check = (n, ok, d = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`) }
;(async () => {
  const { send, js } = await connect()
  const shot = async (name) => { await send('Page.bringToFront'); const r = await Promise.race([send('Page.captureScreenshot', { format: 'png' }), sleep(5000).then(() => null)]); if (r?.result?.data) fs.writeFileSync(path.join(process.env.E2E_OUT, `panelocal-${name}.png`), Buffer.from(r.result.data, 'base64')) }
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
    const word = text.replace(/^echo /, '')
    await until(`(${PANES}[${index}]?.textContent || '').split(${JSON.stringify(word)}).length > 2`, 30000)
    await sleep(300)
  }
  const menuAt = async (index) => {
    const r = await rects()
    await click(r[index][0] + r[index][2] / 2, r[index][1] + r[index][3] / 2, 'right'); await until(`!!document.querySelector('.terminal-menu-item')`, 4000); await sleep(150)
    // The submenu opens from the pointer's path; on a busy machine the first try can miss
    for (let i = 0; i < 4; i++) {
      await hover('분할')
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
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  const hidden = process.env.EZSHELL_TEST_HIDDEN_WINDOWS === '1'
  // A capture consumer lets Chromium produce frames for the 250 ms tab animation deadline
  // even when the window is outside the desktop and Windows stops giving it display frames.
  if (hidden) {
    const capture = await send('Page.startScreencast', { format: 'jpeg', quality: 35, maxWidth: 320, maxHeight: 240 })
    if (capture.error) throw new Error(capture.error.message)
  }
  await js(`(() => {
    const welcome = document.querySelector('.welcome-screen')
    const button = document.querySelector('.local-terms-btn[aria-label="새 로컬 터미널"]')
    const origin = button.getBoundingClientRect()
    const observer = new MutationObserver(() => {
      const chip = document.querySelector('.session-tab-flight')
      if (!chip) return
      window.__localTabFlight = {
        tabId: chip.dataset.destinationId,
        fromButton: chip.textContent === button.getAttribute('aria-label') &&
          Math.abs(chip.offsetLeft + 7 - origin.left) < 2 &&
          Math.abs(chip.offsetTop + chip.offsetHeight / 2 - origin.top - origin.height / 2) < 2,
        welcomeGone: !welcome.isConnected
      }
      observer.disconnect()
    })
    observer.observe(document.body, { childList: true })
    button.click()
  })()`)
  check('the sidebar button flies into the new local tab after the welcome screen leaves', await until(`
    window.__localTabFlight?.fromButton && window.__localTabFlight.welcomeGone &&
    window.__localTabFlight.tabId === document.querySelector('.terminal-tab.active')?.dataset.tabId &&
    !document.querySelector('.session-tab-flight, .session-tab-receiver')
  `, 5000), JSON.stringify(await js(`({ flight: window.__localTabFlight, hidden: document.hidden, visibility: document.visibilityState, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, focus: document.hasFocus() })`)))
  if (hidden) await send('Page.stopScreencast')
  check('a local terminal tab opens with a PowerShell prompt', await ready(1), String((await texts())[0] || '').slice(-80))

  await menuAt(0)
  check('the local terminal has the 분할 menu', (await subItems()) === '좌우 분할,상하 분할,칸 크기 균등화(x),이 칸 닫기(x)', await subItems())
  await pick('좌우 분할')
  check('좌우 분할 opens a second shell of this PC beside the first', await ready(2), JSON.stringify(await js(`${PANES}.map(el => el.className + ' | ' + el.textContent.slice(0, 80))`)))
  let r = await rects()
  check('side by side', r[0][0] < r[1][0] && Math.abs(r[0][3] - r[1][3]) < 4, JSON.stringify(r))
  const divider = "document.querySelector('.local-terminal-tab.is-split > .pane-divider-v')"
  const [dividerX, dividerY] = await center(divider)
  await mouse('mouseMoved', dividerX, dividerY)
  check('the 6px gap remains a resizable divider', await js(`(() => {
    const [left, right] = ${PANES}.map(pane => pane.getBoundingClientRect())
    const divider = ${divider}.getBoundingClientRect()
    return divider.width === 6 && Math.abs(divider.left - left.right) < 0.1 && Math.abs(divider.right - right.left) < 0.1 &&
      document.elementFromPoint(${dividerX}, ${dividerY}) === ${divider}
  })()`))
  const resize = (type, x, button, buttons, clickCount) => send('Input.dispatchMouseEvent', { type, x, y: dividerY, button, buttons, clickCount })
  await resize('mousePressed', dividerX, 'left', 1, 1)
  await resize('mouseMoved', dividerX + 55, 'none', 1, 0)
  await resize('mouseReleased', dividerX + 55, 'left', 0, 1)
  check('dragging the gap resizes the cards and keeps it 6px wide', await until(`(() => {
    const [left, right] = ${PANES}.map(pane => pane.getBoundingClientRect())
    return left.right > ${dividerX + 35} && Math.abs(right.left - left.right - 6) < 0.1
  })()`))
  const [movedX] = await center(divider)
  for (const count of [1, 2]) {
    await resize('mousePressed', movedX, 'left', 1, count)
    await resize('mouseReleased', movedX, 'left', 0, count)
  }
  check('double-clicking the gap makes both cards the same size again', await until(`Math.abs(${divider}.getBoundingClientRect().left + 3 - ${dividerX}) < 0.5`))
  await typeIn(0, 'echo PANE-ONE')
  await typeIn(1, 'echo PANE-TWO')
  let t = await texts()
  check('each pane is its own shell', /PANE-ONE/.test(t[0]) && !/PANE-TWO/.test(t[0]) && /PANE-TWO/.test(t[1]) && !/PANE-ONE/.test(t[1]), JSON.stringify(t.map(x => x.slice(-60))))

  // ---- The pane that takes the keyboard is outlined (the test window may sit behind others) ----
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const outlines = () => js(`${PANES}.map(el => { const s = getComputedStyle(el, '::before'); return s.content !== 'none' && s.borderTopWidth === '2px' })`)
  await js(`${PANES}[1].querySelector('.xterm-helper-textarea').focus()`); await sleep(100)
  check('only the pane with the keyboard is outlined', JSON.stringify(await outlines()) === '[false,true]', JSON.stringify(await outlines()))
  r = await rects()
  await click(r[0][0] + r[0][2] / 2, r[0][1] + r[0][3] / 2); await sleep(150)
  check('clicking the other pane moves the outline', JSON.stringify(await outlines()) === '[true,false]', JSON.stringify(await outlines()))
  await shot('0-focus-outline')

  await menuAt(1); await pick('상하 분할')
  check('a split pane can be split again', await ready(3))
  await typeIn(2, 'echo PANE-THREE')
  await shot('1-three')

  // ---- Close a pane ----
  await menuAt(2); await pick('이 칸 닫기')
  check('이 칸 닫기 removes the pane', await until(`${PANES}.length === 2`, 5000))
  await sleep(600)
  t = await texts()
  check('the others keep their shells and output', /PANE-ONE/.test(t[0]) && /PANE-TWO/.test(t[1]))

  // ---- Move the second pane out to a tab ----
  r = await rects()
  await mouse('mouseMoved', r[1][0] + r[1][2] / 2, r[1][1] + 40)
  await mouse('mouseMoved', r[1][0] + r[1][2] / 2, r[1][1] + 8)
  await sleep(250)
  check('the grip stays centered on the card edge', await js(`(() => {
    const grip = document.querySelector('.pane-grip.is-shown')?.getBoundingClientRect()
    const frame = ${PANES}[1].getBoundingClientRect()
    return grip && Math.abs(grip.left + grip.width / 2 - frame.left - frame.width / 2) < 0.1 && Math.abs(grip.top - frame.top - 2) < 0.1
  })()`))
  const dropped = await js(`(async () => {
    const grip = document.querySelector('.pane-grip.is-shown')
    if (!grip) return 'no grip'
    const dt = new DataTransfer()
    grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    // A hand takes a while to reach the strip: the drag shows its drop zones in the meantime
    await new Promise(resolve => setTimeout(resolve, 200))
    const strip = document.querySelector('.terminal-tabs')
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
    strip.dispatchEvent(over)
    strip.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    // As in the browser: dragend goes to the grip, which has left the page with its pane by then
    setTimeout(() => grip.dispatchEvent(new DragEvent('dragend', { bubbles: true })), 500)
    return 'ok accepted=' + over.defaultPrevented
  })()`)
  check('the pane can be dropped on the tab strip', dropped === 'ok accepted=true', dropped)
  check('a second local tab appears', await until(`document.querySelectorAll('.terminal-tab').length === 2`, 8000), String(await tabCount()))
  await sleep(1500)
  t = await texts()
  check('the new tab shows that same shell (its earlier output is there)', t.length === 1 && /PANE-TWO/.test(t[0]) && !/PANE-ONE/.test(t[0]), JSON.stringify(t.map(x => x.slice(-80))))
  await typeIn(0, 'echo STILL-ALIVE')
  check('and the shell still answers', /STILL-ALIVE/.test((await texts())[0]))
  await js(`document.querySelectorAll('.terminal-tab')[0].click()`); await sleep(800)
  check('the old tab keeps an empty place with merge buttons', await js(`[...document.querySelectorAll('.pane-vacant')].some(v => v.offsetParent !== null)`))
  check('the vacant card keeps the width of the removed pane and the same gap', await js(`(() => {
    const vacant = document.querySelector('.pane-vacant').getBoundingClientRect()
    const neighbor = ${PANES}[0].getBoundingClientRect()
    return Math.abs(vacant.left - neighbor.right - 6) < 0.1 && Math.abs(vacant.width - ${r[1][2]}) < 1
  })()`))
  // 2026-11-20 user report: the drop zones of that drag stayed over the panes and the shells could not be used
  check('no drop zone of the finished drag is left over the panes', await until(`!document.querySelector('.pane-drop-zone')`, 3000))
  await shot('2-vacant')

  // ---- The moved tab merges back into the empty place (from the tab's menu) ----
  const second = await center(`document.querySelectorAll('.terminal-tab')[1]`)
  await click(second[0], second[1], 'right')
  await until(`!!document.querySelector('.tab-context-menu')`, 4000)
  const mergeItem = `[...document.querySelectorAll('.tab-context-menu .menu-item')].find(b => b.textContent.includes('칸으로 병합:'))`
  check('the tab menu offers the other local terminal tab', await js(`!!${mergeItem} && !${mergeItem}.classList.contains('is-dimmed')`))
  await js(`${mergeItem}?.click()`)
  check('merging removes the tab', await until(`document.querySelectorAll('.terminal-tab').length === 1`, 8000), String(await tabCount()))
  check('and fills the empty place', await until(`![...document.querySelectorAll('.pane-vacant')].some(v => v.offsetParent !== null)`, 5000))
  await sleep(1500)
  t = await texts()
  const back = t.findIndex(x => /STILL-ALIVE/.test(x))
  check('the pane shows the same shell with its output', t.length === 2 && back >= 0 && /PANE-TWO/.test(t[back]), JSON.stringify(t.map(x => x.slice(-80))))
  await typeIn(back, 'echo MERGED-BACK')
  check('and the shell still answers', /MERGED-BACK/.test((await texts())[back]))
  await shot('3-merged-back')

  // Alt-drag from the second shell onto the main: keep the second process and close the first.
  const mainId = await js(`document.querySelector('.terminal-tab').dataset.tabId`)
  r = await rects()
  const [x, y] = [r[back][0] + r[back][2] / 2, r[back][1] + r[back][3] / 2]
  const [destinationX, destinationY] = [r[0][0] + r[0][2] / 2, r[0][1] + r[0][3] / 2]
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, modifiers: 1, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: destinationX, y: destinationY, modifiers: 1, button: 'none', buttons: 1 })
  check('Alt drag previews a merge between local shells', await until(`!!document.querySelector('.pane-merge-preview.is-area')`, 4000))
  check('the Alt merge preview fills both cards and the gap', await js(`(() => {
    const [first, second] = ${PANES}.map(pane => pane.getBoundingClientRect())
    const area = document.querySelector('.pane-merge-preview.is-area').getBoundingClientRect()
    return Math.abs(area.left - Math.min(first.left, second.left)) < 0.1 && Math.abs(area.right - Math.max(first.right, second.right)) < 0.1
  })()`))
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: destinationX, y: destinationY, modifiers: 1, button: 'left', buttons: 0, clickCount: 1 })
  check('the original tab promotes the source shell without opening a tab', await until(`document.querySelectorAll('.terminal-tab').length === 1 && ${PANES}.length === 1 && ${PANES}[0].textContent.includes('MERGED-BACK')`, 12000))
  check('the main process closed the original shell', await until(`window.electronAPI.localShellAttach(${JSON.stringify(mainId)}).then(state => state === null)`, 8000))
  await typeIn(0, 'echo LOCAL-PROMOTED')
  check('the promoted local shell still answers', /LOCAL-PROMOTED/.test((await texts())[0]))
  check('a tab of one pane draws no outline', JSON.stringify(await outlines()) === '[false]', JSON.stringify(await outlines()))

  // ---- 이 칸 닫기 on the tab's first terminal: the other shell becomes the main one ----
  await menuAt(0); await pick('좌우 분할')
  check('the tab splits again', await ready(2))
  await typeIn(1, 'echo NEW-SECOND')
  const oldMainShell = await js(`${PANES}[0].dataset.localShellId`)
  await menuAt(0)
  check('이 칸 닫기 is enabled on the first terminal of a split tab', (await subItems()).includes('이 칸 닫기') && !(await subItems()).includes('이 칸 닫기(x)'), await subItems())
  await pick('이 칸 닫기')
  check('closing the first terminal leaves the other shell as the only pane', await until(`${PANES}.length === 1 && ${PANES}[0].textContent.includes('NEW-SECOND')`, 12000), JSON.stringify((await texts()).map(x => x.slice(-80))))
  check('the shell of the first terminal is closed in the main process', await until(`window.electronAPI.localShellAttach(${JSON.stringify(oldMainShell)}).then(state => state === null)`, 8000))
  await typeIn(0, 'echo AFTER-MAIN-CLOSE')
  check('the remaining shell still answers in the same tab', (await tabCount()) === 1 && /AFTER-MAIN-CLOSE/.test((await texts())[0]))

  // ---- Alt+drag back and forth over a pane closes it (2026-11-24 user request) ----
  const moveStroke = ([x, y]) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: 1, button: 'none', buttons: 1 })
  // Three sweeps sideways in the middle of the pane, sampled every 10px as pointer moves would be
  const scribble = async (index) => {
    const box = (await rects())[index]
    const [cx, cy] = [box[0] + box[2] / 2, box[1] + box[3] / 2]
    const span = Math.min(60, box[2] / 3)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, modifiers: 1, button: 'left', buttons: 1, clickCount: 1 })
    const corners = [[cx + span, cy], [cx - span, cy + 8], [cx + span, cy + 16], [cx - span, cy + 24]]
    let [px, py] = [cx, cy]
    for (const [qx, qy] of corners) {
      for (let step = 1; step <= 12; step++) {
        await moveStroke([px + (qx - px) * step / 12, py + (qy - py) * step / 12])
      }
      ;[px, py] = [qx, qy]
    }
    return { start: [cx, cy], end: [px, py] }
  }
  const release = ([x, y]) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, modifiers: 1, button: 'left', buttons: 0, clickCount: 1 })
  const closingPreview = `!!document.querySelector('.pane-merge-preview.is-closing')`

  // The only pane of a tab: the scribble closes the tab (2026-11-27 user request)
  let stroke = await scribble(0)
  check('scribbling over the only pane previews closing the tab', await until(`${closingPreview}
    && document.querySelector('.pane-merge-preview.is-closing').textContent.includes('놓으면 이 탭을 닫습니다')`, 3000))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await release(stroke.end)
  await sleep(400)
  check('Esc keeps the tab and its pane', (await js(`${PANES}.length`)) === 1 && (await tabCount()) === 1)

  await menuAt(0); await pick('좌우 분할')
  check('the tab splits for the scribble', await ready(2))
  await typeIn(0, 'echo KEEP-LEFT')
  const scribbledShell = await js(`${PANES}[1].dataset.localShellId`)
  stroke = await scribble(1)
  check('a scribble over a pane previews closing it', await until(`${closingPreview} && document.querySelector('.pane-merge-preview.is-closing').textContent.includes('놓으면 이 칸을 닫습니다')`, 3000))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await release(stroke.end)
  await sleep(400)
  check('Esc cancels the scribble and both panes stay', !(await js(closingPreview)) && (await js(`${PANES}.length`)) === 2)

  stroke = await scribble(1)
  check('the close preview offers cancellation at the starting point', await until(`
    ${closingPreview} && document.querySelector('.pane-gesture-cancel-label')?.textContent === '시작점에서 취소'
  `, 3000))
  await moveStroke(stroke.start)
  check('returning to the starting point previews cancellation', await until(`
    !${closingPreview} && document.querySelector('.pane-gesture-cancel-label')?.textContent === '놓으면 취소'
  `, 3000))
  await moveStroke(stroke.end)
  check('crossing the starting point and continuing still allows closing', await until(closingPreview, 3000))
  await release(stroke.start)
  await until(`!document.querySelector('.pane-merge-trail.is-active')`, 3000)
  await sleep(400)
  check('releasing at the starting point cancels and keeps the same shell', await js(`
    ${PANES}.length === 2 && ${PANES}[1].dataset.localShellId === ${JSON.stringify(scribbledShell)}
  `))
  if ((await js(`${PANES}.length`)) !== 2) throw new Error('Returning to the starting point closed the pane')

  stroke = await scribble(1)
  check('scribbling again shows the close preview', await until(closingPreview, 3000))
  await release(stroke.end)
  check('letting go closes that pane and the other fills the tab', await until(`${PANES}.length === 1 && ${PANES}[0].textContent.includes('KEEP-LEFT')`, 8000), JSON.stringify((await texts()).map(x => x.slice(-80))))
  check('the scribbled shell is closed in the main process', await until(`window.electronAPI.localShellAttach(${JSON.stringify(scribbledShell)}).then(state => state === null)`, 8000))
  await shot('4-scribble-closed')
  const lastShell = await js(`${PANES}[0].dataset.localShellId`)
  stroke = await scribble(0)
  check('the remaining single pane previews closing the tab', await until(`${closingPreview}
    && document.querySelector('.pane-merge-preview.is-closing').textContent.includes('놓으면 이 탭을 닫습니다')`, 3000))
  await release(stroke.end)
  check('letting go over the only pane closes the tab as 탭 닫기 does', await until(`document.querySelectorAll('.terminal-tab').length === 0`, 8000), String(await tabCount()))
  check('and its shell is closed in the main process', await until(`window.electronAPI.localShellAttach(${JSON.stringify(lastShell)}).then(state => state === null)`, 8000))

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
