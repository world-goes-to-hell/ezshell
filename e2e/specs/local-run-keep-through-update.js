// A run preset server goes on while the app restarts to install an update (docs/plan/2026-11-27-run-presets-survive-update.md).
// The app quits the way it does for an update (EZSHELL_TEST_UPDATE_RESTART: no installer runs), starts again on the
// same profile, and must find the same server process still serving, its card running, its log going on, and
// its stop working. A server whose preset was deleted meanwhile must not keep running unseen.
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { connect, createChecks, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const profile = path.join(process.env.E2E_PROFILE, 'run-keep-through-update')
const flags = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']

async function freePort() {
  const probe = net.createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

async function start() {
  const port = await freePort()
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

const answer = port => new Promise(resolve => {
  const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, response => {
    let body = ''
    response.on('data', chunk => { body += chunk })
    response.on('end', () => resolve(body))
  })
  request.on('error', () => resolve(null))
  request.on('timeout', () => { request.destroy(); resolve(null) })
})

const lastTick = text => Math.max(0, ...[...text.matchAll(/tick-(\d+)/g)].map(match => Number(match[1])))

async function restartForUpdate(driver, app) {
  await driver.js(`window.electronAPI.checkForUpdates()`)
  check('the notice offers to restart for the update', await driver.until(`!!document.querySelector('.update-install-btn')`, 10000))
  const exited = once(app, 'exit')
  await driver.js(`document.querySelector('.update-install-btn').click()`)
  await Promise.race([exited, sleep(20000)])
  check('the app quits for the update', app.exitCode !== null || app.signalCode !== null)
  driver.close()
}

;(async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP  the session host is Windows only')
    return finish()
  }
  fs.mkdirSync(profile)
  const work = path.join(profile, 'run work')
  fs.mkdirSync(work)
  const serverPort = await freePort()
  fs.writeFileSync(path.join(work, 'server.js'), `
    const http = require('node:http')
    let n = 0
    http.createServer((request, response) => response.end('pid-' + process.pid)).listen(${serverPort}, '127.0.0.1', () => {
      console.log('pid-' + process.pid + ' listening on http://127.0.0.1:${serverPort}')
      setInterval(() => console.log('tick-' + (++n)), 300)
    })
  `)
  const folder = JSON.stringify(work)
  let app, driver
  try {
    app = await start()
    driver = await connect()
    await unlock(driver)
    const saved = await driver.js(`window.electronAPI.runPresetsSave(${folder}, ${JSON.stringify({ name: '유지 서버', relative: '.', kind: 'custom', command: 'node server.js', notify: false })})`)
    const id = saved?.preset?.id
    if (!id) throw new Error(`Could not save the run preset: ${JSON.stringify(saved)}`)
    const args = `${folder}, ${JSON.stringify(id)}`
    const state = `window.electronAPI.runPresetsList(${folder}).then(list => list.states[${JSON.stringify(id)}])`
    const startRun = async () => {
      const question = await driver.js(`window.electronAPI.runPresetStart(${args})`)
      const started = question?.needsConfirm ? await driver.js(`window.electronAPI.runPresetStart(${args}, { confirmCustom: true })`) : question
      return started?.ok === true ? true : JSON.stringify({ question, started })
    }
    const first = await startRun()
    check('the run preset starts after its command is confirmed', first === true, String(first))
    check('the server answers', await driver.until(`${state}.then(item => item?.status === 'running' && !!item.shellId)`, 20000) &&
      Boolean(await answer(serverPort)))
    const { shellId } = await driver.js(state)
    const backlog = `window.electronAPI.localShellAttach(${JSON.stringify(shellId)}).then(item => item?.backlog ?? '')`
    check('its log counts', await driver.until(`${backlog}.then(text => /tick-3\\b/.test(text))`, 15000))
    const servedBefore = await answer(serverPort)
    const before = await driver.js(backlog)

    await restartForUpdate(driver, app)
    driver = null
    const quitTick = lastTick(before)
    const servedMeanwhile = await answer(serverPort)
    check('the server keeps serving while the app is away', servedMeanwhile === servedBefore, String(servedMeanwhile))
    await sleep(2500)

    app = await start()
    driver = await connect()
    await unlock(driver)
    check('the card shows the same run as running after the update', await driver.until(
      `${state}.then(item => item?.status === 'running' && item.shellId === ${JSON.stringify(shellId)})`, 20000),
      JSON.stringify(await driver.js(state)))
    check('it is the same server process', (await answer(serverPort)) === servedBefore)
    check('its log has what it printed before and goes on', await driver.until(
      `${backlog}.then(text => text.includes(${JSON.stringify(servedBefore)}) && ${quitTick} + 8 < Math.max(0, ...[...text.matchAll(/tick-(\\d+)/g)].map(m => Number(m[1]))))`, 10000))
    check('the restore notice does not offer it again', !(await driver.js(`!!document.querySelector('.restore-tabs-banner')`)))
    check('stop still works after the update', (await driver.js(`window.electronAPI.runPresetStop(${args})`)).ok === true &&
      await driver.until(`${state}.then(item => item?.status === 'stopped')`, 15000))
    let gone = false
    for (let attempt = 0; attempt < 20 && !gone; attempt++) { gone = (await answer(serverPort)) === null; if (!gone) await sleep(250) }
    check('the stopped server is gone', gone)

    // A preset deleted while its server ran: after the update nothing takes it back, so it must end
    const again = await startRun()
    check('the run starts again', again === true &&
      await driver.until(`${state}.then(item => item?.status === 'running')`, 20000), String(again) + ' ' + JSON.stringify(await driver.js(state)))
    await driver.until(`(async () => Boolean(await fetch('http://127.0.0.1:${serverPort}').then(() => true, () => false)))()`, 10000)
    const runsDuring = Boolean(await answer(serverPort))
    const presetsFile = path.join(profile, 'run-presets.json')
    const stored = fs.readFileSync(presetsFile, 'utf8')
    await restartForUpdate(driver, app)
    driver = null
    // The app is gone: take the preset out of the saved file, as if it had been deleted on another app
    const parsed = JSON.parse(stored)
    fs.writeFileSync(presetsFile, JSON.stringify({ ...parsed, projects: parsed.projects.map(project =>
      ({ ...project, presets: project.presets.filter(item => item.id !== id) })) }))
    app = await start()
    driver = await connect()
    await unlock(driver)
    let ended = false
    for (let attempt = 0; attempt < 40 && !ended; attempt++) { ended = (await answer(serverPort)) === null; if (!ended) await sleep(250) }
    check('a server whose preset is gone ends after the update', runsDuring && ended)
  } finally {
    driver?.close()
    await kill(app)
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
