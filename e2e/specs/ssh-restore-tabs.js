// Tabs open before an update, opened again after it (docs/plan/2026-11-18-restore-tabs-after-update.md).
// An update cannot be installed here, so the record the update notice writes right before it is
// saved directly, and the window is loaded again (as after the restart): unlock -> the notice ->
// "다시 열기" -> the saved session's tab with its panes, folder and SFTP panel, and a local terminal.
// The quick connect is offered with its login filled in. The record is given only once.
// Run by e2e/run.js, which starts e2e/support/sshd.js for specs named ssh-*.
const { sleep, createChecks, connect, unlock, connectSsh, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, send, until, shot } = driver
  const port = Number(process.env.E2E_SSH_PORT)
  const PANES = `[...(${PANEL}?.querySelectorAll('.terminal-split-container > .terminal-container[data-pane]') || [])]`
  const tabTitles = () => js(`[...document.querySelectorAll('.terminal-tab')].map(t => t.textContent.trim())`)
  const banner = () => js(`document.querySelector('.restore-tabs-banner')?.textContent || ''`)

  await unlock(driver)
  // The test server's host key is trusted once, as it would have been before the update
  check('the test server is trusted once by connecting to it', await connectSsh(driver))

  // A saved session, as the sidebar keeps it
  const saved = await js(`window.electronAPI.saveSessions([{ id: 'e2e-restore', name: '복원 시험 서버', host: '127.0.0.1', port: ${port}, username: 'tester', authType: 'password', password: 'x', icon: 'server' }])`)
  check('a saved session is written', saved?.success === true, JSON.stringify(saved))

  // What the update notice writes down right before the update (lib/restoreTabs.ts)
  const record = {
    version: 1,
    tabs: [
      { kind: 'ssh', savedSessionId: 'e2e-restore', title: '복원 시험', splitTree: { kind: 'split', axis: 'row', ratio: 0.5, first: { kind: 'pane', pane: 'main' }, second: { kind: 'pane', pane: 'split-1' } }, paneSeq: 1, currentPath: '/var/log', sftpPath: '/var' },
      { kind: 'local', title: '로컬 복원' },
      { kind: 'quick', host: '127.0.0.1', port, username: 'quick-user' }
    ],
    active: 0
  }
  const written = await js(`window.electronAPI.restoreTabsSave(${JSON.stringify(record)})`)
  check('the record is saved (encrypted by the main process)', written?.success === true, JSON.stringify(written))

  // As after the restart: the window starts again, locked
  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('after unlocking, the notice offers to open the tabs again', await until(`(document.querySelector('.restore-tabs-banner')?.textContent || '').includes('탭 2개를 다시 열까요')`, 15000), await banner())
  check('the quick connect is offered separately', /quick-user@127\.0\.0\.1/.test(await banner()), await banner())
  check('nothing has connected yet', (await js(`document.querySelectorAll('.terminal-tab').length`)) === 0)
  await shot('ssh-restore-tabs-1-ask')

  await js(`[...document.querySelectorAll('.restore-tabs-btn')].find(b => b.textContent.includes('다시 열기')).click()`)
  check('the saved session\'s tab and the local terminal open', await until(`document.querySelectorAll('.terminal-tab').length === 2`, 30000), JSON.stringify(await tabTitles()))
  check('with the names they had', JSON.stringify(await tabTitles()).includes('복원 시험') && JSON.stringify(await tabTitles()).includes('로컬 복원'), JSON.stringify(await tabTitles()))
  await js(`[...document.querySelectorAll('.terminal-tab')].find(t => t.textContent.includes('복원 시험'))?.click()`)
  check('the SSH tab has its two panes again, each with a shell', await until(`${PANES}.length === 2 && ${PANES}.every(p => (p.querySelector('.xterm-rows')?.textContent || '').includes('fake shell'))`, 30000), String(await js(`${PANES}.length`)))
  check('the shell is taken back to its folder (cd typed once)', await until(`(${PANES}[0]?.querySelector('.xterm-rows')?.textContent || '').includes("cd -- '/var/log'")`, 10000), (await js(`${PANES}[0]?.querySelector('.xterm-rows')?.textContent || ''`)).slice(-200))
  check('the SFTP panel is open again, in the folder it showed', await until(`(() => { const panel = [...document.querySelectorAll('.sftp-panel')].find(p => p.offsetParent !== null); return !!panel && panel.textContent.includes('/var') && panel.textContent.includes('trace.log') })()`, 15000))
  check('the notice stays for the quick connect only', await until(`/저장하지 않은 연결/.test(document.querySelector('.restore-tabs-banner')?.textContent || '') && /다시 열었습니다/.test(document.querySelector('.restore-tabs-banner')?.textContent || '')`, 8000), await banner())
  await shot('ssh-restore-tabs-2-restored')

  await js(`document.querySelector('.restore-tabs-chip').click()`)
  check('the quick connect opens the connect dialog with its login filled in', await until(`[...document.querySelectorAll('.modal-content input')].some(i => i.value === 'quick-user') && [...document.querySelectorAll('.modal-content input')].some(i => i.value === '127.0.0.1')`, 5000))
  check('without a password', await js(`[...document.querySelectorAll('.modal-content input[type=password]')].every(i => i.value === '')`))
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

  // Given once: loading the window again offers nothing
  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  await sleep(2500)
  check('the record is given only once', !(await banner()), await banner())

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
