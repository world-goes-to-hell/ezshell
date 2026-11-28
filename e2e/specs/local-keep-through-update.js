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
const bin = path.join(profile, 'bin')
const flags = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']

function seedCodex() {
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(profile, 'codex-hook-mode'), 'approved\n')
  fs.writeFileSync(path.join(bin, 'codex.cmd'), [
    '@echo off', 'if "%~1"=="--help" (echo   --no-daemon & exit /b 0)', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1',
    '"%EZSHELL_TEST_CODEX_EXE%" "%EZSHELL_TEST_CODEX_SCRIPT%" %*'
  ].join('\r\n') + '\r\n')
  fs.writeFileSync(path.join(bin, 'kept-codex.cjs'), String.raw`
    const { spawn } = require('node:child_process')
    const fs = require('node:fs')
    const path = require('node:path')
    const env = process.env
    const request = path.join(env.EZSHELL_TEST_CODEX_PROFILE, env.EZSHELL_AGENT_ID + '-next-state')
    process.stdin.resume()
    setInterval(() => {
      if (!fs.existsSync(request)) return
      const state = fs.readFileSync(request, 'utf8')
      fs.unlinkSync(request)
      if (state === 'screen-working') {
        process.stdout.write('\x1b]0;⠋ Working\x07')
        return
      }
      if (state === 'UserPromptSubmit') process.stdout.write('\x1b]7501;app=codex:state=idle\x07')
      if (!process.argv.some(arg => arg.startsWith('hooks.' + state + '='))) return
      const child = spawn(env.EZSHELL_CLI_EXE, [env.EZSHELL_AGENT_HOOK_SCRIPT, 'codex'], { env, windowsHide: true })
      child.stdin.end(JSON.stringify({
        hook_event_name: state, session_id: '0badc0de-1234-4234-8234-0123456789ab', turn_id: 'keep-working'
      }))
    }, 100)
  `)
}

async function start(env = {}) {
  const portProbe = net.createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  process.env.E2E_CDP = `http://127.0.0.1:${port}`
  const exe = require('electron')
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  return spawn(exe, [
    path.resolve(__dirname, '../../out/main/index.js'), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...flags
  ], { stdio: 'ignore', windowsHide: true, env: {
    ...process.env, [pathKey]: bin + path.delimiter + process.env[pathKey],
    CODEX_HOME: path.join(profile, 'codex'),
    EZSHELL_TEST_CODEX_EXE: exe, EZSHELL_TEST_CODEX_SCRIPT: path.join(bin, 'kept-codex.cjs'), EZSHELL_TEST_CODEX_PROFILE: profile,
    EZSHELL_TEST_UPDATE_RESTART: '1', ...env
  } })
}

async function kill(app) {
  if (!app || app.exitCode !== null || app.signalCode !== null) return
  const exited = once(app, 'exit')
  app.kill('SIGKILL')
  await exited
}

const backlog = id => `window.electronAPI.localShellAttach(${JSON.stringify(id)}).then(state => state?.backlog ?? '')`
const lastTick = text => Math.max(0, ...[...text.matchAll(/tick-(\d+)/g)].map(match => Number(match[1])))
const agents = `window.electronAPI.agentMessagesSnapshot().then(state => state.agents.filter(agent => agent.active && agent.kind === 'codex'))`
const agentStates = `${agents}.then(agents => agents.map(({ id, shellId, status, statusSource }) => ({ id, shellId, status, statusSource })))`
const status = (id, value, source) => `${agents}.then(agents => agents.some(agent => agent.id === '${id}' && agent.status === '${value}' && agent.statusSource === '${source}'))`
const report = (id, value) => fs.writeFileSync(path.join(profile, id + '-next-state'), value)

