// A local shell goes on while the app restarts to install an update (the session host, src/sessionHost/).
// The app quits the way it does for an update (EZSHELL_TEST_UPDATE_RESTART: no installer runs), starts
// again on the same profile, and must find the same shell still counting, in its tab, with no offer to
// open it again. Then the app is killed outright: the shells must end with it, as they always did.
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { connect, createChecks, openLocalAgent, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const profile = path.join(process.env.E2E_PROFILE, 'keep-through-update')
const flags = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']

async function start() {
  const portProbe = net.createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  process.env.E2E_CDP = `http://127.0.0.1:${port}`
  return spawn(require('electron'), [
    path.resolve(__dirname, '../../out/main/index.js'), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...flags
  ], { stdio: 'ignore', windowsHide: true, env: { ...process.env, EZSHELL_TEST_UPDATE_RESTART: '1' } })
}

async function kill(app) {
  if (!app || app.exitCode !== null || app.signalCode !== null) return
  const exited = once(app, 'exit')
  app.kill('SIGKILL')
  await exited
}

const backlog = id => `window.electronAPI.localShellAttach(${JSON.stringify(id)}).then(state => state?.backlog ?? '')`
const lastTick = text => Math.max(0, ...[...text.matchAll(/tick-(\d+)/g)].map(match => Number(match[1])))

;(async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP  the session host is Windows only')
    return finish()
  }
  fs.mkdirSync(profile)
  const work = path.join(profile, 'kept work')
  fs.mkdirSync(work)
  let app, driver
  try {
    app = await start()
    driver = await connect()
    await unlock(driver)
    await openLocalAgent(driver, undefined, work)
    check('a local shell opens', await driver.until(`window.electronAPI.localShellList().then(shells => shells.length === 1)`, 20000))
    const [shell] = await driver.js(`window.electronAPI.localShellList()`)
    await sleep(1500)
    await driver.js(`window.electronAPI.localShellWrite(${JSON.stringify(shell.id)}, '"pid-" + $PID; $n = 0; while ($true) { $n++; "tick-$n"; Start-Sleep -Milliseconds 300 }\\r')`)
    check('the shell counts', await driver.until(`${backlog(shell.id)}.then(text => /tick-3\\b/.test(text))`, 15000))
    const before = await driver.js(backlog(shell.id))
    const pid = /pid-(\d+)/.exec(before)?.[1]
    check('the shell printed its process id', Boolean(pid), before.slice(-300))

    // The update path: the layout for the next window, then the install request (a plain quit here)
    await driver.js(`window.electronAPI.localShellKeepLayout([{ tabId: ${JSON.stringify(shell.id)}, mainShellId: ${JSON.stringify(shell.id)}, shell: 'PowerShell', panes: {} }])`)
    const exited = once(app, 'exit')
    driver.js(`window.electronAPI.installUpdate()`).catch(() => {})
    await Promise.race([exited, sleep(20000)])
    check('the app quits for the update', app.exitCode !== null || app.signalCode !== null)
    driver.close()
    driver = null
    const quitTick = lastTick(before)
    await sleep(3000)

    app = await start()
    driver = await connect()
    await unlock(driver)
    check('the same shell is there after the restart', await driver.until(`
      window.electronAPI.localShellList().then(shells => shells.length === 1 && shells[0].id === ${JSON.stringify(shell.id)} && !shells[0].exited)
    `, 20000), JSON.stringify(await driver.js(`window.electronAPI.localShellList()`)))
    const after = await driver.js(backlog(shell.id))
    check('it is the same process, with what it printed before', after.includes(`pid-${pid}`), after.slice(-200))
    check('it kept counting while the app was away', await driver.until(`${backlog(shell.id)}.then(text => ${JSON.stringify(quitTick)} + 8 < Math.max(0, ...[...text.matchAll(/tick-(\\d+)/g)].map(m => Number(m[1]))))`, 10000))
    check('it is back in its tab', await driver.until(`!!document.querySelector('.local-terminal-pane[data-local-shell-id="${shell.id}"]')`, 10000))
    check('the notice says the shells went on through the update', await driver.until(`document.body.textContent.includes('업데이트하는 동안 셸 1개가 끊기지 않고')`, 5000))
    await sleep(1500)
    check('the restore notice does not offer the tab again', !(await driver.js(`!!document.querySelector('.restore-tabs-banner')`)),
      await driver.js(`document.querySelector('.restore-tabs-banner')?.textContent ?? ''`))
    await driver.js(`window.electronAPI.localShellWrite(${JSON.stringify(shell.id)}, '\\x03')`)
    // Ctrl+C empties the console's input: type only once the prompt is back
    await driver.until(`${backlog(shell.id)}.then(text => /PS [^\\r\\n]*> $/.test(text))`, 10000)
    await sleep(500)
    await driver.js(`window.electronAPI.localShellWrite(${JSON.stringify(shell.id)}, '"typed-after-restart"\\r')`)
    check('it takes input again', await driver.until(`${backlog(shell.id)}.then(text => text.includes('typed-after-restart'))`, 10000),
      JSON.stringify({ shells: await driver.js(`window.electronAPI.localShellList()`), tail: (await driver.js(backlog(shell.id))).slice(-400) }))

    // Not an update: an app that ends any other way takes its shells with it
    driver.close()
    driver = null
    await kill(app)
    await sleep(2000)
    app = await start()
    driver = await connect()
    await unlock(driver)
    await sleep(2000)
    check('after an app that was killed, no shell is left', (await driver.js(`window.electronAPI.localShellList()`)).length === 0)
  } finally {
    driver?.close()
    await kill(app)
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
