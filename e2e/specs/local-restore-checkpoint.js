// Kill an isolated app while it is open, then use the same profile in a fresh process.
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { connect, createChecks, openLocalAgent, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const profile = path.join(process.env.E2E_PROFILE, 'checkpoint')
const checkpoint = path.join(profile, 'restore-tabs.json')
const flags = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']

async function start() {
  const portProbe = net.createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  process.env.E2E_CDP = `http://127.0.0.1:${port}`
  return spawn(process.env.E2E_APP || require('electron'), [
    ...(process.env.E2E_APP ? [] : [path.resolve(__dirname, '../../out/main/index.js')]),
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...flags
  ], { stdio: 'ignore', windowsHide: true })
}

async function kill(app) {
  if (!app || app.exitCode !== null || app.signalCode !== null) return
  const exited = once(app, 'exit')
  app.kill('SIGKILL')
  await exited
}

async function waitForCheckpoint(previous = '') {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const raw = fs.readFileSync(checkpoint, 'utf8')
      if (raw !== previous && JSON.parse(raw).source === 'close') return raw
    } catch { /* the first checkpoint is still pending */ }
    await sleep(100)
  }
  throw new Error('The running app did not write its tab checkpoint')
}

;(async () => {
  fs.mkdirSync(profile)
  const one = path.join(profile, 'checkpoint first work')
  const two = path.join(profile, 'checkpoint second work')
  fs.mkdirSync(one)
  fs.mkdirSync(two)
  let app, driver
  try {
    app = await start()
    driver = await connect()
    await unlock(driver)
    await openLocalAgent(driver, undefined, one)
    const first = await waitForCheckpoint()
    await openLocalAgent(driver, undefined, two)
    const second = await waitForCheckpoint(first)
    check('the running app updates its encrypted checkpoint as tabs open', !second.includes(one) && !second.includes(two))

    driver.close()
    driver = null
    await kill(app)
    app = await start()
    driver = await connect()
    await unlock(driver)
    check('a fresh process offers both tabs after a forced stop', await driver.until(`
      document.querySelector('.restore-tabs-banner')?.textContent.includes('탭 2개를 다시 열까요')
    `))
    await driver.js(`[...document.querySelectorAll('.restore-tabs-btn')].find(button => button.textContent.includes('다시 열기')).click()`)
    check('the latest two work folders are opened again', await driver.until(`
      window.electronAPI.localShellList().then(shells => shells.length === 2 &&
        ${JSON.stringify([one, two])}.every(folder => shells.some(shell => shell.cwd === folder)))
    `))
    const shellIds = await driver.js(`window.electronAPI.localShellList().then(shells => shells.map(shell => shell.id).sort())`)
    await waitForCheckpoint(second)
    await driver.send('Page.reload')
    await sleep(1500)
    await unlock(driver)
    // The tab strip may show one work group. Count the restored panes across all groups.
    const panes = `[...document.querySelectorAll('.local-terminal-pane[data-local-shell-id]')].map(pane => pane.dataset.localShellId).sort()`
    const banner = `document.querySelector('.restore-tabs-banner')`
    check('a renderer reload adopts the running shells without another restore offer', await driver.until(`
      JSON.stringify(${panes}) === ${JSON.stringify(JSON.stringify(shellIds))} && !${banner}
    `) && (await sleep(1000), !await driver.js(`!!${banner}`)),
    JSON.stringify(await driver.js(`({ panes: ${panes}, banner: ${banner}?.textContent })`)))
  } finally {
    driver?.close()
    await kill(app)
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