;(async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP  the session host is Windows only')
    return finish()
  }
  fs.mkdirSync(profile)
  seedCodex()
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

    await openLocalAgent(driver, 'codex', work)
    if (!await driver.until(`${agents}.then(agents => agents.length === 1)`)) throw new Error('Codex screen fixture did not open')
    const [screenAgent] = await driver.js(agents)
    await driver.js(`window.electronAPI.localShellWrite('${screenAgent.shellId}', 'question'); window.electronAPI.localShellWrite('${screenAgent.shellId}', '\\r')`)
    report(screenAgent.id, 'screen-working')
    check('the first Codex reports work by its screen', await driver.until(status(screenAgent.id, 'working', 'screen')))
    await openLocalAgent(driver, 'codex', work)
    if (!await driver.until(`${agents}.then(agents => agents.length === 2)`)) throw new Error('Codex hook fixture did not open')
    const hookAgent = (await driver.js(agents)).find(agent => agent.id !== screenAgent.id)
    report(hookAgent.id, 'UserPromptSubmit')
    check('the second Codex reports an active turn through its hook', await driver.until(status(hookAgent.id, 'working', 'hook')))

    // The update path as a user takes it: the notice's 재시작 (lib/updateInstall.ts writes the open tabs down
    // for the restore notice and gives the session host the layout), then the install request (a plain quit here)
    await driver.js(`window.electronAPI.checkForUpdates()`)
    check('the notice offers to restart for the update', await driver.until(`!!document.querySelector('.update-install-btn')`, 10000))
    const exited = once(app, 'exit')
    await driver.js(`document.querySelector('.update-install-btn').click()`)
    await Promise.race([exited, sleep(20000)])
    check('the app quits for the update', app.exitCode !== null || app.signalCode !== null)
    driver.close()
    driver = null
    const quitTick = lastTick(before)
    await sleep(3000)

    // The new app finds the session host only after the window is unlocked (a slow start): the window must
    // still take the shell back into its tab and not offer it again (2026-11-26 user report: tabs twice)
    app = await start({ EZSHELL_TEST_SESSION_HOST_DELAY_MS: '5000' })
    driver = await connect()
    await unlock(driver)
    check('the same shell is there after the restart', await driver.until(`
      window.electronAPI.localShellList().then(shells => shells.length === 3 && shells.some(shell => shell.id === ${JSON.stringify(shell.id)} && !shell.exited))
    `, 20000), JSON.stringify(await driver.js(`window.electronAPI.localShellList()`)))
    const after = await driver.js(backlog(shell.id))
    check('it is the same process, with what it printed before', after.includes(`pid-${pid}`), after.slice(-200))
    check('it kept counting while the app was away', await driver.until(`${backlog(shell.id)}.then(text => ${JSON.stringify(quitTick)} + 8 < Math.max(0, ...[...text.matchAll(/tick-(\\d+)/g)].map(m => Number(m[1]))))`, 10000))
    check('it is back in its tab', await driver.until(`!!document.querySelector('.local-terminal-pane[data-local-shell-id="${shell.id}"]')`, 10000))
    check('the notice says the shells went on through the update', await driver.until(`document.body.textContent.includes('업데이트하는 동안 셸 3개가 끊기지 않고')`, 5000))
    check('the kept Codex screen stays working without submitting another prompt', await driver.until(status(screenAgent.id, 'working', 'screen')))
    check('the kept Codex turn still uses the hook source', await driver.until(status(hookAgent.id, 'working', 'hook')), JSON.stringify(await driver.js(agentStates)))
    check('the kept Codex panes show the working effect', await driver.until(`
      ${JSON.stringify([screenAgent.shellId, hookAgent.shellId])}.every(id =>
        document.querySelector('.local-terminal-pane[data-local-shell-id="' + id + '"]')?.dataset.agentWork === 'working')
    `))
    report(hookAgent.id, 'Stop')
    check('the kept Codex hook reaches the new app and ends the saved turn', await driver.until(status(hookAgent.id, 'idle', 'hook')), JSON.stringify(await driver.js(agentStates)))
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
