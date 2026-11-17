// A split pane whose shell channel the server refuses at first (a connection at its channel limit):
// the pane retries by itself and ends up with a working shell, and the tab's own shell is not harmed.
// Run by e2e/run.js with the test server; its `refuse` word makes the next two channel requests fail.
const { sleep, createChecks, connect, unlock, connectSsh, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, openSubmenu, pick, type, enter, shot } = driver

  const PANES = `[...(${PANEL}?.querySelectorAll('.terminal-split-container > .terminal-container[data-pane]') || [])]`
  const textOf = (index) => js(`[...(${PANES}[${index}]?.querySelectorAll('.xterm-rows > div') || [])].map(r => r.textContent).join('\\n')`)
  const say = async (index, word) => {
    await js(`${PANES}[${index}].querySelector('.xterm-helper-textarea').focus()`)
    await type(word)
    await enter()
    await until(`(${PANES}[${index}]?.querySelector('.xterm-rows')?.textContent || '').includes(${JSON.stringify(word)})`, 8000)
    await sleep(200)
  }

  await unlock(driver)
  check('an SSH tab connects to the test server', await connectSsh(driver))
  await say(0, 'MAIN-BEFORE')

  // The server will reject the next two channels of this connection
  await say(0, 'refuse')
  const r = await js(`(() => { const b = ${PANES}[0].getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2] })()`)
  await openSubmenu(r[0], r[1], '분할')
  await pick('좌우 분할')
  check('the pane appears', await until(`${PANES}.length === 2`, 8000))
  const state = await js(`(${PANES}[1]?.textContent || '').slice(0, 120)`)
  console.log('  right after the split:', JSON.stringify(state))
  // Main retries once at once, the pane then waits and tries again (up to three times, backing off)
  check('the pane gets a shell after the refused tries', await until(`(${PANES}[1]?.querySelector('.xterm-rows')?.textContent || '').includes('fake shell')`, 40000), String(await js(`(${PANES}[1]?.textContent || '').slice(0, 160)`)))
  check('without an error left on the pane', await js(`!${PANES}[1]?.querySelector('.split-terminal-error')`))
  await say(1, 'SPLIT-ALIVE')
  check('and that shell answers', /SPLIT-ALIVE/.test(await textOf(1)))
  check('the tab itself was never marked as disconnected', await js(`!document.querySelector('.connection-lost')`))
  await say(0, 'MAIN-AFTER')
  check('the tab\'s own shell is untouched and answers', /MAIN-BEFORE/.test(await textOf(0)) && /MAIN-AFTER/.test(await textOf(0)), (await textOf(0)).trim().slice(-160))
  await shot('ssh-split-retry')

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
