// An update can leave the agent handoff and tab checkpoint on disk even if its session host goes away.
// Drive the restart and restore UI on a throwaway profile. The fixture stands in for Claude Code and
// EZSHELL_TEST_UPDATE_RESTART stands in for the installer. A real session host keeps the first shell.
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { connect, createChecks, openLocalAgent, pageProblems, sleep, unlock } = require('../support/driver')
const { createSessionHostClient, DEV_STATE_FILE } = require('../../src/sessionHost/client')

const { check, finish } = createChecks()
const profile = path.join(process.env.E2E_PROFILE, 'lost-update-host')
const work = path.join(profile, 'restored work')
const bin = path.join(profile, 'bin')
const claudeHome = path.join(profile, 'claude')
const sessionId = 'abcdef12-1111-4222-8333-444455556666'
const note = 'A message from the agent before the failed update'
const fixtureFile = (agentId, suffix) => path.join(profile, `${agentId}-${suffix}`)
const shellList = 'window.electronAPI.localShellList()'
const snapshot = 'window.electronAPI.agentMessagesSnapshot()'
const handoffFile = path.join(profile, 'agent-handoff.json')
const tabsFile = path.join(profile, 'restore-tabs.json')
const hostState = path.join(profile, DEV_STATE_FILE)

function seedClaude() {
  fs.mkdirSync(work, { recursive: true })
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_TEST_AGENT_SCRIPT%" claude %*\r\n')
  const transcripts = path.join(claudeHome, 'projects', 'restored-work')
  fs.mkdirSync(transcripts, { recursive: true })
  fs.writeFileSync(path.join(transcripts, `${sessionId}.jsonl`), JSON.stringify({
    type: 'user', cwd: work, timestamp: new Date().toISOString(), sessionId,
    message: { content: 'Conversation to resume after this installation' }
  }) + '\n')
  fs.writeFileSync(path.join(profile, 'status.json'), JSON.stringify({ session_id: sessionId, model: { display_name: 'Fixture Claude' } }))
}

async function start() {
  const portProbe = net.createServer().listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const { port } = portProbe.address()
  await new Promise(resolve => portProbe.close(resolve))
  process.env.E2E_CDP = `http://127.0.0.1:${port}`
  const exe = require('electron')
  const system = path.join(process.env.SystemRoot, 'System32')
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  return spawn(exe, [
    path.resolve(__dirname, '../../out/main/index.js'), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'
  ], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env,
    [pathKey]: [bin, path.join(system, 'WindowsPowerShell', 'v1.0'), system].join(path.delimiter),
    CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: path.join(profile, 'codex'),
    EZSHELL_TEST_UPDATE_RESTART: '1', EZSHELL_TEST_NO_SESSION_HOST: '0',
    EZSHELL_TEST_AGENT_PROFILE: profile, EZSHELL_TEST_AGENT_EXE: exe,
    EZSHELL_TEST_AGENT_SCRIPT: path.resolve(__dirname, '../support/localAgentFixture.js')
  } })
}

async function stopApp(app) {
  if (!app || app.exitCode !== null || app.signalCode !== null) return
  const exited = once(app, 'exit')
  app.kill('SIGKILL')
  await exited
}

// The old app has exited. Use the pipe saved in this spec's profile to end only its retained host
// and that host's own shells, as if the host disappeared before the next app could take them back.
async function stopRetainedHost() {
  const host = createSessionHostClient({ stateFolder: profile, stateName: DEV_STATE_FILE, runtime: () => null })
  if (!await host.start()) return []
  const kept = host.takeAdoptable()
  host.shutdown()
  return kept
}

async function waitForHostExit(pid) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await sleep(100)
  }
  throw new Error('The test session host did not exit')
}

