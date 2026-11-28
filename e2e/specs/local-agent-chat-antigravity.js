const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, openLocalAgent, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const literal = JSON.stringify

async function waitForFile(test) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (test()) return true
    await sleep(100)
  }
  return false
}

async function run() {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP Antigravity screen fixture needs the Windows development build')
    return
  }
  const profile = process.env.E2E_PROFILE
  const file = (pane, name) => path.join(profile, `${pane}-agy-${name}`)
  const read = (pane, name) => fs.existsSync(file(pane, name)) ? fs.readFileSync(file(pane, name), 'utf8') : ''
  const idleReports = pane => (read(pane, 'reports').match(/"state":"idle","code":0/g) ?? []).length
  const action = (pane, name) => fs.writeFileSync(file(pane, 'action'), name)
  const outside = path.join(profile, 'outside-transcript.jsonl')
  fs.writeFileSync(outside, JSON.stringify({ step_index: 999, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Decoy transcript from reported path' }) + '\n')
  const driver = await connect()
  const { js, until, send, center, click } = driver
  const pane = id => `document.querySelector('[data-local-shell-id="${id}"]')`
  const chat = id => `${pane(id)}?.querySelector('.agent-chat-cover')`
  const rows = id => `(${pane(id)}?.querySelector('.xterm-rows')?.textContent ?? '')`
  const snapshot = id => `window.electronAPI.agentMessagesSnapshot().then(({agents}) => agents.find(agent => agent.active && agent.shellId === ${literal(id)} && agent.kind === 'antigravity'))`
  const sendText = (id, text) => js(`window.electronAPI.agentChatSend(${literal(id)}, ${literal(text)}, [])`)
  async function openTab(kind) {
    const oldIds = await js(`window.electronAPI.localShellList().then(shells => shells.map(shell => shell.id))`)
    await openLocalAgent(driver, kind, profile)
    const next = `window.electronAPI.localShellList().then(shells => shells.find(shell => !${literal(oldIds)}.includes(shell.id))?.id)`
    if (!await until(next)) throw new Error('Local terminal did not open')
    return js(next)
  }
  async function showChat(id) {
    const menu = `[...document.querySelectorAll('.terminal-menu-item')].find(item => item.textContent.startsWith('채팅 모드 ('))`
    await click(...await center(pane(id)), 'right')
    if (!await until(`!!${menu} && ${menu}.getAttribute('aria-disabled') !== 'true' && !${menu}.hasAttribute('data-disabled')`)) {
      throw new Error('Antigravity chat menu is unavailable')
    }
    await click(...await center(menu))
    if (!await until(`!!${chat(id)}`)) throw new Error('Antigravity chat did not open')
  }

  try {
    await unlock(driver)
    await send('Page.bringToFront')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const first = await openTab('antigravity')
    if (!await until(`${snapshot(first)}.then(agent => agent?.status === 'idle')`)) {
      throw new Error(`Managed agy did not bind. Terminal ${await js(rows(first))}. Status command ${read(1, 'reports')}`)
    }
    check('production helper runs through the Windows statusLine and preserves the existing command',
      await waitForFile(() => read(1, 'reports').includes('fixture-original-status')))
    check('a live Antigravity is visible before there is a transcript and has no message MCP',
      (await js(snapshot(first))).mcpConnected === false && !fs.existsSync(path.join(profile, 'agy-home', '.gemini', 'antigravity-cli', 'brain')))
    await showChat(first)
    check('the live chat shows the Antigravity provider', await until(`${chat(first)}?.textContent.includes('Antigravity')`))

    const input = `${chat(first)}?.querySelector('.agent-chat-input')`
    if (!await until(`!!${input}`)) throw new Error('The Antigravity composer did not open')
    const question = '첫 번째 Antigravity 질문입니다.'
    await click(...await center(input))
    await send('Input.insertText', { text: question })
    await click(...await center(`${chat(first)}?.querySelector('.agent-chat-send')`))
    const firstSent = await waitForFile(() => read(1, 'received') === literal(question) + '\n')
    check('the first text reaches the live CLI exactly once', firstSent, firstSent ? '' : read(1, 'keys'))
    check('the running turn is reported', await until(`${snapshot(first)}.then(agent => agent?.status === 'working')`))
    const workingKeys = read(1, 'keys')
    check('working Antigravity rejects a second prompt before any console write', (await sendText(first, 'hold')).ok === false && read(1, 'keys') === workingKeys)
    action(1, 'finish')
    check('the answer appears from the UUID transcript, ignoring the statusLine path', await until(`
      ${chat(first)}?.querySelector('.agent-chat-md')?.textContent.includes('Answer from Antigravity pane 1.') &&
      !${chat(first)}.textContent.includes('Decoy transcript')
    `))

    const previousIdleReports = idleReports(1)
    action(1, 'block')
    check('OSC question state keeps chat blocked even after the reporter sends idle',
      await waitForFile(() => idleReports(1) > previousIdleReports) && await until(`${snapshot(first)}.then(agent => agent?.status === 'blocked')`))
    const handoff = `${chat(first)}?.querySelector('.agent-chat-approval button, .agent-chat-banner button')`
    check('the confirmation offers a terminal handoff without choice buttons',
      await until(`!!${handoff} && !${chat(first)}.querySelector('.agent-chat-approval-option')`))
    const blockedKeys = read(1, 'keys')
    const blockedSend = await sendText(first, 'must never reach the prompt')
    const blockedReply = await js(`window.electronAPI.agentChatAnswer(${literal(first)}, '1', 'antigravity-terminal')`)
    check('chat send and approval IPC leave the blocked terminal untouched', !blockedSend.ok && !blockedReply.ok && read(1, 'keys') === blockedKeys)
    if (await until(`!!${handoff}`, 1500)) {
      await click(...await center(handoff))
      check('the handoff reveals the live question', await until(`${rows(first)}.includes('Choose how to proceed')`))
    }
    await js(`window.electronAPI.localShellWrite(${literal(first)}, '1')`)
    check('confirmation from the terminal clears the same live session',
      await waitForFile(() => read(1, 'confirmed') === '1') && await until(`${snapshot(first)}.then(agent => agent?.status === 'idle')`))

    const second = await openTab()
    if (!await until(`/PS [A-Z]:/.test(${rows(second)})`)) throw new Error('PowerShell did not start')
    await js(`window.electronAPI.localShellWrite(${literal(second)}, 'agy\\r')`)
    if (!await until(`${snapshot(second)}.then(agent => agent?.status === 'idle')`)) {
      throw new Error(`Manual agy did not bind. Terminal ${await js(rows(second))}. Status command ${read(2, 'reports')}`)
    }
    await showChat(second)
    check('the manually started agy in the same cwd does not inherit the other conversation',
      !(await js(`${chat(second)}.textContent.includes('Answer from Antigravity pane 1.')`)))
    action(2, 'draft')
    if (!await waitForFile(() => !fs.existsSync(file(2, 'action')))) throw new Error('Fixture did not show the draft')
    await sleep(350)
    const draftKeys = read(2, 'keys')
    check('the CLI draft is kept without writing paste or Enter', !(await sendText(second, 'do not replace the draft')).ok && read(2, 'keys') === draftKeys)
    action(2, 'clear')
    if (!await waitForFile(() => !fs.existsSync(file(2, 'action')))) throw new Error('Fixture did not clear the draft')
    await sleep(350)
    check('text goes to the manually started agy once its composer is empty',
      (await sendText(second, 'second pane')).ok && await waitForFile(() => read(2, 'received') === '"second pane"\n'))
    action(2, 'finish')
    check('the manual pane follows its own transcript', await until(`${chat(second)}?.textContent.includes('Answer from Antigravity pane 2.')`))

    action(2, 'exit')
    check('exit detaches Antigravity while PowerShell stays available', await until(`
      ${snapshot(second)}.then(agent => !agent && !!${pane(second)} && /PS [A-Z]:/.test(${rows(second)}))
    `))
    const afterExit = read(2, 'keys')
    check('the ended chat cannot send text into PowerShell', !(await sendText(second, 'never a shell command')).ok && read(2, 'keys') === afterExit)

    fs.writeFileSync(path.join(profile, 'agy-legacy'), '')
    const legacyShell = await openTab()
    if (!await until(`/PS [A-Z]:/.test(${rows(legacyShell)})`)) throw new Error('Legacy fixture PowerShell did not start')
    const write = command => js(`window.electronAPI.localShellWrite(${literal(legacyShell)}, ${literal(command + '\r')})`)
    await write("agy 'two words'")
    check('a manually typed legacy agy receives the original arguments without settings',
      await waitForFile(() => read(3, 'legacy-args') === 'two words\r\n'))
    await write('agy second')
    check('the shell reuses the legacy capability check on the next launch',
      await waitForFile(() => read(3, 'legacy-args') === 'two words\r\nsecond\r\n') && read(3, 'help') === 'probe\r\n')
    check('the manual terminal shows the legacy chat warning once',
      await until(`(${rows(legacyShell)}.match(/이 Antigravity CLI/g) ?? []).length === 1`))

    const managedLegacy = await openTab('antigravity')
    check('the app opens legacy agy without injecting settings into the managed launch',
      await waitForFile(() => read(4, 'legacy-args') === '\r\n') && await until(`${rows(managedLegacy)}.includes('Legacy Antigravity started')`))
  } finally {
    for (const slot of [1, 2]) {
      if (fs.existsSync(file(slot, 'ready')) && !fs.existsSync(file(slot, 'ended'))) action(slot, 'exit')
    }
    await sleep(300)
    driver.close()
  }
}

run().then(finish).catch(error => { console.error(error); process.exit(1) })
