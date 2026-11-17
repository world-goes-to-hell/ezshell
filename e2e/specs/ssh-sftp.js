// An SSH tab connects to the test server (host key asked once), and `SFTP 를 현재 폴더로` opens the
// SFTP panel at the terminal's folder, follows a `cd`, and lists the folder's files.
// Run by e2e/run.js, which starts e2e/support/sshd.js for specs named ssh-*.
const { sleep, createChecks, connect, unlock, connectSsh } = require('../support/driver')
const { check, finish } = createChecks()
;(async () => {
  const driver = await connect()
  const { js, until, click, center, type, enter, menuPick } = driver
  // The remote pane's path: the last path bar in the SFTP panel
  const remotePath = () => js(`(() => { const bars = [...document.querySelectorAll('.sftp-panel input, .sftp-panel [class*="path"]')].map(e => (e.value ?? e.textContent ?? '').trim()).filter(Boolean); return JSON.stringify(bars) })()`)
  const sync = async () => {
    const term = await center(`document.querySelector('.terminal-container:not(.split-terminal) .xterm-screen')`)
    // Waits for the submenu and its item, and tries once more (the item was looked for too early before: `no menu item`)
    await menuPick(term[0], term[1] - 60, '편의', 'SFTP 를 현재 폴더로')
    await sleep(1500)
  }

  await unlock(driver)
  check('SSH tab connected', await connectSsh(driver))
  await sleep(700)

  // 1. Panel closed: opens at the terminal's folder
  await sync()
  check('SFTP panel opens', await until(`!!document.querySelector('.sftp-panel')`, 5000))
  await sleep(1000)
  let paths = await remotePath()
  check('at /var (the folder in the prompt)', paths.includes('"/var"'), paths)

  // 2. Panel open: goes to the new folder
  const term = await center(`document.querySelector('.terminal-container:not(.split-terminal) .xterm-screen')`)
  await click(term[0], term[1] - 60); await sleep(300)
  await type('etc'); await enter(); await sleep(800)
  await sync()
  paths = await remotePath()
  check('follows to /etc', paths.includes('"/etc"'), paths)
  check('and lists the files of that folder', await until(`(document.querySelector('.sftp-panel')?.textContent || '').includes('hosts')`, 8000))

  // 3. Home (~) is asked from the server
  await click(term[0], term[1] - 60); await sleep(300)
  await type('home'); await enter(); await sleep(800)
  await sync()
  paths = await remotePath()
  check('~ becomes the login folder (/ on the test server)', paths.includes('"/"') && !paths.includes('"/etc"'), paths)
  finish()
})().catch((e) => { console.error(e); process.exit(1) })
