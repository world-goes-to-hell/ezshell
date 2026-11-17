// Detached windows of an SSH tab: the terminal moved to its own window and merged back (the same
// shell, the screen carried over both ways), and the SFTP panel popped out to a window and returned.
// Run by e2e/run.js, which starts e2e/support/sshd.js for specs named ssh-*.
const { sleep, createChecks, connect, pages, findPage, unlock, connectSsh, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const main = await connect()
  const { js, until, type, enter, shot } = main

  const mainText = () => js(`[...(${PANEL}?.querySelectorAll('.terminal-container[data-pane="main"] .xterm-rows > div') || [])].map(r => r.textContent).join('\\n')`)
  const sayInMain = async (word) => {
    await main.send('Page.bringToFront')
    await js(`${PANEL}.querySelector('.terminal-container[data-pane="main"] .xterm-helper-textarea').focus()`)
    await type(word)
    await enter()
    await until(`(${PANEL}?.textContent || '').includes(${JSON.stringify(word)})`, 8000)
  }
  // The server side of an SFTP view. Its text runs cells together ("etc11-10 09:00"), so a word
  // boundary never matches: the rows are read one by one. The test server's root holds etc and var.
  const REMOTE_TEXT = (root) => `[...document.querySelectorAll('${root} .remote-pane .file-item')].map(r => r.textContent.trim().slice(0, 24)).join(' | ').slice(0, 300)`
  const REMOTE_LISTED = (root) => `(() => { const rows = [...document.querySelectorAll('${root} .remote-pane .file-item')].map(r => r.textContent.trim()); return rows.some(t => t.startsWith('etc')) && rows.some(t => t.startsWith('var')) })()`
  const tabCount = () => js(`document.querySelectorAll('.terminal-tab').length`)
  const windowCount = async () => (await pages()).length

  await unlock(main)
  check('an SSH tab connects to the test server', await connectSsh(main))
  await sayInMain('IN-MAIN-WINDOW')

  // ================= Terminal to its own window =================
  // A tab dragged out of the terminal area. CDP pointer input does not start an HTML5 drag, so the
  // events are sent directly; React needs a moment between them to keep its drag state.
  await js(`(() => {
    const tab = document.querySelector('.terminal-tab')
    window.__dt = new DataTransfer()
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
  })()`)
  await sleep(300)
  await js(`(() => {
    const area = document.querySelector('.terminal-area')
    const r = area.getBoundingClientRect()
    // Leaving the area by its bottom edge: outside its box
    area.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: r.left + r.width / 2, clientY: r.bottom + 200 }))
  })()`)
  await sleep(300)
  await js(`document.querySelector('.terminal-tab').dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))`)

  const terminalPage = await findPage((t) => t.url.includes('terminalMode'), 15000)
  check('dragging the tab out opens a terminal window', !!terminalPage, JSON.stringify((await pages()).map(p => p.url.split('?')[1] || 'main')))
  if (!terminalPage) return finish()
  check('the tab leaves the main window', await until(`document.querySelectorAll('.terminal-tab').length === 0`, 8000), String(await tabCount()))

  const term = await connect((t) => t.id === terminalPage.id)
  const windowText = () => term.js(`[...document.querySelectorAll('.terminal-window-container .xterm-rows > div')].map(r => r.textContent).join('\\n')`)
  check('the window shows a terminal', await term.until(`!!document.querySelector('.terminal-window-container .xterm-rows')`, 15000))
  check('with the screen the tab had', await term.until(`(document.querySelector('.terminal-window-container .xterm-rows')?.textContent || '').includes('IN-MAIN-WINDOW')`, 10000), (await windowText()).trim().slice(-120))
  await term.send('Page.bringToFront')
  await term.js(`document.querySelector('.terminal-window-container .xterm-helper-textarea').focus()`)
  await term.type('IN-OWN-WINDOW')
  await term.enter()
  check('it is the same shell and it answers in the window', await term.until(`(document.querySelector('.terminal-window-container .xterm-rows')?.textContent || '').includes('IN-OWN-WINDOW')`, 8000), (await windowText()).trim().slice(-120))
  check('no new login happened (one greeting of the test shell)', ((await windowText()).match(/fake shell/g) || []).length === 1, (await windowText()).trim().slice(0, 120))
  await term.shot('ssh-detach-1-window')

  // ---- Merge back ----
  await term.js(`document.querySelector('[aria-label="메인 창으로 병합"]').click()`)
  check('병합 closes the window', await (async () => { const start = Date.now(); while (Date.now() - start < 10000) { if (!(await pages()).some(p => p.url.includes('terminalMode'))) return true; await sleep(300) } return false })())
  term.close()
  check('and the tab is back in the main window', await until(`document.querySelectorAll('.terminal-tab').length === 1`, 10000), String(await tabCount()))
  check('with what was typed in the window on its screen', await until(`(${PANEL}?.textContent || '').includes('IN-OWN-WINDOW')`, 10000), (await mainText()).trim().slice(-160))
  check('and not marked as disconnected', await js(`!document.querySelector('.connection-lost')`))
  await sleep(800)
  await sayInMain('BACK-IN-MAIN')
  check('the shell answers in the main window again', /BACK-IN-MAIN/.test(await mainText()), (await mainText()).trim().slice(-160))
  check('still the same shell (one greeting)', ((await mainText()).match(/fake shell/g) || []).length === 1)

  // ================= SFTP panel to its own window =================
  await js(`[...${PANEL}.querySelectorAll('.terminal-header-btn')].find(b => (b.title || b.dataset.heldTitle || '').includes('SFTP')).click()`)
  check('the SFTP panel opens', await until(`!!document.querySelector('.sftp-panel')`, 10000))
  check('and lists the server folder', await until(REMOTE_LISTED('.sftp-panel'), 10000), String(await js(REMOTE_TEXT('.sftp-panel'))))
  await sleep(500)
  await js(`[...document.querySelectorAll('.sftp-panel .sftp-btn')].find(b => (b.title || b.dataset.heldTitle || '').includes('새 창으로 열기')).click()`)

  const sftpPage = await findPage((t) => t.url.includes('sftpMode'), 15000)
  check('새 창으로 열기 opens an SFTP window', !!sftpPage, JSON.stringify((await pages()).map(p => p.url.split('?')[1] || 'main')))
  if (!sftpPage) return finish()
  check('the docked panel hides while the window is open', await until(`!document.querySelector('.sftp-panel')`, 8000))
  const sftp = await connect((t) => t.id === sftpPage.id)
  check('the window lists the server folder', await sftp.until(REMOTE_LISTED('.sftp-window'), 15000), String(await sftp.js(REMOTE_TEXT('.sftp-window'))))
  await sftp.shot('ssh-detach-2-sftp-window')
  // The terminal in the main window is not disturbed by the window using the same connection
  await sayInMain('WHILE-SFTP-WINDOW')
  check('the shell keeps answering while the SFTP window is open', /WHILE-SFTP-WINDOW/.test(await mainText()))

  await sftp.js(`document.querySelector('[aria-label="메인 창으로 병합"]').click()`)
  check('병합 closes the SFTP window', await (async () => { const start = Date.now(); while (Date.now() - start < 10000) { if (!(await pages()).some(p => p.url.includes('sftpMode'))) return true; await sleep(300) } return false })())
  sftp.close()
  check('and the docked panel comes back', await until(`!!document.querySelector('.sftp-panel')`, 10000))
  check('with the folder listed again', await until(REMOTE_LISTED('.sftp-panel'), 10000), String(await js(REMOTE_TEXT('.sftp-panel'))))
  check('only the main window is left', (await windowCount()) === 1, String(await windowCount()))
  await shot('ssh-detach-3-back')

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
