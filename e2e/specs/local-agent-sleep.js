// Idle agents put to sleep to save memory (src/agentIdle.js): a Claude typed into a shell is closed with
// /exit after its idle time, the pane shows it asleep, and it is resumed in the same shell under the same
// agent id from the pane or by a message for it. A minute of idle time lasts a second here
// (e2e/support/agentSleepApp.js).
const fs = require('fs')
const path = require('path')
const { connect, createChecks, sleep, unlock, openLocalAgent } = require('../support/driver')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE
const file = name => path.join(profile, name)
const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : ''
const SESSION = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'

async function waitFor(test, tries = 200) {
  for (let index = 0; index < tries; index++) {
    const value = await test()
    if (value) return value
    await sleep(100)
  }
  return null
}

async function inAgent(agent, command) {
  fs.writeFileSync(file(agent + '-command'), command)
  const raw = await waitFor(() => read(agent + '-result'))
  if (!raw) throw new Error('agent command did not finish')
  fs.unlinkSync(file(agent + '-result'))
  return JSON.parse(raw)
}

/** The fake Claude reports its session id the way Claude Code's status line does */
async function reportSession(agent, sessionId) {
  const input = file(agent + '-status.json')
  fs.writeFileSync(input, JSON.stringify({ session_id: sessionId, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } }))
  return inAgent(agent, `"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_AGENT_USAGE_SCRIPT%" < "${input}"`)
}

const resumedWith = () => {
  try { return JSON.parse(read('manual-claude-argv') || 'null') ?? [] } catch { return [] }
}

;(async () => {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  const { js, until, send, shot } = driver
  try {
    await unlock(driver)
    await send('Page.bringToFront')

    // A Claude ezShell launched (it writes to the sleeping one later) and a plain shell
    await openLocalAgent(driver, 'claude', profile)
    check('a Claude opens in a local tab', await until(`document.body.textContent.includes('fixture ready: claude-1')`, 30000))
    await js(`window.dispatchEvent(new CustomEvent('ezshell:open-local-terminal', { detail: ${JSON.stringify({ cwd: profile })} }))`)
    const PANE = `[...document.querySelectorAll('.local-terminal-tab')].filter(t => getComputedStyle(t).visibility !== 'hidden').flatMap(t => [...t.querySelectorAll(':scope > .local-terminal-pane')])[0]`
    check('a plain shell opens', await until(`/PS [A-Z]:/.test(${PANE}?.textContent ?? '')`, 60000))
    const shellId = await js(`${PANE}.dataset.localShellId`)
    await js(`window.electronAPI.localShellWrite(${JSON.stringify(shellId)}, 'claude --dangerously-skip-permissions\\r')`)
    const agentOfShell = `window.electronAPI.agentMessagesSnapshot().then(state => state.agents.filter(agent => agent.shellId === ${JSON.stringify(shellId)}).at(-1) ?? null)`
    check('a Claude typed into the shell binds to it', await until(`${agentOfShell}.then(agent => agent?.active && agent.kind === 'claude')`, 30000), read('manual-claude-mcp-error'))
    const agentId = (await js(agentOfShell)).id
    await reportSession('manual-claude', SESSION)

    // Asleep after its idle time (two "minutes")
    const cover = `${PANE}?.querySelector('.agent-sleep-cover')`
    await js(`window.electronAPI.agentIdleConfigure({ trimMinutes: 1, sleepMinutes: 2 })`)
    check('after its idle time the agent is closed with /exit and the pane shows it asleep', await until(`(${cover}?.textContent ?? '').includes('잠들어 있습니다')`, 20000) && read('manual-claude-exits') === 'x', read('manual-claude-exits'))
    check('it stays listed for messages, asleep, under the same id', await until(`${agentOfShell}.then(agent => agent?.id === ${JSON.stringify(agentId)} && agent.active && agent.status === 'sleeping')`, 3000), JSON.stringify(await js(agentOfShell)))
    await shot('local-agent-sleep-asleep')

    // Woken from the pane (sleeping turned off first: it would fall asleep again at once)
    await js(`window.electronAPI.agentIdleConfigure({ trimMinutes: 0, sleepMinutes: 0 })`)
    fs.rmSync(file('manual-claude-argv'), { force: true })
    await js(`${cover}.querySelector('.agent-sleep-wake').click()`)
    check('깨우기 resumes the same conversation in that shell, with the options it was started with', await waitFor(() => {
      const argv = resumedWith()
      return argv.includes('--resume') && argv.includes(SESSION) && argv.includes('--dangerously-skip-permissions')
    }), read('manual-claude-argv'))
    check('it is awake again under the same id, and the pane is uncovered', await until(`${agentOfShell}.then(agent => agent?.id === ${JSON.stringify(agentId)} && agent.status !== 'sleeping' && agent.mcpConnected) && !${cover}`, 30000), JSON.stringify(await js(agentOfShell)))

    // Asleep again, then a message from the other Claude wakes it and its inbox tells it of the message
    await js(`window.electronAPI.agentIdleConfigure({ trimMinutes: 0, sleepMinutes: 2 })`)
    check('it falls asleep again when idle', await until(`(${cover}?.textContent ?? '').includes('잠들어 있습니다')`, 20000) && read('manual-claude-exits') === 'xx')
    await js(`window.electronAPI.agentIdleConfigure({ trimMinutes: 0, sleepMinutes: 0 })`)
    fs.rmSync(file('manual-claude-argv'), { force: true })
    fs.writeFileSync(file('claude-1-mcp-request'), JSON.stringify({ name: 'send_message', arguments: { to: agentId, text: '깨어나면 로그 봐 줘' } }))
    const answer = await waitFor(() => read('claude-1-mcp-response'))
    check('the other agent can write to the sleeping one', Boolean(answer) && !JSON.parse(answer).isError && !JSON.parse(answer).error, answer)
    check('the message wakes it in its shell', await waitFor(() => resumedWith().includes(SESSION)), read('manual-claude-argv'))
    check('once awake its inbox announces the message', await waitFor(() => Number(read('manual-claude-wakes')) >= 1, 300), read('manual-claude-wakes'))
    check('and the pane is uncovered', await until(`!${cover}`, 10000))

    // Kept as a terminal: the sleeping agent ends
    await js(`window.electronAPI.agentIdleConfigure({ trimMinutes: 0, sleepMinutes: 2 })`)
    check('asleep once more', await until(`(${cover}?.textContent ?? '').includes('잠들어 있습니다')`, 20000))
    await js(`window.electronAPI.agentIdleConfigure({ trimMinutes: 0, sleepMinutes: 0 })`)
    await js(`${cover}.querySelector('.agent-sleep-terminal').click()`)
    check('터미널로 쓰기 uncovers the shell and ends that agent', await until(`!${cover}`, 5000) && await until(`${agentOfShell}.then(agent => !agent || !agent.active)`, 5000), JSON.stringify(await js(agentOfShell)))
  } finally {
    driver.close()
  }
})().then(finish).catch(error => {
  console.error(error)
  process.exitCode = 1
})