;(async () => {
  if (process.platform !== 'win32' || process.env.E2E_APP) {
    console.log('SKIP  the test needs the Windows development session host')
    return finish()
  }
  seedClaude()
  let app, driver
  try {
    app = await start()
    driver = await connect()
    await unlock(driver)
    await driver.js(shellList) // The app waits for its session host before answering.
    const oldHostState = fs.readFileSync(hostState, 'utf8')
    const oldHost = JSON.parse(oldHostState)
    await driver.js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([work]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    await openLocalAgent(driver, 'claude', work)
    if (!await driver.until(`${snapshot}.then(state => state.agents.some(agent => agent.active && agent.mcpConnected))`, 30000)) {
      throw new Error('The original fixture agent did not connect')
    }
    const [oldAgent] = (await driver.js(snapshot)).agents
    fs.writeFileSync(fixtureFile(oldAgent.id, 'command'), `"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_AGENT_USAGE_SCRIPT%" < "${path.join(profile, 'status.json')}"`)
    if (!await driver.until(`window.electronAPI.agentUsageState().then(reports => reports.some(report => report.usage.sessionId === ${JSON.stringify(sessionId)}))`)) {
      throw new Error('The original fixture agent did not report its conversation')
    }
    fs.writeFileSync(fixtureFile(oldAgent.id, 'mcp-request'), JSON.stringify({ name: 'send_message', arguments: { to: 'user', text: note } }))
    if (!await driver.until(`${snapshot}.then(state => state.messages.some(message => message.text === ${JSON.stringify(note)}))`)) {
      throw new Error('The original fixture message was not received')
    }
    await driver.js('window.electronAPI.checkForUpdates()')
    if (!await driver.until(`!!document.querySelector('.update-install-btn')`)) throw new Error('No update restart button')
    const exited = once(app, 'exit')
    await driver.js(`document.querySelector('.update-install-btn').click()`)
    const [exitCode] = await Promise.race([exited, sleep(30000).then(() => [])])
    if (exitCode !== 0) throw new Error('The app did not exit normally for the simulated update')
    driver.close()
    driver = null
    check('the exiting app wrote the agent and tab handoff records', fs.existsSync(handoffFile) && fs.existsSync(tabsFile))
    const kept = await stopRetainedHost()
    check('the old host was keeping the original shell before it was lost', kept.some(shell => shell.id === oldAgent.shellId))
    await waitForHostExit(oldHost.pid)
    // The test-only shutdown cleans up the process tree. Put back the state a forced stop leaves behind.
    fs.writeFileSync(hostState, oldHostState)

    app = await start()
    driver = await connect()
    await unlock(driver)
    const shells = await driver.js(shellList)
    const newHost = JSON.parse(fs.readFileSync(hostState, 'utf8'))
    check('the new app has a fresh host with no adopted shells', oldHost.pipe !== newHost.pipe && shells.length === 0)
    if (!await driver.until(`!!document.querySelector('.restore-tabs-banner')`)) throw new Error('No restore notice after losing the host')
    await driver.js(`[...document.querySelectorAll('.restore-tabs-btn')].find(button => button.textContent.includes('다시 열기')).click()`)
    const newAgent = `(await ${snapshot}).agents.find(agent => agent.id !== ${JSON.stringify(oldAgent.id)} && agent.active && agent.mcpConnected)`
    if (!await driver.until(`(async () => Boolean(${newAgent}))()`, 30000)) throw new Error('The restored fixture agent did not connect')
    const restored = await driver.js(`(async () => ${newAgent})()`)
    const args = JSON.parse(fs.readFileSync(fixtureFile(restored.id, 'argv'), 'utf8'))
    const resume = args.indexOf('--resume')
    check('the restored tab resumes Claude in the shell that reuses the old ID',
      restored.shellId === oldAgent.shellId && resume >= 0 && args[resume + 1] === sessionId)
    const state = await driver.js(snapshot)
    const archived = state.agents.find(agent => agent.id === oldAgent.id)
    check('the previous agent is detached from the shell and its message is kept',
      archived?.active === false && archived.status === 'ended' && archived.shellId === '' && state.messages.some(message => message.text === note))
    const chipIds = `[...document.querySelectorAll('.local-agent-chip')].map(chip => chip.dataset.agentId)`
    check('the reopened tab displays just the new agent chip', await driver.until(`
      JSON.stringify(${chipIds}) === ${JSON.stringify(JSON.stringify([restored.id]))}
    `), JSON.stringify(await driver.js(chipIds)))
    const problems = await pageProblems(driver)
    check('the restored window has no console errors or CSP refusals', problems.length === 0, problems.join(' | '))
  } finally {
    driver?.close()
    await stopApp(app)
    if (fs.existsSync(hostState)) await stopRetainedHost()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
