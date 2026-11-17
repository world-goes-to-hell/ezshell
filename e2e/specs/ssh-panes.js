// An SSH tab's panes: splitting (each pane is its own shell channel on the tab's connection), swapping
// two panes, moving a pane out to a tab of its own (the same channel, adopted by main), and closing the
// original tab while the moved one lives on the shared connection.
// Run by e2e/run.js, which starts e2e/support/sshd.js for specs named ssh-*.
const { sleep, createChecks, connect, unlock, connectSsh, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, move, openSubmenu, pick, shot, type, enter } = driver

  // Panes of the tab in front, in document order (main first, then split-N by id)
  const PANES = `[...(${PANEL}?.querySelectorAll('.terminal-split-container > .terminal-container[data-pane]') || [])]`
  const ids = () => js(`${PANES}.map(el => el.dataset.pane)`)
  const rectOf = (pane) => js(`(() => { const el = ${PANES}.find(p => p.dataset.pane === ${JSON.stringify(pane)}); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })()`)
  const textOf = (pane) => js(`(() => { const el = ${PANES}.find(p => p.dataset.pane === ${JSON.stringify(pane)}); return el ? [...el.querySelectorAll('.xterm-rows > div')].map(r => r.textContent).join('\\n') : '' })()`)
  const shells = (count) => until(`${PANES}.length === ${count} && ${PANES}.every(el => (el.querySelector('.xterm-rows')?.textContent || '').includes('fake shell'))`, 30000)
  const tabCount = () => js(`document.querySelectorAll('.terminal-tab').length`)
  // The test shell echoes what is typed: a word typed into a pane marks that pane's shell
  const mark = async (pane, word) => {
    await js(`${PANES}.find(p => p.dataset.pane === ${JSON.stringify(pane)}).querySelector('.xterm-helper-textarea').focus()`)
    await type(word)
    await enter()
    await until(`(${PANES}.find(p => p.dataset.pane === ${JSON.stringify(pane)})?.querySelector('.xterm-rows')?.textContent || '').includes(${JSON.stringify(word)})`, 8000)
    await sleep(200)
  }
  const splitMenu = async (pane) => {
    const r = await rectOf(pane)
    await openSubmenu(r[0] + r[2] / 2, r[1] + r[3] / 2, '분할')
  }
  /** Shows the grip of a pane (pointer into its top edge) and starts dragging it */
  const startDrag = async (pane) => {
    const r = await rectOf(pane)
    await move(r[0] + r[2] / 2, r[1] + 60)
    await move(r[0] + r[2] / 2, r[1] + 8)
    await sleep(300)
    // CDP pointer input does not start an HTML5 drag: the events are sent directly
    const started = await js(`(() => {
      const grip = document.querySelector('.pane-grip.is-shown')
      if (!grip) return 'no grip'
      window.__dt = new DataTransfer()
      window.__grip = grip
      grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
      return 'ok'
    })()`)
    await sleep(300)
    return started
  }
  const dropOn = (targetExpr) => js(`(() => {
    const target = ${targetExpr}
    if (!target) return 'no target'
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt })
    target.dispatchEvent(over)
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
    window.__grip.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
    return 'ok accepted=' + over.defaultPrevented
  })()`)

  await unlock(driver)
  check('an SSH tab connects to the test server', await connectSsh(driver))
  check('the tab starts with one pane (main)', JSON.stringify(await ids()) === '["main"]', JSON.stringify(await ids()))

  // ---- Split ----
  await splitMenu('main'); await pick('좌우 분할')
  check('좌우 분할 opens a second shell on the same connection', await shells(2), JSON.stringify(await ids()))
  const second = (await ids())[1]
  let a = await rectOf('main'), b = await rectOf(second)
  check('side by side, the new pane on the right', a[0] < b[0] && Math.abs(a[3] - b[3]) < 4, JSON.stringify([a, b]))
  await mark('main', 'PANE-ONE')
  await mark(second, 'PANE-TWO')
  check('each pane is its own shell', /PANE-ONE/.test(await textOf('main')) && !/PANE-TWO/.test(await textOf('main')) && /PANE-TWO/.test(await textOf(second)) && !/PANE-ONE/.test(await textOf(second)))

  await splitMenu(second); await pick('상하 분할')
  check('a split pane can be split again', await shells(3), JSON.stringify(await ids()))
  const third = (await ids())[2]
  await mark(third, 'PANE-THREE')
  b = await rectOf(second)
  const c = await rectOf(third)
  check('the third pane is under the second', Math.abs(b[0] - c[0]) < 4 && b[1] < c[1], JSON.stringify([b, c]))
  await shot('ssh-panes-1-three')

  // ---- Swap two panes ----
  const beforeSwap = { main: await rectOf('main'), third: await rectOf(third) }
  check('the grip of a pane can be dragged', (await startDrag(third)) === 'ok')
  // While dragging, every other pane is covered by a drop zone: the one over the main pane
  const zoneOverMain = `[...document.querySelectorAll('.pane-drop-zone')].find(z => { const r = z.getBoundingClientRect(); return Math.abs(r.left - ${beforeSwap.main[0]}) < 6 && Math.abs(r.top - ${beforeSwap.main[1]}) < 6 })`
  const swapped = await dropOn(zoneOverMain)
  check('it can be dropped on another pane', swapped === 'ok accepted=true', swapped)
  await sleep(600)
  const afterSwap = { main: await rectOf('main'), third: await rectOf(third) }
  check('the two panes trade places', JSON.stringify(afterSwap.main) === JSON.stringify(beforeSwap.third) && JSON.stringify(afterSwap.third) === JSON.stringify(beforeSwap.main), JSON.stringify({ beforeSwap, afterSwap }))
  check('and keep their shells and output', /PANE-ONE/.test(await textOf('main')) && /PANE-THREE/.test(await textOf(third)) && /PANE-TWO/.test(await textOf(second)))
  await mark(third, 'AFTER-SWAP')
  check('a swapped pane still answers', /AFTER-SWAP/.test(await textOf(third)))

  // ---- Close a pane ----
  await splitMenu(third); await pick('이 칸 닫기')
  check('이 칸 닫기 removes the pane', await until(`${PANES}.length === 2`, 5000), JSON.stringify(await ids()))
  await sleep(500)
  check('the others keep their output', /PANE-ONE/.test(await textOf('main')) && /PANE-TWO/.test(await textOf(second)))

  // ---- Move a pane out to a tab ----
  check('the grip of the second pane can be dragged', (await startDrag(second)) === 'ok')
  const dropped = await dropOn(`document.querySelector('.terminal-tabs')`)
  check('it can be dropped on the tab strip', dropped === 'ok accepted=true', dropped)
  check('a second tab appears', await until(`document.querySelectorAll('.terminal-tab').length === 2`, 10000), String(await tabCount()))
  await sleep(1500)
  check('the new tab shows that same shell (its earlier output is there)', /PANE-TWO/.test(await textOf('main')) && !/PANE-ONE/.test(await textOf('main')), (await textOf('main')).slice(-120))
  await mark('main', 'MOVED-ALIVE')
  check('and the shell still answers', /MOVED-ALIVE/.test(await textOf('main')))
  check('it is an ordinary SSH tab (it can be split)', await (async () => { await splitMenu('main'); await pick('좌우 분할'); return shells(2) })())
  await shot('ssh-panes-2-moved')

  await js(`document.querySelectorAll('.terminal-tab')[0].click()`); await sleep(800)
  check('the old tab keeps an empty place for the pane that left', await js(`[...document.querySelectorAll('.pane-vacant')].some(v => v.offsetParent !== null && getComputedStyle(v).visibility !== 'hidden')`))
  check('and its own shell is untouched', /PANE-ONE/.test(await textOf('main')))
  await mark('main', 'OLD-ALIVE')
  check('and still answers', /OLD-ALIVE/.test(await textOf('main')))

  // ---- Closing the original tab: the moved tab shares its connection and must survive ----
  await js(`document.querySelectorAll('.terminal-tab')[0].querySelector('.tab-close')?.click()`)
  check('the old tab closes', await until(`document.querySelectorAll('.terminal-tab').length === 1`, 8000), String(await tabCount()))
  await sleep(1500)
  check('the moved tab is not marked as disconnected', await js(`!document.querySelector('.connection-lost')`))
  await mark('main', 'AFTER-CLOSE')
  check('the moved tab still answers after the original tab closed', /AFTER-CLOSE/.test(await textOf('main')), (await textOf('main')).slice(-120))

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
