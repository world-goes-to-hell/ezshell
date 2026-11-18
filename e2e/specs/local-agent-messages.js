const fs = require('fs')
const path = require('path')
const { connect, createChecks, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE
const file = name => path.join(profile, name)
const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : ''

async function waitFor(test) {
  for (let index = 0; index < 160; index++) {
    const value = await test()
    if (value) return value
    await sleep(75)
  }
  return null
}

async function cli(agent, action) {
  fs.writeFileSync(file(agent + '-command'), 'ezshell ' + action + ' --json')
  const raw = await waitFor(() => read(agent + '-result'))
  if (!raw) throw new Error('agent CLI fixture did not finish')
  fs.unlinkSync(file(agent + '-result'))
  const result = JSON.parse(raw)
  if (result.exit) throw new Error(result.stderr || result.stdout)
  return JSON.parse(result.stdout)
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

async function run() {
  // The fixture app uses the development build to inject its clipboard and test agents.
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  try {
    const { js, send, until } = driver
    await unlock(driver)
    await send('Page.bringToFront')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([profile]))})`)
    async function openAgent(kind, id) {
      await js(`document.querySelector('button[aria-label="로컬 작업"]').click()`)
      await until(`!!document.querySelector('#local-project-agent')`)
      await js(`(() => {
        const select = document.querySelector('#local-project-agent')
        select.value = ${JSON.stringify(kind)}
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      await js(`document.querySelector('.local-project-dialog button[type=submit]').click()`)
      if (!(await until(`document.querySelector('[aria-label="${id} 메시지함"]') && document.body.textContent.includes('fixture ready: ${id}')`))) {
        const details = await js(`(async () => ({
          snapshot: await window.electronAPI.agentMessagesSnapshot(),
          errors: [...document.querySelectorAll('[role=alert], .local-project-error, .toast')].map(el => el.textContent),
          panes: [...document.querySelectorAll('.local-terminal-pane .xterm-rows')].map(el => el.textContent.trim().slice(-800))
        }))()`)
        throw new Error(`${kind} fixture did not open (${JSON.stringify(details)})`)
      }
    }
    await openAgent('codex', 'codex-1')
    await openAgent('claude', 'claude-2')
    const row = id => `document.querySelector('.local-agent-chip[data-agent-id="${id}"]')`
    const owner = id => `${row(id)}?.closest('.local-terms-item')?.dataset.localSessionId`
    const paneTab = id => `document.querySelector('[aria-label="${id} 메시지함"]')?.closest('[data-local-tab-id]')?.dataset.localTabId`
    for (const agent of ['codex-1', 'claude-2']) {
      check(agent + ' has only icons directly underneath its own session information', await until(`
        ${owner(agent)} && ${owner(agent)} === ${paneTab(agent)} &&
        ${row(agent)}.parentElement.previousElementSibling?.matches('.local-terms-row') &&
        ${row(agent)}.textContent.trim() === '' && ${row(agent)}.querySelectorAll('svg').length === 2
      `))
      check(agent + ' shows the workspace name as its sidebar session title', await until(`
        ${row(agent)}?.closest('.local-terms-item')?.querySelector('.local-terms-name')?.textContent === ${JSON.stringify(path.basename(profile))}
      `))
    }
    const focusAgent = async id => {
      await js(`${row(id)}.click()`)
      return until(`!!document.activeElement?.closest('[data-local-shell-id]')?.querySelector('[aria-label="${id} 메시지함"]')`)
    }
    check('selecting Codex focuses its own pane', await focusAgent('codex-1'))
    check('selecting Claude focuses its own pane', await focusAgent('claude-2'))
    for (const agent of ['codex-1', 'claude-2']) {
      const tools = await waitFor(() => read(agent + '-tools') || read(agent + '-mcp-error'))
      check(agent + ' launches with inbox tools describing the active session', Boolean(tools?.includes('read_inbox') && tools?.includes('send_message')), tools)
      check(agent + ' reports the completed MCP handshake', await until(`window.electronAPI.agentMessagesSnapshot().then(state =>
        state.agents.some(agent => agent.id === ${JSON.stringify(agent)} && agent.mcpConnected))`))
    }
    const list = await cli('codex-1', 'agent list')
    check('the bundled CLI can see both agents with independent ids on the same folder', list.self === 'codex-1' && list.agents.length === 2 && list.agents.every(agent => agent.cwd === profile))

    await js(`window.deliveriesSeen = 0
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.matches('.agent-delivery-notice')) window.deliveriesSeen++
        }
      }).observe(document.querySelector('.agent-delivery-status'), { childList: true })`)
    const noticeAt = (target, route) => until(`(() => {
      const notice = document.querySelector('.agent-delivery-notice')
      const anchor = ${target}
      if (!notice || !anchor || notice.querySelector('strong').textContent !== ${JSON.stringify(route)}) return false
      const noteBox = notice.getBoundingClientRect()
      const anchorBox = anchor.getBoundingClientRect()
      return noteBox.left < anchorBox.right && noteBox.right > anchorBox.left &&
        Math.abs(noteBox.top - anchorBox.bottom - 8) < 2
    })()`)
    const request = await cli('codex-1', 'message send --to claude-2 --text review-please --request-id review-1')
    const claudeMail = 'document.querySelector(\'[aria-label="claude-2 메시지함"]\')'
    check('the arrival is shown beside the receiver with the sender and recipient', await noticeAt(claudeMail, 'codex-1 → claude-2'))
    check('the receiver has an unread mailbox and tab badge', await until(`
      ${claudeMail}?.dataset.unread === 'true' &&
      [...document.querySelectorAll('.terminal-tab')].some(tab => tab.textContent.includes('Claude') && tab.querySelector('.agent-tab-mail')?.textContent === '1')
    `))
    await driver.shot('local-agent-delivery')
    const duplicate = await cli('codex-1', 'message send --to claude-2 --text review-please --request-id review-1')
    check('retry returns the original id without showing another arrival', request.id === duplicate.id && await js('window.deliveriesSeen') === 1)
    const inbox = await cli('claude-2', 'message inbox --unread')
    check('Claude receives the exact request, including its sender', inbox.messages.length === 1 && inbox.messages[0].from === 'codex-1' && inbox.messages[0].text === 'review-please')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const reply = await cli('claude-2', `message reply --reply-to ${request.id} --text looks-good`)
    const codexBadge = `[...document.querySelectorAll('.terminal-tab')].find(tab => tab.dataset.tabId === ${paneTab('codex-1')})?.querySelector('.agent-tab-mail')`
    check('the reply appears alongside the inactive Codex tab with reduced motion enabled', await noticeAt(codexBadge, 'claude-2 → codex-1'))
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    const result = await cli('codex-1', 'message inbox --unread')
    check('Codex receives a reply linked to the original message', result.messages.some(message => message.id === reply.id && message.replyTo === request.id && message.text === 'looks-good'))
    await cli('codex-1', `message ack --id ${reply.id}`)
    check('reading the reply clears both unread badges', await until(`!document.querySelector('.agent-tab-mail')`))

    const waiting = cli('codex-1', 'message inbox --wait')
    check('an open CLI inbox wait is visible in the sidebar', await until(`${row('codex-1')}?.dataset.status === 'reply'`))
    const wake = await cli('claude-2', 'message send --to codex-1 --text follow-up')
    check('arriving mail completes the wait and clears the status', (await waiting).messages.some(message => message.id === wake.id) &&
      await until(`${row('codex-1')}?.dataset.status !== 'reply'`))
    await cli('codex-1', `message ack --id ${wake.id}`)

    const shellId = await js(`document.querySelector('[aria-label="claude-2 메시지함"]').closest('[data-local-shell-id]').dataset.localShellId`)
    const isWorking = () => js(`window.electronAPI.localShellHasWorkingAgent([${JSON.stringify(shellId)}])`)
    fs.writeFileSync(file('claude-2-title'), '⠋ Claude')
    check('a busy OSC title is reported from the running agent PTY', await waitFor(isWorking))
    check('working appears as an icon in the agent list', await until(`${row('claude-2')}?.dataset.status === 'working'`))
    fs.writeFileSync(file('claude-2-title'), '✳ Claude')
    check('the idle OSC title clears the busy state', await waitFor(async () => !(await isWorking())))
    check('an idle agent is distinguishable in the sidebar', await until(`${row('claude-2')}?.dataset.status === 'idle'`))

    await js(`document.querySelector('[aria-label="claude-2 메시지함"]').closest('.local-terminal-pane').querySelector('.xterm-helper-textarea').focus()`)
    const paste = async () => {
      const key = { code: 'KeyV', key: 'v', modifiers: 2, windowsVirtualKeyCode: 86 }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    }
    await paste()
    const inputFile = shellId.replace(':', '-') + '-input'
    const pastedPath = await waitFor(() => read(inputFile).match(/[A-Z]:\\[^\x1b\r\n]+\.png/i)?.[0])
    check('Ctrl+V sends a PNG path for an image clipboard', Boolean(pastedPath))
    check('the pasted path points to the decoded screenshot', Boolean(pastedPath && fs.readFileSync(pastedPath).subarray(0, 8).toString('hex') === '89504e470d0a1a0a'))
    check('the screenshot paste does not press Enter', !read(inputFile).includes('\r'))
    fs.writeFileSync(file('clipboard-text'), 'plain-text-paste')
    await paste()
    check('ordinary Ctrl+V still inserts exactly one text paste', await waitFor(() => read(inputFile).split('plain-text-paste').length === 2))
    await sleep(250)
    check('text paste was not duplicated by a native paste event', read(inputFile).split('plain-text-paste').length === 2)

    const panes = `[...document.querySelectorAll('.local-terminal-pane')].filter(el => getComputedStyle(el).visibility === 'visible')`
    const rects = () => js(`${panes}.map(el => {
      const bounds = el.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    })`)
    const drag = async (x, y, endX, endY) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, modifiers: 1, button: 'left', buttons: 1, clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endX, y: endY, modifiers: 1, button: 'none', buttons: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, modifiers: 1, button: 'left', buttons: 0, clickCount: 1 })
    }
    const answer = label => js(`[...document.querySelectorAll('.confirm-dialog button')].find(el => el.textContent.trim() === ${JSON.stringify(label)}).click()`)
    fs.writeFileSync(file('claude-2-title'), '⠋ Claude')
    await waitFor(isWorking)
    const [original] = await rects()
    const midline = original.y + original.height / 2
    await drag(original.x + original.width * .3, midline, original.x + original.width * .7, midline)
    check('Alt+drag requests split confirmation while the agent is working', await until(`document.querySelector('.confirm-dialog-message')?.textContent === '작업 중인 터미널이 있습니다. 정말 분할하시겠습니까?'`))
    await answer('분할')
    check('accepting the split creates the additional shell', await until(`
      !document.querySelector('.confirm-dialog') && ${panes}.length === 2 &&
      ${panes}.every(pane => pane.hasAttribute('data-local-shell-id'))
    `))

    const [first, second] = await rects()
    await drag(second.x + second.width / 2, second.y + second.height / 2, first.x + first.width / 2, first.y + first.height / 2)
    check('Alt+drag requests merge confirmation when the destination is the working agent', await until(`document.querySelector('.confirm-dialog-message')?.textContent === '작업 중인 터미널이 있습니다. 정말 병합하시겠습니까?'`))
    await answer('취소')
    check('canceling the merge keeps both panes and the agent', await until(`${panes}.length === 2 && !!document.querySelector('[aria-label="claude-2 메시지함"]')`))

    const beforeWake = Number(read('claude-2-wakes')) || 0
    const task = await mcp('codex-1', 'send_message', { to: 'claude-2', text: 'review-next' })
    await sleep(250)
    check('a busy agent retains the new task without submitting a prompt', (Number(read('claude-2-wakes')) || 0) === beforeWake)
    fs.writeFileSync(file('claude-2-title'), '✳ Claude')
    check('the queued message starts a turn when Claude is idle again', await waitFor(() => Number(read('claude-2-wakes')) === beforeWake + 1))
    const pending = await mcp('claude-2', 'read_inbox')
    check('the woken agent can read the original message by MCP', pending.messages.some(message => message.id === task.id && message.text === 'review-next'))
    await mcp('claude-2', 'acknowledge_message', { message_id: task.id })

    const beforeCodexWake = Number(read('codex-1-wakes')) || 0
    await mcp('claude-2', 'send_message', { to: 'codex-1', text: 'check-next' })
    check('a new message starts a turn in an already idle Codex session', await waitFor(() => Number(read('codex-1-wakes')) === beforeCodexWake + 1))

    await until(`!document.querySelector('.confirm-dialog')`)
    await openAgent('codex', 'codex-3')
    fs.writeFileSync(file('codex-3-title'), '⠋ ezshell')
    check('a new Codex session classifies its startup spinner separately', await until(`${row('codex-3')}?.dataset.status === 'starting'`))
    const [starting] = await rects()
    const centerY = starting.y + starting.height / 2
    await drag(starting.x + starting.width * .3, centerY, starting.x + starting.width * .7, centerY)
    check('a Codex startup spinner without a submitted prompt splits without confirmation', await until(`${panes}.length === 2 && !document.querySelector('.confirm-dialog')`, 5000))

    fs.writeFileSync(file('claude-2-program-status'), 'state=blocked:app=claude-code:kind=question:msg=VGVzdA==')
    check('a provider question gets a response-needed icon without showing the question', await until(`
      ${row('claude-2')}?.dataset.status === 'blocked' && ${row('claude-2')}?.textContent.trim() === ''
    `))
    fs.writeFileSync(file('claude-2-exit-code'), '7')
    check('a crashed agent stays in the list with its error and exit code', await until(`
      ${row('claude-2')}?.dataset.status === 'error' && ${row('claude-2')}?.title.includes('7')
    `))

    // Merge another live agent into the active Codex session and check the pane-level ownership.
    const sourceId = await js(owner('codex-1'))
    const targetId = await js(owner('codex-3'))
    const tab = id => `document.querySelector('.terminal-tab[data-tab-id=' + CSS.escape(${JSON.stringify(id)}) + ']')`
    await js(`${tab(sourceId)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 340, clientY: 65 }))`)
    const mergeTarget = `[...document.querySelectorAll('.tab-context-menu .menu-item')].find(item =>
      item.textContent.startsWith('칸으로 병합:') && item.textContent.includes('(3번째 탭)')
    )`
    if (!(await until(`!!${mergeTarget}`))) throw new Error('no merge item for the target agent tab')
    await js(`${mergeTarget}.click()`)
    check('two agent panes group horizontally below their shared session', await until(`
      ${owner('codex-1')} === ${JSON.stringify(targetId)} && ${row('codex-1')}.parentElement === ${row('codex-3')}.parentElement &&
      ${row('codex-3')}.parentElement.children.length === 2 &&
      getComputedStyle(${row('codex-3')}.parentElement).flexDirection === 'row'
    `))
    check('each agent icon focuses its own pane even when grouped under one session', await focusAgent('codex-1') && await focusAgent('codex-3'))
    await driver.shot('local-agent-status')

    const mapCell = id => `document.querySelector('.pane-map .pane-map-cell[data-agent-id="${id}"]')`
    await js(`${row('codex-3')}.closest('.local-terms-item').querySelector('.local-terms-panes').click()`)
    check('the layout map shows an agent in its exact pane and keeps the plain shell numbered', await until(`
      ${mapCell('codex-1')}?.querySelector('.local-agent-icons')?.dataset.agentKind === 'codex' &&
      ${mapCell('codex-3')}?.dataset.status === 'starting' &&
      document.querySelectorAll('.pane-map button.pane-map-cell:not([data-agent-id])').length === 1
    `))
    fs.writeFileSync(file('codex-1-program-status'), 'state=working:app=codex')
    fs.writeFileSync(file('codex-3-program-status'), 'state=blocked:app=codex:kind=question')
    check('the open map updates working and response-needed states alongside the sidebar', await until(`
      ${mapCell('codex-1')}?.dataset.status === 'working' && ${row('codex-1')}?.dataset.status === 'working' &&
      ${mapCell('codex-3')}?.dataset.status === 'blocked' && ${row('codex-3')}?.dataset.status === 'blocked' &&
      ${mapCell('codex-3')}.querySelector('.pane-map-agent-label')?.textContent === '응답 필요'
    `))
    await driver.shot('local-agent-pane-map')
    await js(`${mapCell('codex-1')}.click()`)
    check('clicking its map cell focuses the live agent pane', await until(`
      !document.querySelector('.pane-map') && !!document.activeElement?.closest('[data-local-shell-id]')?.querySelector('[aria-label="codex-1 메시지함"]')
    `))

    fs.writeFileSync(file('codex-3-mcp-disconnect'), '')
    check('a disconnected MCP drops off the live list even while its terminal remains open', await until(`
      window.electronAPI.agentMessagesSnapshot().then(state =>
        state.agents.some(agent => agent.id === 'codex-3' && agent.active && !agent.mcpConnected))
    `))
    const live = await mcp('codex-1', 'list_agents')
    check('list_agents returns only connected agents', live.agents.map(agent => agent.id).join(',') === 'codex-1')

    const plainShell = await js(`[...document.querySelectorAll('.local-terminal-pane')]
      .find(pane => pane.dataset.localTabId === ${JSON.stringify(targetId)} && !pane.querySelector('.agent-pane-mail'))
      .dataset.localShellId`)
    await js(`window.electronAPI.localShellWrite(${JSON.stringify(plainShell)}, 'claude\\r')`)
    check('Claude started by typing claude attaches its global MCP connection to the same pane', await until(`
      window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent =>
        agent.id === 'claude-4' && agent.shellId === ${JSON.stringify(plainShell)} && agent.mcpConnected))
    `), read('manual-claude-mcp-error'))
    const manualTask = await mcp('codex-1', 'send_message', { to: 'claude-4', text: 'hello-manual-claude' })
    check('the incoming Codex message wakes manually launched Claude', await waitFor(() => read('manual-claude-wakes') === '1'))
    const manualInbox = await mcp('manual-claude', 'read_inbox')
    check('manually launched Claude receives the queued message over its global MCP connection',
      manualInbox.messages.some(message => message.id === manualTask.id && message.text === 'hello-manual-claude'))
    const manualReply = await mcp('manual-claude', 'reply_to_message', { message_id: manualTask.id, text: 'hello-codex' })
    check('Codex receives the reply from manually launched Claude',
      (await mcp('codex-1', 'read_inbox')).messages.some(message => message.id === manualReply.id && message.replyTo === manualTask.id))
    fs.writeFileSync(file('manual-claude-mcp-disconnect'), '')
    check('the disconnected global MCP releases the pane and retains message history', await until(`
      window.electronAPI.agentMessagesSnapshot().then(state =>
        state.agents.some(agent => agent.id === 'claude-4' && !agent.shellId && !agent.mcpConnected) &&
        state.messages.some(message => message.id === ${JSON.stringify(manualTask.id)}))
    `))
  } finally {
    driver.close()
  }
}

run().then(finish).catch(error => {
  console.error(error)
  process.exitCode = 1
})
