// A tab merged into a pane of another tab of the same session (the opposite of moving a pane out to
// a tab): by dragging the tab onto a pane, into the empty place a moved-out pane left, and from the
// tab's menu. The shell stays as it is, on its own connection. A tab of another session is refused
// with a notice.
// Run by e2e/run.js, which starts e2e/support/sshd.js for specs named ssh-*.
const { sleep, createChecks, connect, unlock, connectSsh, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, move, click, center, openSubmenu, pick, shot, type, enter } = driver

  const PANES = `[...(${PANEL}?.querySelectorAll('.terminal-split-container > .terminal-container[data-pane]') || [])]`
  const ids = () => js(`${PANES}.map(el => el.dataset.pane)`)
  const rectOf = (pane) => js(`(() => { const el = ${PANES}.find(p => p.dataset.pane === ${JSON.stringify(pane)}); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })()`)
  const textOf = (pane) => js(`(() => { const el = ${PANES}.find(p => p.dataset.pane === ${JSON.stringify(pane)}); return el ? [...el.querySelectorAll('.xterm-rows > div')].map(r => r.textContent).join('\\n') : '' })()`)
  const tabCount = () => js(`document.querySelectorAll('.terminal-tab').length`)
  const TAB = (index) => `document.querySelectorAll('.terminal-tab')[${index}]`
  const orderedIds = () => js(`[...document.querySelectorAll('.terminal-tab')].map(tab => tab.dataset.tabId)`)
  const mark = async (pane, word) => {
    await js(`${PANES}.find(p => p.dataset.pane === ${JSON.stringify(pane)}).querySelector('.xterm-helper-textarea').focus()`)
    await type(word)
    await enter()
    const shown = await until(`(${PANES}.find(p => p.dataset.pane === ${JSON.stringify(pane)})?.querySelector('.xterm-rows')?.textContent || '').includes(${JSON.stringify(word)})`, 8000)
    await sleep(200)
    return shown
  }
  const toasts = () => js(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`)

  // CDP pointer input does not start an HTML5 drag: the events are sent directly
  const startTabDrag = (index) => js(`(() => {
    const tab = ${TAB(index)}
    if (!tab) return 'no tab'
    window.__dt = new DataTransfer()
    window.__dragged = tab
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
    return 'ok'
  })()`)
  /** Pointer over (x, y) while dragging: returns the marker's state */
  const dragOver = async (x, y, altKey = false) => {
    await js(`(() => {
      const target = document.elementFromPoint(${x}, ${y}) || document.body
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: ${x}, clientY: ${y}, altKey: ${altKey} })
      target.dispatchEvent(over)
      window.__overAccepted = over.defaultPrevented
    })()`)
    await sleep(300)
    return js(`(() => { const m = document.querySelector('.tab-merge-marker'); return m ? { blocked: m.classList.contains('is-blocked'), text: m.textContent, accepted: window.__overAccepted } : null })()`)
  }
  const drop = async (x, y, altKey = false) => {
    await js(`(() => {
      const target = document.elementFromPoint(${x}, ${y}) || document.body
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: ${x}, clientY: ${y}, altKey: ${altKey} }))
      window.__dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
    })()`)
    await sleep(400)
  }
  const middleOf = async (pane) => { const r = await rectOf(pane); return [r[0] + r[2] / 2, r[1] + r[3] / 2] }
  const tabPoint = (index, fraction) => js(`(() => { const r = ${TAB(index)}.getBoundingClientRect(); return [r.left + r.width * ${fraction}, r.top + r.height / 2] })()`)

  await unlock(driver)
  check('the first tab connects to the test server', await connectSsh(driver))
  check('it answers', await mark('main', 'TAB-ONE'))
  check('a second tab connects to the same server and account', await connectSsh(driver))
  check('two tabs', (await tabCount()) === 2, String(await tabCount()))
  check('the second tab answers', await mark('main', 'TAB-TWO'))

  const originalOrder = await orderedIds()
  await startTabDrag(1)
  await sleep(160)
  const beforeTab = await tabPoint(0, 0.2)
  check('a normal drag over a matching SSH tab shows an insertion marker instead of a merge',
    await dragOver(...beforeTab) === null && await js(`!!document.querySelector('.tab-order-marker')`))
  await drop(...beforeTab)
  check('dropping on the left of a tab moves it before that tab and preserves both shells',
    (await orderedIds()).join(',') === [...originalOrder].reverse().join(',') && (await ids()).length === 1)

  await startTabDrag(0)
  await sleep(160)
  const afterTab = await tabPoint(1, 0.8)
  await dragOver(...afterTab)
  await drop(...afterTab)
  check('dropping on the right moves the tab after the other tab', (await orderedIds()).join(',') === originalOrder.join(','))

  // ---- Drag the second tab onto the first tab's terminal ----
  await js(`${TAB(0)}.click()`); await sleep(800)
  check('the first tab is in front', /TAB-ONE/.test(await textOf('main')) && !/TAB-TWO/.test(await textOf('main')))
  check('the second tab can be dragged', (await startTabDrag(1)) === 'ok')
  let [x, y] = await middleOf('main')
  let marker = await dragOver(x, y)
  check('over the middle of the pane, the place to merge is marked', !!marker && !marker.blocked && marker.accepted === true && /칸으로 병합|에 병합/.test(marker.text), JSON.stringify(marker))
  const edge = await rectOf('main')
  const screenLeft = await js(`document.querySelector('.terminal-area').getBoundingClientRect().left`)
  const atEdge = await dragOver(screenLeft + 20, y)
  check('the edge of the terminal area still means "split the screen"', atEdge === null && await js(`!!document.querySelector('.drop-zone-left.active')`), JSON.stringify(atEdge))
  // Just inside that band, near the pane's left edge: the left half of the pane is marked
  const leftX = edge[0] + 100
  marker = await dragOver(leftX, y)
  const markerBox = await js(`(() => { const m = document.querySelector('.tab-merge-marker'); if (!m) return null; const r = m.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)] })()`)
  check('near the left edge of the pane its left half is marked', !!marker && !marker.blocked && /왼쪽에 병합/.test(marker.text) && !!markerBox && Math.abs(markerBox[0] - edge[0]) < 4 && Math.abs(markerBox[1] - edge[2] / 2) < 6, JSON.stringify([marker, markerBox, edge]))
  await shot('ssh-tab-merge-1-marker')
  await drop(leftX, y)
  check('the dragged tab is gone from the tab strip', await until(`document.querySelectorAll('.terminal-tab').length === 1`, 10000), String(await tabCount()))
  check('the first tab has two panes', await until(`${PANES}.length === 2`, 8000), JSON.stringify(await ids()))
  const merged = (await ids())[1]
  await sleep(1500)
  check('the new pane shows the merged tab\'s screen', /TAB-TWO/.test(await textOf(merged)) && !/TAB-ONE/.test(await textOf(merged)), (await textOf(merged)).slice(-160))
  check('the first pane is untouched', /TAB-ONE/.test(await textOf('main')) && !/TAB-TWO/.test(await textOf('main')))
  const a = await rectOf('main'), b = await rectOf(merged)
  check('side by side, the merged shell on the left where it was dropped', b[0] < a[0] && Math.abs(a[3] - b[3]) < 4, JSON.stringify([a, b]))
  check('the merged shell still answers (same shell, its own connection)', await mark(merged, 'MERGED-ALIVE'))
  check('and the first pane still answers', await mark('main', 'ONE-ALIVE'))
  check('nothing is marked as disconnected', await js(`!document.querySelector('.connection-lost') && !document.querySelector('.split-terminal-error')`))
  await shot('ssh-tab-merge-2-merged')

  // ---- Out to a tab again, then back into the empty place from the tab's menu ----
  const gr = await rectOf(merged)
  await move(gr[0] + gr[2] / 2, gr[1] + 60); await move(gr[0] + gr[2] / 2, gr[1] + 8); await sleep(300)
  const movedOut = await js(`(() => {
    const grip = document.querySelector('.pane-grip.is-shown')
    const strip = document.querySelector('.terminal-tabs')
    if (!grip || !strip) return 'no grip'
    const dt = new DataTransfer()
    grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    return new Promise(resolve => setTimeout(() => {
      strip.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      strip.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      grip.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
      resolve('ok')
    }, 300))
  })()`)
  check('the merged pane can be moved out to a tab again', movedOut === 'ok' && await until(`document.querySelectorAll('.terminal-tab').length === 2`, 10000), movedOut)
  await sleep(1500)
  check('the tab shows the same shell', /MERGED-ALIVE/.test(await textOf('main')), (await textOf('main')).slice(-120))
  check('and answers', await mark('main', 'OUT-AGAIN'))

  const tabCenter = await center(TAB(1))
  await click(tabCenter[0], tabCenter[1], 'right')
  await until(`!!document.querySelector('.tab-context-menu')`, 4000)
  const mergeItem = `[...document.querySelectorAll('.tab-context-menu .menu-item')].find(b => b.textContent.includes('칸으로 병합:'))`
  check('the tab\'s menu offers the other tab of the session', await js(`!!${mergeItem} && !${mergeItem}.classList.contains('is-dimmed')`), await js(`[...document.querySelectorAll('.tab-context-menu .menu-item')].map(b => b.textContent).join(' / ')`))
  await js(`${mergeItem}.click()`)
  check('merging from the menu removes the tab', await until(`document.querySelectorAll('.terminal-tab').length === 1`, 10000), String(await tabCount()))
  check('the empty place is filled (no new division)', await until(`${PANES}.length === 2 && !${PANEL}.querySelector('.pane-vacant')`, 8000), JSON.stringify(await ids()))
  const refilled = (await ids()).find(id => id !== 'main')
  await sleep(1500)
  check('with the same shell and its output', /OUT-AGAIN/.test(await textOf(refilled)), (await textOf(refilled)).slice(-160))
  check('which still answers', await mark(refilled, 'BACK-ALIVE'))
  const back = await rectOf(refilled)
  check('in the place the pane had', Math.abs(back[0] - b[0]) < 4 && Math.abs(back[2] - b[2]) < 4, JSON.stringify([b, back]))

  // ---- Alt-drop a tab on another tab in the tab strip ----
  check('a third tab connects to the same server', await connectSsh(driver))
  check('it answers', await mark('main', 'TAB-THREE'))
  await js(`${TAB(0)}.click()`); await sleep(800)
  check('the third tab can be dragged', (await startTabDrag(1)) === 'ok')
  // Through the terminal area and out of it again (that alone used to mean "pop out to a window")
  await js(`(() => { const area = document.querySelector('.terminal-area'); const t = ${TAB(0)}.getBoundingClientRect(); area.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: window.__dt, clientX: t.left + 10, clientY: t.top + 5 })) })()`)
  const onTab = await center(TAB(0))
  marker = await dragOver(onTab[0], onTab[1], true)
  check('holding Alt over the other tab marks it as the place to merge', !!marker && !marker.blocked && marker.accepted === true && /칸으로 병합/.test(marker.text), JSON.stringify(marker))
  await shot('ssh-tab-merge-4-on-tab')
  await drop(onTab[0], onTab[1], true)
  check('the dropped tab leaves the strip', await until(`document.querySelectorAll('.terminal-tab').length === 1`, 10000), String(await tabCount()))
  check('and becomes a third pane of the tab (not a window of its own)', await until(`${PANES}.length === 3`, 8000), JSON.stringify(await ids()))
  await sleep(1500)
  const fromStrip = (await ids()).find(id => id !== 'main' && id !== refilled)
  check('with its screen', !!fromStrip && /TAB-THREE/.test(await textOf(fromStrip)), fromStrip ? (await textOf(fromStrip)).slice(-120) : 'no pane')
  check('and its shell still answers', !!fromStrip && await mark(fromStrip, 'STRIP-ALIVE'))
  const fr = await rectOf(fromStrip)
  await openSubmenu(fr[0] + fr[2] / 2, fr[1] + fr[3] / 2, '분할'); await pick('이 칸 닫기')
  check('that pane closes again', await until(`${PANES}.length === 2`, 6000), JSON.stringify(await ids()))
  await sleep(600)

  // ---- A tab of another session is refused, with a notice ----
  const plus = await center(`document.querySelector('.new-tab-btn')`)
  await click(plus[0], plus[1])
  const localItem = `[...document.querySelectorAll('.new-tab-menu-item')].find(i => i.textContent.includes('로컬 터미널'))`
  await until(`!!${localItem}`, 4000)
  const localAt = await center(localItem)
  await click(localAt[0], localAt[1])
  check('a local terminal tab opens', await until(`document.querySelectorAll('.terminal-tab').length === 2`, 15000), String(await tabCount()))
  await sleep(1000)
  await js(`${TAB(0)}.click()`); await sleep(800)
  check('the local tab can be dragged', (await startTabDrag(1)) === 'ok')
  ;[x, y] = await middleOf('main')
  marker = await dragOver(x, y)
  check('over the SSH tab the marker says it cannot be merged', !!marker && marker.blocked && /다른 세션의 탭은 병합할 수 없습니다/.test(marker.text), JSON.stringify(marker))
  await shot('ssh-tab-merge-3-refused')
  await drop(x, y)
  check('dropping it shows the notice', await until(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('병합할 수 없습니다') && t.textContent.includes('다른 세션'))`, 5000), await toasts())
  check('and nothing changes', (await tabCount()) === 2 && (await ids()).length === 2, JSON.stringify([await tabCount(), await ids()]))

  // ---- Closing the merged pane, then the tab ----
  const r = await rectOf(refilled)
  await openSubmenu(r[0] + r[2] / 2, r[1] + r[3] / 2, '분할'); await pick('이 칸 닫기')
  check('the merged pane closes like any pane', await until(`${PANES}.length === 1`, 6000), JSON.stringify(await ids()))
  await sleep(800)
  check('the tab it was merged into is still connected', await mark('main', 'END-ALIVE') && await js(`!document.querySelector('.connection-lost')`))

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
