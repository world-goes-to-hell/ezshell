// What an SSH tab does when its shell goes away: a dropped connection reconnects by itself, a shell
// that ended on its own (exit, the server's auto-logout) does not and offers 재연결, and 종료 closes
// the tab. Run by e2e/run.js, which starts e2e/support/sshd.js for specs named ssh-*.
// The test shell knows two words for this: `drop` ends the connection, `exit` ends the shell with code 0.
const { sleep, createChecks, connect, unlock, connectSsh, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, type, enter, shot } = driver

  const text = () => js(`[...(${PANEL}?.querySelectorAll('.terminal-container[data-pane="main"] .xterm-rows > div') || [])].map(r => r.textContent).join('\\n')`)
  // Each new shell of the test server greets with this line
  const greetings = async () => ((await text()).match(/fake shell/g) || []).length
  const overlay = () => js(`(() => { const o = ${PANEL}?.querySelector('.connection-lost'); return o ? { title: o.querySelector('.connection-lost-title')?.textContent || '', detail: o.querySelector('.connection-lost-detail')?.textContent || '', buttons: [...o.querySelectorAll('.connection-lost-btn')].map(b => b.textContent.trim()) } : null })()`)
  const overlayButton = (label) => `[...(${PANEL}?.querySelectorAll('.connection-lost-btn') || [])].find(b => b.textContent.includes(${JSON.stringify(label)}))`
  const say = async (word) => {
    await js(`${PANEL}.querySelector('.terminal-container[data-pane="main"] .xterm-helper-textarea').focus()`)
    await type(word)
    await enter()
  }
  const tabCount = () => js(`document.querySelectorAll('.terminal-tab').length`)

  await unlock(driver)
  check('an SSH tab connects to the test server', await connectSsh(driver))
  await say('BEFORE-DROP')
  await until(`(${PANEL}?.textContent || '').includes('BEFORE-DROP')`, 5000)
  const first = await greetings()

  // ---- 1. The connection drops: the tab reconnects by itself ----
  await say('drop')
  const sawOverlay = await until(`!!${PANEL}?.querySelector('.connection-lost')`, 10000)
  const during = await overlay()
  // A fast reconnect can be over before the overlay is seen: then the new greeting is the evidence
  check('a dropped connection is noticed (연결 끊김) or already reconnected', sawOverlay ? during?.title === '연결 끊김' : (await greetings()) > first, JSON.stringify(during))
  check('the tab reconnects by itself', await until(`!${PANEL}?.querySelector('.connection-lost')`, 40000), JSON.stringify(await overlay()))
  check('with a new shell on the same tab', await (async () => { const start = Date.now(); while (Date.now() - start < 15000) { if ((await greetings()) > first) return true; await sleep(300) } return false })(), (await text()).trim().slice(-160))
  check('still one tab', (await tabCount()) === 1, String(await tabCount()))
  await sleep(800)
  await say('AFTER-RECONNECT')
  check('the new shell answers', await until(`(${PANEL}?.textContent || '').includes('AFTER-RECONNECT')`, 8000))
  await shot('ssh-reconnect-1-back')

  // ---- 2. The shell ends on its own: no automatic reconnect ----
  const beforeExit = await greetings()
  await say('exit')
  check('a shell that ended by itself shows the notice', await until(`!!${PANEL}?.querySelector('.connection-lost')`, 10000))
  await sleep(5000)
  const ended = await overlay()
  check('it is still shown 5 seconds later (the app did not reconnect by itself)', !!ended && (await greetings()) === beforeExit, JSON.stringify(ended))
  check('it is not an automatic reconnect in progress', !!ended && !/자동으로 다시 연결/.test(ended.detail), ended?.detail)
  check('it says the shell ended', !!ended && /셸|종료/.test(ended.detail), ended?.detail)
  check('with 재연결 and 종료', !!ended && ended.buttons.some(b => b.includes('재연결')) && ended.buttons.some(b => b.includes('종료')), JSON.stringify(ended?.buttons))
  await shot('ssh-reconnect-2-ended')

  // ---- 3. 재연결 opens a new shell on the same tab ----
  await js(`${overlayButton('재연결')}.click()`)
  check('재연결 brings the tab back', await until(`!${PANEL}?.querySelector('.connection-lost')`, 30000), JSON.stringify(await overlay()))
  check('with a new shell', await (async () => { const start = Date.now(); while (Date.now() - start < 15000) { if ((await greetings()) > beforeExit) return true; await sleep(300) } return false })(), (await text()).trim().slice(-160))
  await sleep(800)
  await say('AFTER-BUTTON')
  check('which answers', await until(`(${PANEL}?.textContent || '').includes('AFTER-BUTTON')`, 8000))

  // ---- 4. 종료 on the notice closes the tab ----
  await say('exit')
  await until(`!!${PANEL}?.querySelector('.connection-lost')`, 10000)
  await sleep(600)
  await js(`${overlayButton('종료')}?.click()`)
  check('종료 closes the tab', await until(`document.querySelectorAll('.terminal-tab').length === 0`, 8000), String(await tabCount()))
  check('and the start screen is back', await until(`!!document.querySelector('.welcome-screen')`, 5000))

  // ---- 5. Closing a connected tab, then connecting again ----
  check('a new tab connects after that', await connectSsh(driver))
  await js(`document.querySelector('.terminal-tab .tab-close')?.click()`)
  check('the tab close button closes a connected tab', await until(`document.querySelectorAll('.terminal-tab').length === 0`, 8000), String(await tabCount()))

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
