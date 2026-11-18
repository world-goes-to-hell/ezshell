// The open-tab badge of a sidebar session: a split tab's list entry draws its layout, and picking a
// pane of that map goes to the tab with the keyboard in that pane's shell (as the local terminal
// list's "N세션" map does). A tab that is not split still goes straight to the tab on a click.
// Run by e2e/run.js with the test server.
const { sleep, createChecks, connect, unlock, SET, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, send, until, click, center, openSubmenu, pick, type, enter, shot } = driver

  const PANES = `[...(${PANEL}?.querySelectorAll('.terminal-split-container > .terminal-container[data-pane]') || [])]`
  const paneOf = (pane) => `${PANES}.find(p => p.dataset.pane === ${JSON.stringify(pane)})`
  const focusedPane = () => js(`document.activeElement?.closest('[data-pane]')?.dataset.pane ?? null`)
  const BADGE = `document.querySelector('.session-item .session-tab-badge--connected')`

  await unlock(driver)

  // A saved session (the badge counts only tabs opened from one): 연결 및 저장 on the test server
  await js(`document.querySelector('.btn-quick-connect').click()`)
  await until(`!!document.querySelector('input[placeholder="192.168.1.1"]')`)
  await js(`(() => {
    const set = ${SET}
    set(document.querySelector('input[placeholder="192.168.1.1"]'), '127.0.0.1')
    set(document.querySelector('.modal-content input[type=number]'), '${process.env.E2E_SSH_PORT}')
    set(document.querySelector('input[placeholder="root"]'), 'tester')
    set(document.querySelector('input[placeholder="••••••••"]'), 'x')
    ;[...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === '연결 및 저장').click()
  })()`)
  const trust = `[...document.querySelectorAll('button')].find(b => b.textContent.includes('신뢰하고 접속'))`
  await until(`!!${trust} || document.querySelectorAll('.terminal-tab').length > 0`, 15000)
  await send('Page.bringToFront')
  for (let i = 0; i < 8 && await js(`!!${trust}`); i++) {
    await sleep(1000)
    const at = await center(trust)
    if (at) await click(at[0], at[1])
  }
  check('a saved session opens a tab', await until(`(${PANEL}?.querySelector('.terminal-container .xterm-rows')?.textContent || '').includes('fake shell')`, 20000))
  check('its sidebar row shows the badge', await until(`!!${BADGE}`, 5000))

  // ---- One tab, not split: the badge goes straight to it ----
  await js(`${BADGE}.click()`)
  await sleep(300)
  check('a single tab that is not split opens no list', await js(`!document.querySelector('.session-tab-menu')`))

  // ---- Split it in two ----
  const main = await js(`(() => { const r = ${paneOf('main')}.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  await openSubmenu(main[0], main[1], '분할')
  await pick('좌우 분할')
  check('the tab is split into two shells', await until(`${PANES}.length === 2 && ${PANES}.every(el => (el.querySelector('.xterm-rows')?.textContent || '').includes('fake shell'))`, 30000))
  await js(`${paneOf('main')}.querySelector('.xterm-helper-textarea').focus()`)
  await sleep(200)
  check('the keyboard is in the first pane', (await focusedPane()) === 'main')

  // ---- The badge now lists the tab with its layout ----
  const badge = await center(BADGE)
  await click(badge[0], badge[1])
  check('the badge of a split tab opens the list', await until(`!!document.querySelector('.session-tab-menu')`, 4000))
  check('the entry says how many shells it holds', (await js(`document.querySelector('.session-tab-menu-panes')?.textContent || ''`)) === '2세션')
  check('and draws its layout, one cell a shell', (await js(`document.querySelectorAll('.session-tab-map .pane-map-cell:not(.is-vacant)').length`)) === 2)
  check('the shell that had the keyboard is marked', (await js(`document.querySelector('.session-tab-map .pane-map-cell.is-current')?.textContent || ''`)) === '1')
  const cells = await js(`[...document.querySelectorAll('.session-tab-map .pane-map-cell:not(.is-vacant)')].map(c => { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })`)
  check('the cells sit side by side, as the panes do', cells.length === 2 && cells[1][0] > cells[0][0] && cells[0][1] === cells[1][1], JSON.stringify(cells))
  await shot('ssh-tab-badge-panes-1-map')

  // ---- Picking the second cell goes to that shell ----
  await click(cells[1][0] + cells[1][2] / 2, cells[1][1] + cells[1][3] / 2)
  check('the list closes', await until(`!document.querySelector('.session-tab-menu')`, 3000))
  check('the keyboard goes to the second pane', await until(`document.activeElement?.closest('[data-pane]')?.dataset.pane === 'split-1'`, 3000), String(await focusedPane()))
  await type('picked')
  await enter()
  check('what is typed goes to that shell', await until(`(${paneOf('split-1')}?.querySelector('.xterm-rows')?.textContent || '').includes('picked') && !(${paneOf('main')}?.querySelector('.xterm-rows')?.textContent || '').includes('picked')`, 8000))

  // ---- The keyboard reaches the cells too ----
  await click(badge[0], badge[1])
  await until(`!!document.querySelector('.session-tab-menu')`, 4000)
  check('the list now marks the second shell', (await js(`document.querySelector('.session-tab-map .pane-map-cell.is-current')?.textContent || ''`)) === '2')
  const keyDown = async (key, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
    await sleep(150)
  }
  for (let i = 0; i < 4 && !(await js(`document.activeElement?.textContent === '1' && document.activeElement.classList.contains('pane-map-cell')`)); i++) {
    await keyDown('ArrowDown', 'ArrowDown', 40)
  }
  check('the arrow keys reach a cell', await js(`document.activeElement?.classList.contains('pane-map-cell') && document.activeElement.textContent === '1'`))
  await keyDown('Enter', 'Enter', 13)
  check('Enter on it goes to that shell', await until(`document.activeElement?.closest('[data-pane]')?.dataset.pane === 'main'`, 3000), String(await focusedPane()))
  await shot('ssh-tab-badge-panes-2-after')

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
