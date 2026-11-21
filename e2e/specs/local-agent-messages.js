const fs = require('fs')
const path = require('path')
const { connect, createChecks, sleep, unlock, openLocalAgent, pickTabGroup } = require('../support/driver')

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
    const workspace = path.join(profile, 'workspace (2)')
    fs.mkdirSync(workspace)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([workspace]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    async function openAgent(kind, id, folder = workspace) {
      await openLocalAgent(driver, kind, folder)
      if (!(await until(`document.querySelector('[aria-label="${id} 메시지함"]') && document.body.textContent.includes('fixture ready: ${id}')`))) {
        const details = await js(`(async () => ({
          snapshot: await window.electronAPI.agentMessagesSnapshot(),
          errors: [...document.querySelectorAll('[role=alert], .local-project-error, .toast')].map(el => el.textContent),
          panes: [...document.querySelectorAll('.local-terminal-pane .xterm-rows')].map(el => el.textContent.trim().slice(-800))
        }))()`)
        throw new Error(`${kind} fixture did not open (${JSON.stringify(details)})`)
      }
    }
    const row = id => `document.querySelector('.local-agent-chip[data-agent-id="${id}"]')`
    const session = id => `${row(id)}?.closest('[data-local-session-id]')`
    const owner = id => `${session(id)}?.dataset.localSessionId`
    const paneTab = id => `document.querySelector('[aria-label="${id} 메시지함"]')?.closest('[data-local-tab-id]')?.dataset.localTabId`
    await openAgent('codex', 'codex-1')
    check('the single terminal shows its agent under the worktree heading', await until(`
      ${owner('codex-1')} === ${paneTab('codex-1')} && ${session('codex-1')}?.matches('.local-worktree') &&
      ${row('codex-1')}.parentElement.previousElementSibling?.matches('.local-worktree-row') &&
      !${session('codex-1')}?.querySelector('.local-terms-item')
    `))
    const border = element => `getComputedStyle(${element}, '::after')`
    const runningTrace = element => `
      ${element} &&
      ${border(element)}.opacity === '1' &&
      ${border(element)}.animationName === 'local-agent-trace' &&
      ${border(element)}.animationPlayState === 'running'
    `
    // Codex reports startup until its composer has submitted a prompt.
    await js(`(() => {
      const shellId = document.querySelector('[aria-label="codex-1 메시지함"]').closest('[data-local-shell-id]').dataset.localShellId
      window.electronAPI.localShellWrite(shellId, 'test sidebar activity')
      window.electronAPI.localShellWrite(shellId, '\\r')
    })()`)
    fs.writeFileSync(file('codex-1-program-status'), 'state=working:app=codex')
    check('a worktree with a single working tab animates its card border', await until(runningTrace(session('codex-1'))))
    fs.writeFileSync(file('codex-1-program-status'), 'state=idle:app=codex')
    await until(`${row('codex-1')}?.dataset.status === 'idle'`)
    await openAgent('claude', 'claude-2')
    for (const [index, agent] of ['codex-1', 'claude-2'].entries()) {
      check(agent + ' has only icons directly underneath its own session information', await until(`
        ${owner(agent)} && ${owner(agent)} === ${paneTab(agent)} &&
        ${row(agent)}.parentElement.previousElementSibling?.matches('.local-terms-row') &&
        ${row(agent)}.textContent.trim() === '' && ${row(agent)}.querySelectorAll('svg').length === 2
      `))
      check(agent + ' has its own label in the worktree without repeating its name', await until(`
        ${session(agent)}?.querySelector('.local-terms-name')?.textContent === '터미널 ${index + 1}'
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
    check('the bundled CLI can see both agents with independent ids on the same folder', list.self === 'codex-1' && list.agents.length === 2 && list.agents.every(agent => agent.cwd === workspace))

    await js(`window.deliveriesSeen = 0
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.matches('.agent-delivery-notice')) window.deliveriesSeen++
        }
      }).observe(document.querySelector('.agent-delivery-status'), { childList: true })
      // The message flying from the sender to the receiver before the card shows
      window.flights = []
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.matches('.agent-message-flight')) {
            window.flights.push({ icon: node.querySelector('.agent-message-provider')?.dataset.kind ?? null, cardShown: !!document.querySelector('.agent-delivery-notice') })
          }
        }
      }).observe(document.body, { childList: true })`)
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
    check('first the message flies from the sender, with the sender\'s icon, before the card', await js(`window.flights.length === 1 && window.flights[0].icon === 'codex' && !window.flights[0].cardShown`), JSON.stringify(await js('window.flights')))
    check('the card shows each agent\'s icon beside its name', await js(`[...document.querySelectorAll('.agent-delivery-notice strong .agent-message-provider')].map(icon => icon.dataset.kind).join(',') === 'codex,claude'`))
    check('the flying message is gone once it landed', await until(`!document.querySelector('.agent-message-flight')`, 2000))
    check('the receiver has an unread mailbox and tab badge', await until(`
      ${claudeMail}?.dataset.unread === 'true' &&
      document.querySelector('.terminal-tab[data-tab-id="' + ${claudeMail}?.closest('[data-local-tab-id]')?.dataset.localTabId + '"] .agent-tab-mail')?.textContent === '1'
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
    check('with reduced motion nothing flies', await js('window.flights.length === 1'), JSON.stringify(await js('window.flights')))
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    const result = await cli('codex-1', 'message inbox --unread')
    check('Codex receives a reply linked to the original message', result.messages.some(message => message.id === reply.id && message.replyTo === request.id && message.text === 'looks-good'))
    await cli('codex-1', `message ack --id ${reply.id}`)
    check('reading the reply clears both unread badges', await until(`!document.querySelector('.agent-tab-mail')`))

    fs.writeFileSync(file('codex-1-program-status'), 'state=working:app=codex')
    check('the Codex session border runs before waiting for a reply', await until(runningTrace(session('codex-1'))))
    const waiting = cli('codex-1', 'message inbox --wait')
    check('waiting for a reply shows the reply icon and clears the working border', await until(`
      ${row('codex-1')}?.dataset.status === 'reply' && !${session('codex-1')}?.dataset.agentWork
    `))
    const wake = await cli('claude-2', 'message send --to codex-1 --text follow-up')
    check('arriving mail completes the wait and clears the status', (await waiting).messages.some(message => message.id === wake.id) &&
      await until(`${row('codex-1')}?.dataset.status !== 'reply'`))
    await cli('codex-1', `message ack --id ${wake.id}`)
    fs.writeFileSync(file('codex-1-program-status'), 'state=idle:app=codex')
    await until(`${row('codex-1')}?.dataset.status === 'idle'`)

    const shellId = await js(`document.querySelector('[aria-label="claude-2 메시지함"]').closest('[data-local-shell-id]').dataset.localShellId`)
    const isWorking = () => js(`window.electronAPI.localShellHasWorkingAgent([${JSON.stringify(shellId)}])`)
    const claudePane = `${claudeMail}.closest('.local-terminal-pane')`
    const trace = `getComputedStyle(${claudePane}, '::after')`
    fs.writeFileSync(file('claude-2-title'), '⠋ Claude')
    check('a busy OSC title is reported from the running agent PTY', await waitFor(isWorking))
    check('working appears as an icon in the agent list', await until(`${row('claude-2')}?.dataset.status === 'working'`))
    check('the working shell shows a running border without intercepting input', await until(`
      ${trace}.opacity === '1' && ${trace}.animationPlayState === 'running' && ${trace}.pointerEvents === 'none'
    `))
    const angle = `${trace}.getPropertyValue('--local-agent-trace-angle')`
    const firstAngle = await js(angle)
    check('the light travels along the border', await until(`${angle} !== ${JSON.stringify(firstAngle)}`))
    check('the background Claude tab keeps its sidebar border while Codex is selected',
      await focusAgent('codex-1') && await until(`
        ${runningTrace(session('claude-2'))} &&
        ${border(session('claude-2'))}.pointerEvents === 'none' &&
        !${session('codex-1')}?.dataset.agentWork &&
        ${trace}.animationPlayState === 'paused'
      `))
    const q = selector => `document.querySelector(${JSON.stringify(selector)})`
    const foldWorktree = q('.local-worktree-fold')
    const worktree = q('.local-worktree')
    const project = q('.local-project-row')
    const localList = q('.local-terms-toggle')
    const railLocal = q('[data-peek-target="local"]')
    const switchList = q('.sidebar-peek-switch')
    await js(`${foldWorktree}.click()`)
    check('folded worktree shows activity on its own border', await until(runningTrace(worktree)))
    await js(`${project}.click()`)
    check('folded project shows activity on its header', await until(runningTrace(project)))
    await js(`${localList}.click()`)
    check('collapsed local work list shows activity on its toggle', await until(runningTrace(localList)))
    await driver.move(430, 235)
    await js(`${q('.sidebar-toggle')}.click()`)
    check('the compact sidebar still shows local work activity', await until(runningTrace(railLocal)))
    await driver.move(...await driver.center(q('[data-peek-target="sessions"]')))
    check('the session preview shows activity on the switch to local work', await until(runningTrace(switchList)))
    await js(`${q('.sidebar-toggle')}.click()`)
    await until(`!${q('.sidebar.rail')}`)
    await js(`${localList}.click()`)
    await until(`!!${project}`)
    await js(`${project}.click()`)
    await until(`!!${foldWorktree}`)
    await js(`${foldWorktree}.click()`)
    await until(`!!${row('claude-2')}`)
    await focusAgent('claude-2')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    check('reduced motion shows a static working border', await until(`
      ${trace}.animationName === 'none' && ${trace}.borderTopWidth === '1px' && ${trace}.opacity === '1' &&
      ${border(session('claude-2'))}.animationName === 'none' &&
      ${border(session('claude-2'))}.borderTopWidth === '1px' && ${border(session('claude-2'))}.opacity === '1'
    `))
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    fs.writeFileSync(file('claude-2-title'), '✳ Claude')
    check('the idle OSC title clears the busy state', await waitFor(async () => !(await isWorking())))
    check('an idle agent is distinguishable in the sidebar', await until(`${row('claude-2')}?.dataset.status === 'idle'`))
    check('the working border fades when the agent is idle', await until(`
      ${trace}.opacity === '0' && ${trace}.animationPlayState === 'paused' && !${session('claude-2')}?.dataset.agentWork
    `))

    await js(`document.querySelector('[aria-label="claude-2 메시지함"]').closest('.local-terminal-pane').querySelector('.xterm-helper-textarea').focus()`)
    const paste = async () => {
      const key = { code: 'KeyV', key: 'v', modifiers: 2, windowsVirtualKeyCode: 86 }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    }
    const inputFile = shellId.replace(':', '-') + '-input'
    const inputOffset = read(inputFile).length
    await paste()
    check('Ctrl+V invokes the Claude Code image attachment shortcut once', await waitFor(() => read('claude-2-image-paste') === '\x1bv'))
    check('the screenshot paste does not type a path or press Enter in Claude Code', !/\.png|\r/.test(read(inputFile).slice(inputOffset)))
    await focusAgent('codex-1')
    await paste()
    check('Ctrl+V invokes the Codex image attachment shortcut once', await waitFor(() => read('codex-1-image-paste') === '\x16'))
    await focusAgent('claude-2')
    fs.writeFileSync(file('clipboard-text'), 'plain-text-paste')
    await paste()
    check('ordinary Ctrl+V still inserts exactly one text paste', await waitFor(() => read(inputFile).split('plain-text-paste').length === 2))
    await sleep(250)
    check('text paste was not duplicated by a native paste event', read(inputFile).split('plain-text-paste').length === 2)
    check('image paste was not duplicated by browser paste events',
      read('claude-2-image-paste') === '\x1bv' && read('codex-1-image-paste') === '\x16')

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

    const otherPane = `${panes}.find(pane => pane !== ${claudePane})`
    const focusPane = pane => js(`${pane}.querySelector('.xterm-helper-textarea').focus()`)
    const focusBorder = `getComputedStyle(${claudePane}, '::before')`
    await focusPane(claudePane)
    check('a focused working pane keeps its focus outline', await until(`${focusBorder}.borderTopWidth === '2px'`))
    await sleep(220)
    const focusedColor = await js(`${trace}.color`)
    await focusPane(otherPane)
    check('moving focus dims the light on the working pane while the other pane stays clear', await until(`
      ${focusBorder}.borderTopWidth === '1px' && ${trace}.color !== ${JSON.stringify(focusedColor)} &&
      ${trace}.animationPlayState === 'running' && getComputedStyle(${otherPane}, '::after').content === 'none'
    `))

    fs.unlinkSync(file('clipboard-text'))
    const otherShellId = await js(`${otherPane}.dataset.localShellId`)
    const otherInput = otherShellId.replace(':', '-') + '-input'
    await paste()
    const pastedPath = await waitFor(() => read(otherInput).match(/[A-Z]:\\[^\x1b\r\n]+\.png/i)?.[0])
    check('Ctrl+V into an ordinary shell types the saved screenshot path', Boolean(pastedPath))
    check('the pasted path points to a PNG and does not press Enter', Boolean(pastedPath &&
      fs.readFileSync(pastedPath).subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
      !read(otherInput).includes('\r')))

    const [first, second] = await rects()
    await drag(second.x + second.width / 2, second.y + second.height / 2, first.x + first.width / 2, first.y + first.height / 2)
    check('Alt+drag requests merge confirmation when the destination is the working agent', await until(`document.querySelector('.confirm-dialog-message')?.textContent === '작업 중인 터미널이 있습니다. 정말 병합하시겠습니까?'`))
    await answer('취소')
    check('canceling the merge keeps both panes and the agent', await until(`${panes}.length === 2 && !!document.querySelector('[aria-label="claude-2 메시지함"]')`))

    const beforeWake = Number(read('claude-2-wakes')) || 0
    const beforeBusy = Number(read('claude-2-busy-wakes')) || 0
    const task = await mcp('codex-1', 'send_message', { to: 'claude-2', text: 'review-next' })
    check('a busy agent is told at once, into its running task', await waitFor(() => Number(read('claude-2-busy-wakes')) === beforeBusy + 1))
    check('the busy notice does not start a new turn', (Number(read('claude-2-wakes')) || 0) === beforeWake)
    const pending = await mcp('claude-2', 'read_inbox')
    check('the busy agent can read the new task by MCP', pending.messages.some(message => message.id === task.id && message.text === 'review-next'))
    // No receipt (removed 2026-11-20): the sender sees the task read, not yet answered
    const sent = (await mcp('codex-1', 'check_sent', { message_ids: [task.id] })).messages?.[0]
    check('the sender sees its task read but not answered', sent?.status === 'read' && typeof sent.readAt === 'number', JSON.stringify(sent))
    await js(`document.querySelector('[aria-label="claude-2 메시지함"]').click()`)
    check('the messages panel marks the task 읽음 (read, not answered yet)', await until(`[...document.querySelectorAll('.agent-thread-message')].some(m => m.textContent.includes('review-next') && m.querySelector('.agent-read-state')?.textContent === '읽음')`))
    await js(`document.querySelector('.agent-messages-dialog .modal-actions button').click()`)
    await until(`!document.querySelector('.agent-messages-dialog')`)
    fs.writeFileSync(file('claude-2-title'), '✳ Claude')
    check('the put-off task is reminded once Claude is idle again', await waitFor(() => Number(read('claude-2-wakes')) === beforeWake + 1))
    // Done without a reply message, so the Codex wake count below is not raced by one
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

    const manualCodex = await js(`window.electronAPI.localShellOpen({ cols: 80, rows: 24 })`)
    check('a plain local terminal opens for the manual Codex command', manualCodex.success)
    await js(`window.electronAPI.localShellWrite(${JSON.stringify(manualCodex.id)}, 'codex --yolo\\r')`)
    check('typing codex --yolo binds its MCP to the correct terminal without an explicit flag', await until(`
      window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent =>
        agent.id === 'codex-5' && agent.shellId === ${JSON.stringify(manualCodex.id)} && agent.mcpConnected))
    `), read('manual-codex-mcp-error'))
    const firstFromClaude = await mcp('manual-claude', 'send_message', { to: 'codex-5', text: 'hello-manual-codex' })
    check('a new Claude message wakes manually launched Codex', await waitFor(() => read('manual-codex-wakes') === '1'))
    check('manually launched Codex receives the original message',
      (await mcp('manual-codex', 'read_inbox')).messages.some(message => message.id === firstFromClaude.id && message.text === 'hello-manual-codex'))

    fs.writeFileSync(file('manual-claude-mcp-disconnect'), '')
    check('the disconnected global MCP keeps the running agent associated with its pane', await until(`
      window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent =>
        agent.id === 'claude-4' && agent.shellId === ${JSON.stringify(plainShell)} && agent.active && !agent.mcpConnected))
    `))
    fs.writeFileSync(file('manual-claude-exit-code'), '0')
    check('the agent’s exit releases the pane and retains message history', await until(`
      window.electronAPI.agentMessagesSnapshot().then(state =>
        state.agents.some(agent => agent.id === 'claude-4' && !agent.shellId && !agent.mcpConnected) &&
        state.messages.some(message => message.id === ${JSON.stringify(manualTask.id)}))
    `))

    await js(`${session('claude-2')}.querySelector('.local-terms-close').click()`)
    await until(`document.querySelector('.confirm-dialog .btn-danger')?.textContent === '모두 종료'`)
    await answer('모두 종료')
    const compactBadge = `${session('codex-3')}?.querySelector('.local-worktree-row > .local-terms-panes')`
    check('closing the second tab moves the split badge and agents into the worktree card', await until(`
      ${session('codex-3')}?.matches('.local-worktree') && ${compactBadge}?.textContent === '3세션' &&
      !${session('codex-3')}?.querySelector('.local-terms-item, .local-worktree-fold') &&
      ${row('codex-1')}?.parentElement === ${row('codex-3')}?.parentElement
    `))
    await driver.shot('local-agent-worktree')
    await js(`${compactBadge}.click()`)
    check('the worktree badge opens the session layout with live agent states', await until(`
      ${mapCell('codex-1')}?.dataset.status === 'working' && ${mapCell('codex-3')}?.dataset.status === 'blocked'
    `))
    await js(`${compactBadge}.click()`)

    const dialog = `document.querySelector('.agent-messages-dialog')`
    const filter = `document.querySelector('#agent-messages-session')`
    const filterValue = `${filter}?.querySelector('.select-menu-value').textContent`
    const filterOptions = `[...document.querySelectorAll('.select-menu-content [role="menuitemradio"]')]`
    const messageTexts = `[...document.querySelectorAll('.agent-thread-message p')].map(row => row.textContent)`
    const openFilter = async () => {
      if (!(await js(`${filter}?.getAttribute('aria-expanded') === 'true'`))) await driver.click(...await driver.center(filter))
      if (!(await until(`${filterOptions}.length > 0`))) throw new Error('the agent filter did not open')
    }
    const chooseAgent = async label => {
      await openFilter()
      const option = await driver.center(`${filterOptions}.find(item => item.querySelector('.select-menu-item-label').textContent === ${JSON.stringify(label)})`)
      if (!option) throw new Error(`missing agent filter option ${label}`)
      await driver.click(...option)
      await until(`${filterValue} === ${JSON.stringify(label)}`)
    }
    const closeMessages = () => js(`${dialog}.querySelector('.modal-actions button').click()`)
    await mcp('codex-1', 'send_message', { to: 'user', text: 'note-for-user' })
    await js(`document.querySelector('[aria-label="codex-1 메시지함"]').click()`)
    check('the pane inbox opens the selected agent’s read-only messages', await until(`
      ${filterValue} === 'codex-1' && ${filter}.querySelector('.agent-message-provider')?.dataset.kind === 'codex' &&
      ${messageTexts}.includes('note-for-user') &&
      ${dialog}.getBoundingClientRect().width >= 500 &&
      !${dialog}.querySelector('textarea, form') &&
      [...${dialog}.querySelectorAll('button')].every(button => button === ${filter} || button.textContent.trim() === '닫기') &&
      typeof window.electronAPI.agentMessageSend === 'undefined'
    `))
    await openFilter()
    check('the agent filter has icons beside active and ended agents', await js(`
      ${filterOptions}.some(item => item.textContent.trim() === 'codex-1' && item.querySelector('.agent-message-provider')?.dataset.kind === 'codex') &&
      ${filterOptions}.some(item => item.textContent.trim() === 'claude-2 (종료)' && item.querySelector('.agent-message-provider')?.dataset.kind === 'claude')
    `))
    await chooseAgent('전체')
    check('all combines the local work’s conversations and keeps closed agents’ messages', await until(`
      ${filterValue} === '전체' &&
      ['review-please', 'looks-good', 'hello-manual-claude', 'hello-codex'].every(text => ${messageTexts}.includes(text)) &&
      !${messageTexts}.includes('note-for-user') && !${messageTexts}.includes('hello-manual-codex')
    `))
    check('the conversation identifies the sender and recipient by their respective icons', await js(`(() => {
      const message = [...${dialog}.querySelectorAll('.agent-thread-message')].find(row => row.querySelector('p').textContent === 'review-please')
      return [...(message?.querySelectorAll('.agent-message-route .agent-message-provider') ?? [])].map(icon => icon.dataset.kind).join(',') === 'codex,claude'
    })()`))
    await chooseAgent('claude-2 (종료)')
    check('choosing an agent filters the log to its conversation', await until(`
      ${messageTexts}.includes('review-please') && !${messageTexts}.includes('hello-manual-claude')
    `))
    await closeMessages()

    const otherWorkspace = path.join(profile, 'other workspace')
    fs.mkdirSync(otherWorkspace)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([workspace, otherWorkspace]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    await openAgent('codex', 'codex-6', otherWorkspace)
    await openAgent('claude', 'claude-7', otherWorkspace)
    if (!(await until(`window.electronAPI.agentMessagesSnapshot().then(state =>
      ['codex-6', 'claude-7'].every(id => state.agents.some(agent => agent.id === id && agent.mcpConnected)))`))) {
      throw new Error(`The second workspace agents did not connect: ${read('codex-6-mcp-error')} ${read('claude-7-mcp-error')}`)
    }
    await js(`document.querySelector('[aria-label="claude-7 메시지함"]').click()`)
    await until(`!!${filter}`)
    await openFilter()
    check('the second project only offers its agents in the filter', await js(`
      ${filterOptions}.map(option => option.querySelector('.select-menu-item-label').textContent).join(',') === '전체,codex-6,claude-7'
    `))
    await chooseAgent('전체')
    await mcp('codex-6', 'send_message', { to: 'claude-7', text: 'other-workspace-message' })
    check('the second project’s open log receives its own messages only', await until(`
      ${dialog}.querySelector('.agent-message-workspace').textContent === 'other workspace' &&
      ${messageTexts}.join(',') === 'other-workspace-message'
    `))
    await driver.shot('local-agent-messages-workspace')
    await closeMessages()
    await pickTabGroup(driver, 'workspace (2)')
    const paletteKey = { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 2 }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...paletteKey })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...paletteKey })
    const messagesCommand = `[...document.querySelectorAll('.command-item')].find(item => item.textContent.includes('에이전트 메시지 열기'))`
    if (!(await until(`!!${messagesCommand}`))) throw new Error('missing agent messages command')
    await js(`${messagesCommand}.click()`)
    check('the command palette opens all messages for the current project', await until(`
      ${filterValue} === '전체' && ${dialog}.querySelector('.agent-message-workspace').textContent === 'workspace (2)' &&
      ${messageTexts}.includes('review-please') && !${messageTexts}.includes('other-workspace-message')
    `))
  } finally {
    driver.close()
  }
}

run().then(finish).catch(error => {
  console.error(error)
  process.exitCode = 1
})
