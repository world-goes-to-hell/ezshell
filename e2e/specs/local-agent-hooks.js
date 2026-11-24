// Agent state from the CLI's own hooks (docs/plan/2026-11-24-agent-state-via-official-signals.md, T8).
// The fake Claude of e2e/support/localAgentApp.js runs the real hook reporter (src/agentHookReport.js) with
// the command ezShell put in its `--settings` file, fed with input shaped like Claude Code's
// (`<id>-hooks`, see e2e/support/localAgentFixture.js). Checks:
// - the hooks set working / idle, even against the title
// - a message that comes while the agent works is not pasted into its composer: the Stop hook blocks with
//   the inbox line, and the fake reads its inbox as Claude does with the reason
// - B1: a UserPromptSubmit reported after its own Stop (async hooks) does not reopen the turn
// - A1: the Stop right after the user's Esc is not blocked; the message goes in when the agent is idle
// - turning the setting off goes back to the screen at once (and the next launch gets no hooks)
const fs = require('fs')
const path = require('path')
const { connect, createChecks, sleep, unlock, openLocalAgent } = require('../support/driver')
const { PROMPT } = require('../../src/ipc/agentInboxPrompts.js')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE
const file = name => path.join(profile, name)
const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : ''
const count = name => Number(read(name)) || 0

async function waitFor(test, tries = 160) {
  for (let index = 0; index < tries; index++) {
    const value = await test()
    if (value) return value
    await sleep(75)
  }
  return null
}

async function mcp(agent, name, args = {}) {
  fs.writeFileSync(file(agent + '-mcp-request'), JSON.stringify({ name, arguments: args }))
  const raw = await waitFor(() => read(agent + '-mcp-response') || read(agent + '-mcp-error'))
  if (read(agent + '-mcp-error')) throw new Error(read(agent + '-mcp-error'))
  if (!raw) throw new Error('agent MCP fixture did not finish')
  fs.unlinkSync(file(agent + '-mcp-response'))
  const result = JSON.parse(raw)
  if (result.error || result.isError) throw new Error(result.error || result.content[0].text)
  return JSON.parse(result.content[0].text)
}

const hookLog = agent => read(agent + '-hook-log').split('\n').filter(Boolean).map(line => JSON.parse(line))

/** Fires hook events in the fake agent and waits for their reporters to finish */
async function hooks(agent, steps) {
  const before = hookLog(agent).length
  fs.writeFileSync(file(agent + '-hooks'), JSON.stringify(steps))
  const done = await waitFor(() => hookLog(agent).length >= before + steps.length)
  const entries = hookLog(agent).slice(before)
  if (!done) throw new Error('hook reporters did not finish: ' + JSON.stringify(entries))
  const failed = entries.find(entry => entry.error)
  if (failed) throw new Error(failed.error)
  return entries
}

