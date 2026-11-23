const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, openLocalAgent, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()

async function run() {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const profile = process.env.E2E_PROFILE
  const file = name => path.join(profile, name)
  const sessionId = 'c718ff33-8123-4022-9d6b-a5378ef4b2e0'
  const transcript = file(path.join('claude-home', 'projects', 'test', sessionId + '.jsonl'))
  const question = '채팅에서 보낸 첫 질문'
  const driver = await connect()
  const { js, until, send, center, click } = driver
  try {
    await unlock(driver)
    await send('Page.bringToFront')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await openLocalAgent(driver, undefined, profile)
    const pane = "document.querySelector('.local-terminal-pane[data-local-shell-id]')"
    const menuItem = "[...document.querySelectorAll('.terminal-menu-item')].find(item => item.textContent.startsWith('채팅으로 보기 ('))"
    const chat = `${pane}.querySelector('.agent-chat-cover')`
    if (!await until(`/PS [A-Z]:/.test(${pane}?.textContent ?? '')`)) throw new Error('PowerShell did not start')
    const shellId = await js(`${pane}.dataset.localShellId`)
    await click(...await center(pane), 'right')
    check('chat is disabled in a shell with no agent', await until(`${menuItem}?.hasAttribute('data-disabled')`))
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until(`!${menuItem}`)

    fs.writeFileSync(file('manual-claude-session'), sessionId)
    await js(`window.electronAPI.localShellWrite(${JSON.stringify(shellId)}, 'claude\\r')`)
    if (!await until(`${pane}.textContent.includes('fixture ready: manual-claude')`)) {
      throw new Error(`Manual Claude did not start: ${await js(`${pane}.querySelector('.xterm-rows')?.textContent`)}`)
    }
    const agent = `window.electronAPI.agentMessagesSnapshot().then(snapshot => snapshot.agents.find(agent =>
      agent.active && agent.shellId === ${JSON.stringify(shellId)} && agent.kind === 'claude'))`
    check('the manual Claude is associated with its own terminal without a message bridge', await until(`
      ${agent}.then(agent => agent?.mcpConnected === false)
    `) && !fs.existsSync(file('agent-message-connection')))
    await click(...await center(pane), 'right')
    check('chat becomes selectable before the first question or transcript', await until(`
      ${menuItem}?.getAttribute('aria-disabled') !== 'true' && !!${menuItem}
    `) && !fs.existsSync(transcript))
    await click(...await center(menuItem))

    const input = `${chat}?.querySelector('.agent-chat-input')`
    if (!await until(`!!${input}`)) throw new Error('The chat composer did not open')
    await click(...await center(input))
    await send('Input.insertText', { text: question })
    await click(...await center(`${chat}.querySelector('.agent-chat-send')`))
    const sent = file('manual-claude-chat-sent')
    for (let i = 0; i < 100 && !fs.existsSync(sent); i++) await sleep(100)
    check('the chat can send the first question to the running Claude', fs.existsSync(sent) && fs.readFileSync(sent, 'utf8') === '1'
      && fs.readFileSync(file('manual-claude-chat-text'), 'utf8') === question)

    const answer = '같은 터미널의 Claude 답변입니다'
    const entry = (type, uuid, content) => JSON.stringify({
      type, uuid, timestamp: new Date().toISOString(), message: { id: uuid, role: type, content }
    }) + '\n'
    fs.writeFileSync(transcript, entry('user', 'first', question) + entry('assistant', 'answer', [{ type: 'text', text: answer }]))
    check('the first answer comes from the exact running session without a status-line report', await until(`
      ${chat}?.querySelector('.agent-chat-md')?.textContent.includes(${JSON.stringify(answer)})
    `))

    fs.writeFileSync(file('manual-claude-exit-code'), '0')
    check('the Claude detaches when it exits and the PowerShell pane stays open', await until(`
      ${agent}.then(agent => !agent && !!${pane})
    `))
  } finally {
    driver.close()
  }
}

run().then(finish).catch(error => { console.error(error); process.exit(1) })
