// A window reload drops every tab, but local shells live in main and keep running. The window takes
// them back as tabs (lib/localShellAdopt.ts) instead of leaving them, and any agent in them, unseen.
const { connect, createChecks, unlock, sleep } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, send } = driver
  const localTabs = `[...document.querySelectorAll('.terminal-tab')]`

  await unlock(driver)
  const opened = await js(`window.electronAPI.localShellOpen({ cols: 80, rows: 24 })`)
  check('main opens a local shell', opened?.success === true, JSON.stringify(opened))
  const before = await js(`window.electronAPI.localShellList()`)
  check('main lists the running shell', before.length === 1 && before[0].id === opened.id && before[0].exited === false, JSON.stringify(before))

  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('after the reload the shell comes back as a tab', await until(`${localTabs}.length === 1`, 10000), String(await js(`${localTabs}.length`)))
  check('the same shell, not a new one', JSON.stringify(await js(`window.electronAPI.localShellList().then(list => list.map(s => s.id))`)) === JSON.stringify([opened.id]))
  check('its terminal is drawn and takes input', await until(`!!document.querySelector('.xterm-helper-textarea')`, 10000))

  // Loading the window again with the tab open does not add a second tab for it
  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('one tab per shell after another reload', await until(`${localTabs}.length === 1`, 10000) && (await sleep(1000), (await js(`${localTabs}.length`)) === 1))

  finish()
})().catch(error => { console.error(error); process.exit(1) })