async function run() {
  // The fixture app uses the development build to inject its test agents.
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  try {
    const { js, send, until } = driver
    await unlock(driver)
    await send('Page.bringToFront')
    const workspace = path.join(profile, 'hooks-workspace')
    fs.mkdirSync(workspace)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([workspace]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    const openAgent = async (kind, id) => {
      await openLocalAgent(driver, kind, workspace)
      if (!(await until(`document.querySelector('[aria-label="${id} 메시지함"]') && document.body.textContent.includes('fixture ready: ${id}')`, 30000))) {
        throw new Error(`${kind} fixture did not open`)
      }
      await waitFor(() => read(id + '-tools'))
    }
    await openAgent('claude', 'claude-1')
    await openAgent('codex', 'codex-2')
    const status = id => js(`document.querySelector('.local-agent-chip[data-agent-id="${id}"]')?.dataset.status`)
    const isStatus = (id, value, timeout = 3000) => until(`document.querySelector('.local-agent-chip[data-agent-id="${id}"]')?.dataset.status === ${JSON.stringify(value)}`, timeout)
    const title = text => fs.writeFileSync(file('claude-1-title'), text)
    /** Stays at the value for the whole time (not just once) */
    const holds = async (id, value, ms) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await status(id) !== value) return false
      return true
    }

    // (1) The hooks set the state
    const started = await hooks('claude-1', [{ event: 'SessionStart' }])
    check('the fake Claude finds ezShell’s fixed hook command in its --settings file', !started[0].skipped, JSON.stringify(started))
    check('a fresh session is idle', await isStatus('claude-1', 'idle'))
    title('✳ claude-1')
    await hooks('claude-1', [{ event: 'UserPromptSubmit', prompt: 'p1' }])
    // The title still says idle: only the hook can say working (the title correction waits 3s)
    check('UserPromptSubmit makes it working although its title shows idle', await isStatus('claude-1', 'working', 2000), await status('claude-1'))
    title('◐ claude-1')

    // (2) A message while it works waits for the Stop hook
    const wakes = count('claude-1-wakes')
    const busyWakes = count('claude-1-busy-wakes')
    const task = await mcp('codex-2', 'send_message', { to: 'claude-1', text: 'hook-task' })
    await sleep(1500)
    // The fake app counts a pasted wake line once its Enter comes (-wakes, -busy-wakes)
    check('the working agent gets nothing in its composer', count('claude-1-busy-wakes') === busyWakes && count('claude-1-wakes') === wakes)
    const waiting = (await mcp('codex-2', 'check_sent', { message_ids: [task.id] })).messages?.[0]
    check('until the turn ends the message stays unread', waiting?.status === 'unread', JSON.stringify(waiting))
    const [stop] = await hooks('claude-1', [{ event: 'Stop', prompt: 'p1' }])
    check('the Stop hook blocks with the inbox line', stop.block === PROMPT, JSON.stringify(stop))
    const blockRead = await waitFor(() => read('claude-1-block-read'))
    check('the agent reads the message as the block tells it', blockRead.includes('hook-task'))
    check('the blocked Stop keeps it working', await holds('claude-1', 'working', 800))
    const seen = (await mcp('codex-2', 'check_sent', { message_ids: [task.id] })).messages?.[0]
    check('the sender then sees it read', seen?.status === 'read', JSON.stringify(seen))
    await mcp('claude-1', 'acknowledge_message', { message_id: task.id })
    const [again] = await hooks('claude-1', [{ event: 'Stop', prompt: 'p1', active: true }])
    title('✳ claude-1')
    check('the next Stop of the turn is not blocked again and ends it', again.block === null && await isStatus('claude-1', 'idle'), JSON.stringify(again))
    await sleep(1500)
    check('nothing was pasted for that message at any point', count('claude-1-busy-wakes') === busyWakes && count('claude-1-wakes') === wakes)

    // (B1) The Stop reported before its own UserPromptSubmit
    const reversed = await hooks('claude-1', [
      { event: 'UserPromptSubmit', prompt: 'p2', delay: 700 },
      { event: 'Stop', prompt: 'p2', after: 200 }
    ])
    check('the reports did arrive Stop first', reversed[0].event === 'Stop' && reversed[1].event === 'UserPromptSubmit', JSON.stringify(reversed))
    check('a late UserPromptSubmit of a closed turn does not reopen it', await holds('claude-1', 'idle', 1500), await status('claude-1'))

    // (A1) The user's Esc: the Stop right after it is not blocked
    title('◐ claude-1')
    await hooks('claude-1', [{ event: 'UserPromptSubmit', prompt: 'p3' }])
    check('the next turn works', await isStatus('claude-1', 'working'))
    const stopped = await mcp('codex-2', 'send_message', { to: 'claude-1', text: 'after-esc' })
    await sleep(800)
    const shellId = await js(`(async () => (await window.electronAPI.agentMessagesSnapshot()).agents.find(agent => agent.id === 'claude-1').shellId)()`)
    await js(`window.electronAPI.localShellWrite(${JSON.stringify(shellId)}, '\\x1b')`)
    const [escStop] = await hooks('claude-1', [{ event: 'Stop', prompt: 'p3' }])
    check('the Stop right after Esc is not blocked', escStop.block === null, JSON.stringify(escStop))
    title('✳ claude-1')
    check('the message goes in once the agent is idle, as before', await waitFor(() => count('claude-1-wakes') === wakes + 1, 200))
    const inbox = await mcp('claude-1', 'read_inbox')
    check('it is the message sent while it worked', inbox.messages.some(message => message.id === stopped.id))
    await mcp('claude-1', 'acknowledge_message', { message_id: stopped.id })

    // The setting turned off: back to the screen at once. Checked by the state's source in the snapshot
    // (statusSource), not only by idle: the 3s title correction of a hook turn would make it idle too.
    const source = () => js(`(async () => (await window.electronAPI.agentMessagesSnapshot()).agents.find(agent => agent.id === 'claude-1')?.statusSource ?? null)()`)
    await hooks('claude-1', [{ event: 'UserPromptSubmit', prompt: 'p4' }])
    check('a hook turn works under an idle title', await isStatus('claude-1', 'working', 1500))
    check('the snapshot says the state came from the hooks', await source() === 'hook', String(await source()))
    const configured = await js(`(async () => {
      localStorage.setItem('agentHooks', JSON.stringify({ enabled: false }))
      window.dispatchEvent(new CustomEvent('ezshell:agent-hooks-changed', { detail: { prefs: { enabled: false } } }))
      return true
    })()`)
    // Well before the 3s title correction of a hook turn
    check('turning the setting off follows the screen at once (idle title)', configured && await isStatus('claude-1', 'idle', 1500), await status('claude-1'))
    check('the state comes from the screen right after', await waitFor(async () => await source() === 'screen', 20), String(await source()))
    const [skipped] = await hooks('claude-1', [{ event: 'PreToolUse', prompt: 'p4', tool: 'toolu_1' }])
    check('Claude is given no hooks once it is off', skipped.skipped === true, JSON.stringify(skipped))
    title('◐ claude-1')
    check('the title says working again', await isStatus('claude-1', 'working'))
    const busyBefore = count('claude-1-busy-wakes')
    await mcp('codex-2', 'send_message', { to: 'claude-1', text: 'screen-again' })
    check('a busy agent is told into its running task again (screen path)', await waitFor(() => count('claude-1-busy-wakes') === busyBefore + 1))
  } finally {
    driver.close()
  }
}

run().then(finish).catch(error => {
  console.error(error)
  process.exitCode = 1
})
