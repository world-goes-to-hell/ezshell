const fs = require('fs')
const path = require('path')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { createEntry } = require('../../src/ipc/agentMessageSetup.js')
const { connect, createChecks, sleep, unlock, openLocalAgent, pickTabGroup, SET } = require('../support/driver')

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
    // These checks measure the light running around the border (도는 빛), one of the looks in 설정 > 테마 > 창 효과
    await driver.js(`localStorage.setItem('agent-work-style', 'trace'); document.documentElement.dataset.agentWorkStyle = 'trace'`)
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
    const sidebarStatus = id => `${row(id)}.querySelector('.local-agent-status')`
    const sidebarColor = id => `getComputedStyle(${sidebarStatus(id)}).color`
    const session = id => `${row(id)}?.closest('[data-local-session-id]')`
    const owner = id => `${session(id)}?.dataset.localSessionId`
    const paneTab = id => `document.querySelector('[aria-label="${id} 메시지함"]')?.closest('[data-local-tab-id]')?.dataset.localTabId`
    fs.writeFileSync(file('test-inbox-draft-notice'), '')
    await openAgent('codex', 'codex-1')
    fs.unlinkSync(file('test-inbox-draft-notice'))
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
    const codexIdentityColor = await js(sidebarColor('codex-1'))
    // Codex reports startup until its composer has submitted a prompt.
    await js(`(() => {
      const shellId = document.querySelector('[aria-label="codex-1 메시지함"]').closest('[data-local-shell-id]').dataset.localShellId
      window.electronAPI.localShellWrite(shellId, 'test sidebar activity')
      window.electronAPI.localShellWrite(shellId, '\\r')
    })()`)
    fs.writeFileSync(file('codex-1-program-status'), 'state=working:app=codex')
    check('a single working terminal animates the agent chip under its worktree heading', await until(`
      ${runningTrace(row('codex-1'))} && !${session('codex-1')}?.dataset.agentWork &&
      ${sidebarStatus('codex-1')}.matches('svg') && ${sidebarColor('codex-1')} === ${JSON.stringify(codexIdentityColor)}
    `))
    fs.writeFileSync(file('codex-1-program-status'), 'state=idle:app=codex')
    await until(`${row('codex-1')}?.dataset.status === 'idle'`)
    await openAgent('claude', 'claude-2')
    fs.writeFileSync(file('claude-2-title'), '✳ Claude')
    for (const [index, agent] of ['codex-1', 'claude-2'].entries()) {
      check(agent + ' has only the logo and its filled idle mark beneath its own session information', await until(`
        ${owner(agent)} && ${owner(agent)} === ${paneTab(agent)} &&
        ${row(agent)}.parentElement.previousElementSibling?.matches('.local-terms-row') &&
        ${row(agent)}.textContent.trim() === '' && ${row(agent)}.childElementCount === 1 &&
        ${row(agent)}.firstElementChild.childElementCount === 2 &&
        ${row(agent)}.firstElementChild.firstElementChild.matches('.local-agent-provider') &&
        ${sidebarStatus(agent)}.matches('.local-agent-status-dot') &&
        getComputedStyle(${sidebarStatus(agent)}, '::before').borderTopWidth === '4px'
      `))
      check(agent + ' has its own label in the worktree without repeating its name', await until(`
        ${session(agent)}?.querySelector('.local-terms-name')?.textContent === '터미널 ${index + 1}'
      `))
    }
    check('the idle marks retain distinct agent colors', await js(`${sidebarColor('codex-1')} !== ${sidebarColor('claude-2')}`))
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

    // Open actual screens in the fixture PTY and query them from the other agent's MCP.
    const inspect = () => mcp('claude-2', 'inspect_agent', { id: 'codex-1' })
    const approval = 'Would you like to run this command?'
    const pane = `document.querySelector('[aria-label="codex-1 메시지함"]')?.closest('[data-local-shell-id]')`
    const draw = async (suffix, value, visibleText) => {
      fs.writeFileSync(file('codex-1-' + suffix), value)
      const visible = `${pane}?.querySelector('.xterm-rows')?.textContent.includes(${JSON.stringify(visibleText)})`
      if (!(await until(value ? visible : `!(${visible})`))) throw new Error(`fixture did not redraw ${suffix}`)
    }
    await draw('approval', [approval, '  $ PRIVATE-COMMAND', '› 1. Yes', '  2. No', 'Press enter to confirm or esc to cancel'].join('\r\n'), approval)
    const inspected = await inspect()
    check('inspect_agent reports the live approval without its terminal details', inspected.status === 'blocked' &&
      inspected.statusSource === 'screen' && inspected.blocked?.kind === 'approval' &&
      inspected.blocked.question === approval && inspected.blocked.options?.join(',') === 'Yes,No' &&
      !JSON.stringify(inspected).includes('PRIVATE-COMMAND'), JSON.stringify(inspected))
    fs.writeFileSync(file('test-notifications'), '')
    const escalation = { id: 'codex-1', reason: 'PRIVATE-REASON' }
    const firstAlert = await mcp('claude-2', 'escalate', escalation)
    const again = await mcp('claude-2', 'escalate', escalation)
    const notices = read('test-notifications').trim().split('\n').filter(Boolean).map(JSON.parse)
    const hidden = process.env.EZSHELL_TEST_HIDDEN_WINDOWS === '1'
    check(hidden ? 'escalation never sends an OS notification from a hidden test app' : 'escalate sends one OS notification with only the agent and the kind',
      firstAlert.notified && !again.notified && (hidden ? notices.length === 0 :
        notices.length === 1 && notices[0].title === 'codex-1 가 응답을 기다립니다' && notices[0].body === '확인 요청'), JSON.stringify(notices))
    const alertToast = `[...document.querySelectorAll('.toast')].find(item => item.textContent.includes('codex-1 가 응답을 기다립니다'))`
    check('the in-app alert keeps the question and reason private', await until(`
      ${alertToast}?.textContent.includes('그 칸으로 가기') &&
      !${alertToast}?.textContent.includes('PRIVATE-REASON') && !${alertToast}?.textContent.includes(${JSON.stringify(approval)})
    `))
    await js(`${alertToast}.querySelector('.toast-action').click()`)
    check('the escalation action focuses the waiting agent’s pane', await until(`${pane}?.contains(document.activeElement)`))
    await draw('approval', '', approval)
    await draw('screen', ['Select Model and Effort', '› 1. Model A', '  2. Model B', 'enter select · esc back'].join('\r\n'), 'Select Model and Effort')
    check('inspect_agent names a native CLI menu without its options', JSON.stringify((await inspect()).blocked) === '{"kind":"cli-screen"}')
    await draw('screen', '', 'Select Model and Effort')
    await draw('draft', 'PRIVATE-DRAFT', 'PRIVATE-DRAFT')
    check('inspect_agent returns the draft origin without draft text', JSON.stringify((await inspect()).blocked) === '{"kind":"draft","ours":false}')
    await draw('draft', '', 'PRIVATE-DRAFT')
    await focusAgent('claude-2')
    await mcp('codex-1', 'set_role', { role: '보내기 구현' })
    await mcp('claude-2', 'set_role', { role: '리뷰어' })
    check('MCP roles appear on the terminal strip and in the agent list',
      (await mcp('codex-1', 'list_agents', {})).agents.find(agent => agent.id === 'claude-2')?.role === '리뷰어' &&
      await until(`document.querySelector('.agent-pane-usage .agent-identity-badge[data-agent-id="codex-1"]')?.textContent === 'codex-1 · 보내기 구현'`))
    const tooltip = "document.querySelector('.app-tooltip.is-visible')"
    const identityTooltip = (identity, provider, detail) => `(() => {
      const tip = ${tooltip}
      const lines = tip?.textContent.split('\\n')
      return lines?.length === 3 && lines[0] === ${JSON.stringify(identity)} &&
        lines[1].startsWith(${JSON.stringify(provider + ' · ')}) &&
        // The place is the folder's name alone: no branch, no pane number (user request, 2026-11-25)
        !!lines[2] && !lines[2].includes(' · ') &&
        getComputedStyle(tip).whiteSpace === 'pre-line' &&
        (tip.querySelector('small')?.textContent.trim() ?? '') === ${JSON.stringify(detail ? '· ' + detail : '')}
    })()`
    await driver.move(...await driver.center(row('codex-1')))
    check('the sidebar chip tooltip shows the agent ID and role, with the same color as its pane', await until(`
      ${identityTooltip('보내기 구현 · codex-1', 'Codex', 'codex-1')} &&
      ${sidebarColor('codex-1')} ===
        getComputedStyle(document.querySelector('.agent-pane-usage .agent-identity-badge[data-agent-id="codex-1"] .agent-identity-dot')).backgroundColor
    `))
    await driver.shot('local-agent-sidebar-role')
    await driver.move(20, 45)

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
    // 2026-11-25 user request: the card names an agent by its role alone (the tooltip keeps the id)
    check('the arrival is shown beside the receiver with both agent roles alone', await noticeAt(claudeMail, '보내기 구현 → 리뷰어'))
    check('first the message flies from the sender, with the sender\'s icon, before the card', await js(`window.flights.length === 1 && window.flights[0].icon === 'codex' && !window.flights[0].cardShown`), JSON.stringify(await js('window.flights')))
    check('the card shows each agent\'s icon beside its name', await js(`[...document.querySelectorAll('.agent-delivery-notice strong .agent-message-provider')].map(icon => icon.dataset.kind).join(',') === 'codex,claude'`))
    check('both arrival dots match the status colors of the same agents in the sidebar', await js(`['codex-1', 'claude-2'].every(id => {
      const arrival = document.querySelector('.agent-delivery-notice [data-agent-id="' + id + '"] .agent-identity-dot')
      const sidebar = document.querySelector('.local-agent-chip[data-agent-id="' + id + '"] .local-agent-status')
      return arrival && sidebar && getComputedStyle(arrival).backgroundColor === getComputedStyle(sidebar).color
    })`))
    check('the flying message is gone once it landed', await until(`!document.querySelector('.agent-message-flight')`, 2000))
    check('the receiver has an unread mailbox and tab badge', await until(`
      ${claudeMail}?.dataset.unread === 'true' &&
      document.querySelector('.terminal-tab[data-tab-id="' + ${claudeMail}?.closest('[data-local-tab-id]')?.dataset.localTabId + '"] .agent-tab-mail')?.textContent === '1'
    `))
    await driver.shot('local-agent-delivery')
    const arrivalBadge = "document.querySelector('.agent-delivery-notice [data-agent-id=\"claude-2\"]')"
    const arrivalPoint = await driver.center(arrivalBadge)
    // The notice lets clicks through to the pane below (its badge has nothing to click).
    check('the arrival notice does not take clicks', !!arrivalPoint && await js(`!document.elementFromPoint(${arrivalPoint[0]}, ${arrivalPoint[1]})?.closest('.agent-delivery-notice')`))
    check('the arrival notice expires', await until(`!${arrivalBadge}`, 3000))
    const duplicate = await cli('codex-1', 'message send --to claude-2 --text review-please --request-id review-1')
    check('retry returns the original id without showing another arrival', request.id === duplicate.id && await js('window.deliveriesSeen') === 1)
    const inbox = await cli('claude-2', 'message inbox --unread')
    check('Claude receives the exact request, including its sender', inbox.messages.length === 1 && inbox.messages[0].from === 'codex-1' && inbox.messages[0].text === 'review-please')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const reply = await cli('claude-2', `message reply --reply-to ${request.id} --text looks-good`)
    const codexBadge = `[...document.querySelectorAll('.terminal-tab')].find(tab => tab.dataset.tabId === ${paneTab('codex-1')})?.querySelector('.agent-tab-mail')`
    check('the reply appears alongside the inactive Codex tab with reduced motion enabled', await noticeAt(codexBadge, '리뷰어 → 보내기 구현'))
    check('with reduced motion nothing flies', await js('window.flights.length === 1'), JSON.stringify(await js('window.flights')))
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    const result = await cli('codex-1', 'message inbox --unread')
    check('Codex receives a reply linked to the original message', result.messages.some(message => message.id === reply.id && message.replyTo === request.id && message.text === 'looks-good'))
    await cli('codex-1', `message ack --id ${reply.id}`)
    check('reading the reply clears both unread badges', await until(`!document.querySelector('.agent-tab-mail')`))

    fs.writeFileSync(file('claude-2-suggestion'), 'Try the next change')
    await until(`${claudeMail}.closest('.local-terminal-pane').textContent.includes('Try the next change')`)
    await js(`${claudeMail}.closest('.local-terminal-pane').querySelector('.xterm-helper-textarea').focus()`)
    const chatKey = { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 }
    const toggleChat = async () => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...chatKey })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...chatKey })
    }
    await toggleChat()
    const chatBell = `${claudeMail}?.closest('.local-terminal-pane')?.querySelector('.agent-chat-notification')`
    check('chat mode shows the notification bell for the receiver', await until(`!!${chatBell}`))
    check('the chat header carries the same role as the terminal strip', await until(`
      ${claudeMail}?.closest('.local-terminal-pane')?.querySelector('.agent-chat-head .agent-identity-badge')?.textContent === 'claude-2 · 리뷰어'
    `))
    await driver.shot('local-agent-chat-role')
    // 2026-11-24 user request: the name in the chat header is clicked to change the role
    const chatHead = `${claudeMail}?.closest('.local-terminal-pane')?.querySelector('.agent-chat-head')`
    const renameInChat = async role => {
      await js(`${chatHead}.querySelector('.agent-identity-edit').click()`)
      if (!await until(`!!document.querySelector('.agent-role-popover .agent-role-editor input')`)) throw new Error('the chat role editor did not open')
      await js(`(${SET})(document.querySelector('.agent-role-popover input'), ${JSON.stringify(role)})`)
      await js(`document.querySelector('.agent-role-popover button[type=submit]').click()`)
      return until(`!document.querySelector('.agent-role-popover') && ${chatHead}.querySelector('.agent-identity-badge')?.textContent === ${JSON.stringify('claude-2 · ' + role)}`)
    }
    check('clicking the agent name in the chat header renames it there', await renameInChat('검토 담당'))
    check('the renamed role reaches the agent message window too', (await mcp('codex-1', 'list_agents')).agents?.some(agent => agent.id === 'claude-2' && agent.role === '검토 담당'))
    check('the chat header editor puts the role back', await renameInChat('리뷰어'))
    const firstWakes = Number(read('claude-2-wakes'))
    const nextRequest = await mcp('codex-1', 'send_message', { to: 'claude-2', text: 'Please check the next change' })
    check('in chat mode the arrival card opens below the bell and shows the unread count', await noticeAt(chatBell, '보내기 구현 → 리뷰어') &&
      await until(`${chatBell}?.getAttribute('aria-label') === '읽지 않은 메시지 1개'`))
    check('Claude starts a new turn for a follow-up even when its empty composer shows a suggestion',
      await waitFor(() => Number(read('claude-2-wakes')) === firstWakes + 1))
    const nextInbox = await mcp('claude-2', 'read_inbox')
    check('the follow-up reaches the same agent inbox', nextInbox.messages.some(message => message.id === nextRequest.id))
    check('the notification count clears when the agent reads the message', await until(`${chatBell}?.dataset.unread === 'false'`))
    await mcp('claude-2', 'acknowledge_message', { message_id: nextRequest.id })
    await js(`${chatBell}.closest('.agent-chat-cover').focus()`)
    await toggleChat()
    await until(`!${chatBell}`)
    fs.writeFileSync(file('claude-2-suggestion'), '')

    await focusAgent('codex-1')
    await toggleChat()
    const codexPane = "document.querySelector('[aria-label=\"codex-1 메시지함\"]')?.closest('.local-terminal-pane')"
    const codexChat = `${codexPane}?.querySelector('.agent-chat-cover')`
    const codexChatStatus = `${codexChat}?.querySelector('.agent-chat-status')`
    fs.writeFileSync(file('codex-1-program-status'), 'state=working:app=codex')
    check('the Codex chat and chip borders run before waiting for a reply', await until(`
      ${runningTrace(row('codex-1'))} && ${runningTrace(codexPane)} &&
      ${codexChatStatus}?.dataset.status === 'working'
    `))
    const waiting = cli('codex-1', 'message inbox --wait')
    check('waiting for a reply shows the reply icon and clears the working border', await until(`
      ${row('codex-1')}?.dataset.status === 'reply' && ${border(row('codex-1'))}.animationPlayState === 'paused'
    `))
    check('the chat shows reply wait while its work effect is hidden', await until(`
      ${codexChatStatus}?.dataset.status === 'reply' &&
      ${codexChat}?.querySelector('.agent-chat-reply-progress')?.textContent === '답장 대기…' &&
      ${codexPane}?.dataset.agentWork === 'idle' && ${border(codexPane)}.opacity === '0'
    `, 3000))
    const wake = await cli('claude-2', 'message send --to codex-1 --text follow-up')
    check('arriving mail completes the wait and clears the status', (await waiting).messages.some(message => message.id === wake.id) &&
      await until(`${row('codex-1')}?.dataset.status !== 'reply'`))
    check('the chat work effect resumes after the reply', await until(`
      ${codexChatStatus}?.dataset.status === 'working' && ${runningTrace(codexPane)}
    `))
    await cli('codex-1', `message ack --id ${wake.id}`)
    fs.writeFileSync(file('codex-1-program-status'), 'state=idle:app=codex')
    await until(`${row('codex-1')}?.dataset.status === 'idle'`)
    await js(`${codexChat}?.querySelector('.agent-chat-input').focus()`)
    await toggleChat()
    await until(`!${codexChat}`)
    await focusAgent('claude-2')

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
    check('the background Claude agent keeps its chip border while Codex is selected',
      await focusAgent('codex-1') && await until(`
        ${runningTrace(row('claude-2'))} &&
        ${border(row('claude-2'))}.pointerEvents === 'none' &&
        !${session('claude-2')}?.dataset.agentWork &&
        ${border(row('codex-1'))}.opacity === '0' &&
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
      ${trace}.animationName === 'none' && ${trace}.borderTopWidth === '3px' && ${trace}.opacity === '1' &&
      ${border(row('claude-2'))}.animationName === 'none' &&
      ${border(row('claude-2'))}.borderTopWidth === '1px' && ${border(row('claude-2'))}.opacity === '1'
    `))
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    fs.writeFileSync(file('claude-2-title'), '✳ Claude')
    check('the idle OSC title clears the busy state', await waitFor(async () => !(await isWorking())))
    check('an idle agent is distinguishable in the sidebar', await until(`${row('claude-2')}?.dataset.status === 'idle'`))
    check('the working border fades when the agent is idle', await until(`
      ${trace}.opacity === '0' && ${trace}.animationPlayState === 'paused' && ${border(row('claude-2'))}.opacity === '0'
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
    check('moving focus keeps the working light visible while the other pane stays clear', await until(`
      ${focusBorder}.borderTopWidth === '1px' && ${trace}.color === ${JSON.stringify(focusedColor)} &&
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
    const dialog = `document.querySelector('.agent-messages-dialog')`
    const viewTab = label => `[...document.querySelectorAll('.agent-messages-dialog [role=tab]')].find(tab => tab.textContent.trim() === ${JSON.stringify(label)})`
    const showView = async label => {
      if (!(await until(`!!${dialog}`))) throw new Error('agent messages dialog did not open')
      await driver.click(...await driver.center(viewTab(label)))
      if (!(await until(`${viewTab(label)}?.getAttribute('aria-selected') === 'true'`))) throw new Error(`could not activate ${label}`)
    }
    const card = id => `document.querySelector('.agent-message-map-card[data-agent-id="${id}"]')`
    const cardPick = id => `${card(id)}?.querySelector('.agent-message-map-card-pick')`
    const edges = `[...document.querySelectorAll('.agent-message-map-edge')]`
    await js(`document.querySelector('[aria-label="claude-2 메시지함"]').click()`)
    check('the relationship view is the default and the pane opens its agent’s history', await until(`
      ${dialog}?.dataset.view === 'map' && ${cardPick('claude-2')}?.getAttribute('aria-pressed') === 'true' &&
      [...document.querySelectorAll('.agent-thread-message')].some(m => m.textContent.includes('review-next') && m.querySelector('.agent-read-state')?.dataset.state === 'seen')
    `))
    await showView('목록')
    check('the messages panel marks the task 읽음 (read, not answered yet)', await until(`[...document.querySelectorAll('.agent-thread-message')].some(m => m.textContent.includes('review-next') && m.querySelector('.agent-read-state')?.textContent === '읽음')`))
    await js(`document.querySelector('.agent-messages-dialog .modal-actions button').click()`)
    await until(`!document.querySelector('.agent-messages-dialog')`)
    fs.writeFileSync(file('claude-2-title'), '✳ Claude')
    check('the put-off task is reminded once Claude is idle again', await waitFor(() => Number(read('claude-2-wakes')) === beforeWake + 1))
    // Done without a reply message, so the Codex wake count below is not raced by one
    await mcp('claude-2', 'acknowledge_message', { message_id: task.id })

    const beforeCodexWake = Number(read('codex-1-wakes')) || 0
    await draw('draft', 'PRIVATE-BLOCKING-DRAFT', 'PRIVATE-BLOCKING-DRAFT')
    await mcp('claude-2', 'send_message', { to: 'codex-1', text: 'check-next' })
    const inboxWarning = `${pane}?.querySelector('.local-terminal-inbox-draft')`
    const draftToast = `[...document.querySelectorAll('.toast')].filter(item => item.textContent.includes('codex-1 메시지 전달 지연'))`
    check('unread mail blocked by a draft adds a notice to that pane and leaves the draft alone',
      await until(`${inboxWarning}?.textContent.includes('입력칸에 글이 남아 메시지를 전하지 못했습니다')`) &&
      (Number(read('codex-1-wakes')) || 0) === beforeCodexWake)
    await sleep(1000)
    check('the inbox warning appears once and keeps the draft text private', await js(`
      ${draftToast}.length === 1 && !${draftToast}[0].textContent.includes('PRIVATE-BLOCKING-DRAFT')`))
    await draw('draft', '', 'PRIVATE-BLOCKING-DRAFT')
    check('clearing the draft removes the pane notice', await until(`!${inboxWarning}`))
    check('a new message starts a turn in an already idle Codex session', await waitFor(() => Number(read('codex-1-wakes')) === beforeCodexWake + 1))

    await until(`!document.querySelector('.confirm-dialog')`)
    await openAgent('codex', 'codex-3')
    fs.writeFileSync(file('codex-3-title'), '⠋ ezshell')
    check('a new Codex session classifies its startup spinner separately', await until(`${row('codex-3')}?.dataset.status === 'starting'`))
    const [starting] = await rects()
    const centerY = starting.y + starting.height / 2
    await drag(starting.x + starting.width * .3, centerY, starting.x + starting.width * .7, centerY)
    check('a Codex startup spinner without a submitted prompt splits without confirmation', await until(`${panes}.length === 2 && !document.querySelector('.confirm-dialog')`, 5000))

    fs.writeFileSync(file('claude-2-program-status'), 'state=idle:app=claude-code')
    await until(`${row('claude-2')}?.dataset.status === 'idle'`)
    fs.writeFileSync(file('claude-2-approval'), [
      'Do you want to proceed?', '', '❯ 1. Yes', '  2. No (esc)'
    ].join('\r\n'))
    check('a provider question gets a response-needed icon without showing the question', await until(`
      ${row('claude-2')}?.dataset.status === 'blocked' && ${row('claude-2')}?.title.includes('응답 필요') &&
      ${row('claude-2')}?.textContent.trim() === ''
    `))
    fs.writeFileSync(file('claude-2-approval'), '')
    check('clearing the prompt restores the idle chip', await until(`${row('claude-2')}?.dataset.status === 'idle'`))
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
    check('only the working chip animates when two agents share a session', await until(`
      ${runningTrace(row('codex-1'))} && ${border(row('codex-3'))}.opacity === '0' && !${session('codex-1')}?.dataset.agentWork
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
    const cardStatus = id => `${card(id)}?.querySelector('.agent-message-map-card-status')`
    await js(`document.querySelector('[aria-label="codex-1 메시지함"]').click()`)
    await showView('관계도')
    check('a disconnected agent with history uses the archived status dot', await until(`
      ${cardStatus('claude-4')}?.textContent === '연결 끊김' && ${cardStatus('claude-4')}?.dataset.status === 'ended'
    `))
    await showView('목록')
    await js(`${dialog}.querySelector('.modal-actions button').click()`)
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

    const filter = `document.querySelector('#agent-messages-session')`
    const filterValue = `(${filter}?.querySelector('.select-menu-detail')?.textContent ?? ${filter}?.querySelector('.select-menu-value')?.textContent)`
    const filterOptions = `[...document.querySelectorAll('.select-menu-content [role="menuitemradio"]')]`
    const optionId = `(item => item.querySelector('.select-menu-detail')?.textContent ?? item.querySelector('.select-menu-item-label')?.textContent)`
    const messageTexts = `[...document.querySelectorAll('.agent-thread-message p')].map(row => row.textContent)`
    const openFilter = async () => {
      if (!(await js(`${filter}?.getAttribute('aria-expanded') === 'true'`))) await driver.click(...await driver.center(filter))
      if (!(await until(`${filterOptions}.length > 0`))) throw new Error('the agent filter did not open')
    }
    const chooseAgent = async label => {
      await openFilter()
      const option = await driver.center(`${filterOptions}.find(item => ${optionId}(item) === ${JSON.stringify(label)})`)
      if (!option) throw new Error(`missing agent filter option ${label}`)
      await driver.click(...option)
      await until(`${filterValue} === ${JSON.stringify(label)}`)
    }
    const closeMessages = () => js(`${dialog}.querySelector('.modal-actions button').click()`)
    await mcp('codex-1', 'send_message', { to: 'user', text: 'note-for-user' })
    const longText = ['설계 검토를 시작합니다.', '**머리글** <b>문자 그대로</b>', '세 번째 줄',
      '네 번째 줄', '다섯 번째 줄', '끝 줄 찾기'].join('\n')
    await mcp('codex-1', 'send_message', { to: 'user', text: longText })
    await js(`document.querySelector('[aria-label="codex-1 메시지함"]').click()`)
    check('the pane inbox opens the selected agent’s read-only messages', await until(`
      ${filterValue} === 'codex-1' && ${filter}.querySelector('.agent-message-provider')?.dataset.kind === 'codex' &&
      ${messageTexts}.includes('note-for-user') &&
      ${dialog}.getBoundingClientRect().width >= 500 &&
      !${dialog}.querySelector('textarea, form') &&
      [...${dialog}.querySelectorAll('button')].every(button => button === ${filter} || button.matches('[role=tab], .agent-identity-action, .agent-message-expand, .agent-messages-large, .agent-message-map-controls button') || button.textContent.trim() === '닫기') &&
      typeof window.electronAPI.agentMessageSend === 'undefined'
    `))
    const messageRow = body => `[...document.querySelectorAll('.agent-thread-message')].find(row => row.querySelector('p')?.textContent === ${JSON.stringify(body)})`
    const bubbleLabel = body => `(${messageRow(body)})?.parentElement.querySelector('.agent-message-group-label')`
    const subject = `document.querySelector('.agent-message-thread-heading .agent-message-subject')`
    const subjectLocation = `document.querySelector('.agent-message-subject + .agent-message-actor-location')`
    check('the list heading names the selected agent and puts the pane and its action below', await until(`
      ${subject}?.textContent === '보내기 구현 · codex-1 의 메시지' &&
      !!${subject}.querySelector('.agent-identity-dot') && ${subject}.querySelector('.agent-message-provider')?.dataset.kind === 'codex' &&
      ${subjectLocation}?.querySelector('.agent-message-pane-number')?.textContent.match(/^ · [0-9]+$/) &&
      ${subjectLocation}.querySelector('[data-action=go]')?.textContent === '그 칸으로 가기' &&
      ${subjectLocation}.getBoundingClientRect().top >= ${subject}.getBoundingClientRect().bottom
    `))
    const longRow = '(' + messageRow(longText) + ')'
    const expand = longRow + "?.querySelector('.agent-message-expand')"
    check('outgoing messages align right and show the sender’s role alone', await until(`
      ${longRow}?.closest('.agent-message-group')?.dataset.side === 'right' &&
      (${messageRow('looks-good')})?.closest('.agent-message-group')?.dataset.side === 'left' &&
      ${bubbleLabel('looks-good')}?.textContent === '리뷰어 · claude-2' &&
      ${bubbleLabel('review-please')}?.textContent === '보내기 구현' &&
      !${bubbleLabel('review-please')}?.querySelector('svg, .agent-identity-dot') &&
      ${bubbleLabel('note-for-user')}?.textContent === '보내기 구현'
    `))
    check('consecutive messages to the same recipient share their single label', await js(`
      ${longRow}?.parentElement === (${messageRow('note-for-user')})?.parentElement &&
      ${longRow}.parentElement.querySelectorAll('.agent-message-group-label .agent-message-actor').length === 1
    `))
    check('a long message starts at four lines and retains literal Markdown and HTML text', await until(`
      ${expand}?.getAttribute('aria-expanded') === 'false' &&
      !${longRow}.querySelector('b, strong') && ${longRow}.querySelector('.agent-message-body').scrollHeight >
        ${longRow}.querySelector('.agent-message-body').clientHeight
    `))
    await js(`${expand}.focus()`)
    await driver.enter()
    check('Enter expands the full message and keeps focus on the toggle', await until(`
      ${expand}?.getAttribute('aria-expanded') === 'true' && document.activeElement === ${expand} &&
      ${longRow}.querySelector('.agent-message-body').id === ${expand}.getAttribute('aria-controls')
    `))
    await driver.enter()
    check('Enter collapses the message again', await until(`${expand}.getAttribute('aria-expanded') === 'false'`))
    await js(`${dialog}.querySelector('.agent-message-list-actions [data-action=edit]').click()`)
    await until(`!!document.querySelector('.agent-role-editor input')`)
    await js(`(${SET})(document.querySelector('.agent-role-editor input'), '보내기 담당')`)
    await js(`document.querySelector('.agent-role-editor button[type=submit]').click()`)
    await mcp('codex-1', 'set_role', { role: 'MCP 역할 갱신' })
    check('the role edited in the list overrides an MCP update in the window and pane', await until(`
      ${filter}?.textContent.includes('보내기 담당') &&
      document.querySelector('.agent-pane-usage .agent-identity-badge[data-agent-id="codex-1"]')?.textContent === 'codex-1 · 보내기 담당'
    `))
    await openFilter()
    check('the agent filter has icons beside active and ended agents', await js(`
      ${filterOptions}.some(item => ${optionId}(item) === 'codex-1' && item.querySelector('.agent-message-provider')?.dataset.kind === 'codex') &&
      ${filterOptions}.some(item => ${optionId}(item) === 'claude-2 (종료)' && item.querySelector('.agent-message-provider')?.dataset.kind === 'claude')
    `))
    await chooseAgent('전체')
    check('all combines the local work’s conversations and keeps closed agents’ messages', await until(`
      ${filterValue} === '전체' &&
      ['review-please', 'looks-good', 'hello-manual-claude', 'hello-codex'].every(text => ${messageTexts}.includes(text)) &&
      !${messageTexts}.includes('note-for-user') && !${messageTexts}.includes('hello-manual-codex')
    `))
    check('the all-agents view identifies both participants once per message group', await js(`(() => {
      const message = ${messageRow('review-please')}
      return [...(message?.parentElement.querySelectorAll('.agent-message-group-label .agent-message-provider') ?? [])].map(icon => icon.dataset.kind).join(',') === 'codex,claude'
    })()`))
    const searchFor = value => js(`(${SET})(document.querySelector('.agent-message-search input'), ${JSON.stringify(value)})`)
    await searchFor('리뷰어')
    check('search matches an agent’s role and filters out other conversations', await until(`
      ${messageTexts}.includes('review-please') && !${messageTexts}.includes('hello-manual-claude')
    `))
    await searchFor('CLAUDE-4')
    check('search by ID is case-insensitive', await until(`
      ${messageTexts}.includes('hello-manual-claude') && !${messageTexts}.includes('review-please')
    `))
    await searchFor('note-for-user')
    check('search includes a matching message to the user', await until(`${messageTexts}.join(',') === 'note-for-user'`))
    await searchFor('끝 줄 찾기')
    check('search opens a long matched message and marks the match beyond the preview', await until(`
      ${longRow}?.querySelector('p mark')?.textContent === '끝 줄 찾기' &&
      ${expand}?.getAttribute('aria-expanded') === 'true'
    `))
    await searchFor('')
    await chooseAgent('claude-2 (종료)')
    check('choosing an agent filters the log to its conversation', await until(`
      ${messageTexts}.includes('review-please') && !${messageTexts}.includes('hello-manual-claude')
    `))
    await showView('관계도')
    check('historical agents remain on the map and disconnected agents without messages stay out', await until(`
      ${card('claude-2')}?.dataset.archived === 'true' && Number(getComputedStyle(${card('claude-2')}).opacity) < 1 &&
      ${card('codex-1')}?.dataset.archived === 'false' && !${card('codex-3')} &&
      ${cardStatus('claude-2')}?.textContent === '종료' && ${cardStatus('claude-2')}?.dataset.status === 'ended' &&
      !${card('claude-2')}?.querySelector('[data-action=go]')
    `))
    await js(`${card('codex-1')}.querySelector('[data-action=edit]').click()`)
    check('the map pencil opens the same stored role for editing', await until(`document.querySelector('.agent-role-editor input')?.value === '보내기 담당'`))
    await js(`document.querySelector('.agent-role-editor button:last-of-type').click()`)
    const archivedEdge = `${edges}.find(edge => edge.getAttribute('aria-label').includes('claude-2') && edge.getAttribute('aria-label').includes('codex-1'))`
    const linePoint = await js(`(() => {
      const path = document.querySelector('.agent-message-map-hit')
      const point = path.getPointAtLength(path.getTotalLength() * 0.18).matrixTransform(path.getScreenCTM())
      return [point.x, point.y]
    })()`)
    await driver.click(...linePoint)
    check('selecting an edge opens only the two agents’ messages, oldest first', await until(`
      ${archivedEdge}?.getAttribute('aria-pressed') === 'true' &&
      ${messageTexts}.slice(0, 2).join(',') === 'review-please,looks-good' &&
      !${messageTexts}.includes('note-for-user') && !${messageTexts}.includes('hello-manual-claude')
    `))
    check('the agent marker colors match across card, message, pane, and direction line', await js(`(() => {
      const cardColor = getComputedStyle(${card('codex-1')}.querySelector('.agent-identity-dot')).backgroundColor
      const note = ${messageRow('review-please')}
      return getComputedStyle(note.parentElement.querySelector('.agent-identity-dot')).backgroundColor === cardColor &&
        getComputedStyle(document.querySelector('.agent-pane-usage .agent-identity-badge[data-agent-id="codex-1"] .agent-identity-dot')).backgroundColor === cardColor &&
        [...document.querySelectorAll('.agent-message-map-line')].some(line => getComputedStyle(line).stroke === cardColor) &&
        document.querySelector('.agent-message-pair-locations [data-agent-id="codex-1"] .agent-message-pane-number')?.textContent.match(/^ · [0-9]+$/)
    })()`))
    check('the edge shows the two participants once in the header and alternates colored bubble sides', await js(`(() => {
      const outgoing = ${messageRow('review-please')}
      const incoming = ${messageRow('looks-good')}
      const header = document.querySelector('.agent-message-participants')
      const pane = document.querySelector('.agent-message-pair-locations [data-agent-id="codex-1"]')
      const tabName = pane?.querySelector('.agent-message-pane-tab')
      return header?.querySelectorAll('.agent-message-actor').length === 2 &&
        header.textContent === '리뷰어 · claude-2 ⇄ 보내기 담당 · codex-1' &&
        pane?.querySelector('[data-action=go]')?.textContent === '그 칸으로 가기' &&
        tabName?.scrollWidth === tabName?.clientWidth &&
        pane.querySelector('.agent-message-pane-number').getBoundingClientRect().right <=
          pane.querySelector('.agent-message-pane-label').getBoundingClientRect().right &&
        pane.getBoundingClientRect().top >= header.getBoundingClientRect().bottom &&
        outgoing?.parentElement.dataset.side === 'right' && incoming?.parentElement.dataset.side === 'left' &&
        outgoing.getBoundingClientRect().right > incoming.getBoundingClientRect().right &&
        getComputedStyle(outgoing.querySelector('.agent-message-bubble')).backgroundColor !==
          getComputedStyle(incoming.querySelector('.agent-message-bubble')).backgroundColor &&
        outgoing.querySelector('.agent-read-state')?.dataset.state === 'answered' &&
        incoming.querySelector('time')?.dateTime && document.querySelector('.agent-message-date')?.textContent.includes('년')
    })()`))
    await searchFor('looks-good')
    check('a reply quotes its original while the original is filtered out', await until(`
      ${messageTexts}.join(',') === 'looks-good' &&
      (${messageRow('looks-good')}).querySelector('blockquote span')?.textContent === 'review-please'
    `))
    await searchFor('')
    await until(`!document.querySelector('.agent-delivery-notice')`, 3500)
    await driver.shot('local-agent-message-map')
    await driver.shot('local-agent-messages-selected-edge')
    await driver.move(...await driver.center(`${card('codex-1')}.querySelector('.agent-message-map-card-name strong')`))
    check('the role card tooltip shows the smaller ID beside its name and one location', await until(identityTooltip('보내기 담당 · codex-1', 'Codex', 'codex-1')))
    await driver.shot('local-agent-message-map-tooltip-role')
    await driver.move(...await driver.center("document.querySelector('.agent-message-participants > [data-agent-id=\"codex-1\"] .agent-message-actor-name')"))
    check('the message header shares the card tooltip format', await until(identityTooltip('보내기 담당 · codex-1', 'Codex', 'codex-1')))
    await driver.move(20, 45)
    const [cardX, cardY] = await driver.center(card('codex-1'))
    const linePath = `document.querySelector('.agent-message-map-line')?.getAttribute('d')`
    const originalPath = await js(linePath)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cardX, y: cardY, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardX + 30, y: cardY - 24, button: 'left', buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cardX + 30, y: cardY - 24, button: 'left', clickCount: 1 })
    check('dragging an agent moves its card and the attached edge without changing the selected conversation', await until(`
      ${card('codex-1')}.getBoundingClientRect().x + ${card('codex-1')}.offsetWidth / 2 > ${cardX + 20} &&
      ${linePath} !== ${JSON.stringify(originalPath)} && ${archivedEdge}?.getAttribute('aria-pressed') === 'true'
    `))

    // The relationship map: a dragged card is remembered, 크게 보기, zoom, fit, pan, the folding panel, reset
    const mapViewport = `document.querySelector('.agent-message-map-viewport')`
    const mapCanvas = `document.querySelector('.agent-message-map-canvas')`
    const zoomLabel = `document.querySelector('.agent-message-map-zoom')?.textContent.trim()`
    const mapControl = label => `document.querySelector('.agent-message-map-controls [aria-label="${label}"]')`
    const cardPlace = id => `(${card(id)}?.style.left ?? '') + ',' + (${card(id)}?.style.top ?? '')`
    const movedPlace = await js(cardPlace('codex-1'))
    check('a dragged card is kept as placed', await js(`${card('codex-1')}.dataset.placed === 'true' && ${card('claude-2')}.dataset.placed === 'false'`))
    await closeMessages()
    await until(`!${dialog}`)
    await js(`document.querySelector('[aria-label="codex-1 메시지함"]').click()`)
    check('closing and opening the messages keeps the card where it was put', await until(`${cardPlace('codex-1')} === ${JSON.stringify(movedPlace)}`),
      `${movedPlace} → ${await js(cardPlace('codex-1'))}`)
    const smallWidth = await js(`${dialog}.getBoundingClientRect().width`)
    await driver.click(...await driver.center(`document.querySelector('.agent-messages-large')`))
    check('크게 보기 fills the app window and is remembered', await until(`(() => {
      const box = ${dialog}.getBoundingClientRect()
      return box.width > ${smallWidth} && box.width >= innerWidth - 40 && box.height >= innerHeight - 40 &&
        document.querySelector('.agent-messages-large').getAttribute('aria-pressed') === 'true' &&
        localStorage.getItem('ezshell.agentMessageMapLarge') === '1'
    })()`))
    const zoomBefore = await js(zoomLabel)
    await driver.click(...await driver.center(mapControl('확대')))
    check('확대 steps the map zoom up', await until(`parseInt(${zoomLabel}) > ${parseInt(zoomBefore)}`), `${zoomBefore} → ${await js(zoomLabel)}`)
    const appScale = await js(`window.devicePixelRatio`)
    const zoomedLabel = await js(zoomLabel)
    const [viewX, viewY] = await driver.center(mapViewport)
    for (let i = 0; i < 3; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: viewX, y: viewY, deltaX: 0, deltaY: -120, modifiers: 2 })
      await sleep(60)
    }
    check('Ctrl+wheel over the map zooms the map, not the app', await until(`parseInt(${zoomLabel}) > ${parseInt(zoomedLabel)} && window.devicePixelRatio === ${appScale}`),
      `${zoomedLabel} → ${await js(zoomLabel)}`)
    await js(`${mapViewport}.focus()`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, modifiers: 2 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, modifiers: 2 })
    const allCardsInside = `(() => {
      const view = ${mapViewport}.getBoundingClientRect()
      return [...document.querySelectorAll('.agent-message-map-card')].every(card => {
        const box = card.getBoundingClientRect()
        return box.left >= view.left - 1 && box.right <= view.right + 1 && box.top >= view.top - 1 && box.bottom <= view.bottom + 1
      })
    })()`
    check('Ctrl+0 fits every card inside the map and leaves the app zoom alone', await until(`${allCardsInside} && window.devicePixelRatio === ${appScale}`))
    const fittedTransform = await js(`${mapCanvas}.style.transform`)
    const panFrom = await js(`(() => { const view = ${mapViewport}.getBoundingClientRect(); return [view.left + 8, view.top + 8] })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: panFrom[0], y: panFrom[1], button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panFrom[0] + 70, y: panFrom[1] + 40, button: 'left', buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panFrom[0] + 70, y: panFrom[1] + 40, button: 'left', clickCount: 1 })
    check('dragging empty space moves the whole map, not a card', await until(`${mapCanvas}.style.transform !== ${JSON.stringify(fittedTransform)} && ${cardPlace('codex-1')} === ${JSON.stringify(movedPlace)}`))
    const mapWidth = await js(`${mapViewport}.getBoundingClientRect().width`)
    await driver.click(...await driver.center(mapControl('메시지 패널 접기')))
    check('folding the message panel gives the map the full width', await until(`
      document.querySelector('.agent-message-map-detail').hidden && ${mapViewport}.getBoundingClientRect().width > ${mapWidth} + 150 &&
      !!${mapControl('메시지 패널 펼치기')}
    `))
    await driver.shot('local-agent-message-map-large')
    await driver.click(...await driver.center(`${cardPick('claude-2')}.querySelector('strong')`))
    check('choosing a card opens the folded panel with its messages', await until(`
      !document.querySelector('.agent-message-map-detail').hidden && ${cardPick('claude-2')}.getAttribute('aria-pressed') === 'true'
    `))
    await driver.click(...await driver.center(mapControl('배치 초기화')))
    check('배치 초기화 returns moved cards to the automatic places', await until(`${card('codex-1')}.dataset.placed === 'false' && ${allCardsInside}`))
    const keptZoom = await js(zoomLabel)
    await closeMessages()
    await until(`!${dialog}`)
    await js(`document.querySelector('[aria-label="codex-1 메시지함"]').click()`)
    check('the map opens again large, at the zoom it was left at, with the automatic places', await until(`
      ${zoomLabel} === ${JSON.stringify(keptZoom)} && ${dialog}?.dataset.large === 'true' && ${card('codex-1')}?.dataset.placed === 'false'
    `), `${keptZoom} → ${await js(zoomLabel)}`)
    await driver.click(...await driver.center(`document.querySelector('.agent-messages-large')`))
    await until(`${dialog}.dataset.large === 'false' && localStorage.getItem('ezshell.agentMessageMapLarge') === '0'`)
    await driver.click(...await driver.center(card('claude-2')))
    await driver.click(...await driver.center(archivedEdge))
    await until(`${archivedEdge}?.getAttribute('aria-pressed') === 'true'`)
    await driver.click(...await driver.center(card('codex-1')))
    check('selecting an agent card restores the agent’s full thread', await until(`
      ${cardPick('codex-1')}.getAttribute('aria-pressed') === 'true' &&
      ['note-for-user', 'review-please', 'hello-manual-claude'].every(text => ${messageTexts}.includes(text)) &&
      ${subject}?.textContent === '보내기 담당 · codex-1 의 메시지' &&
      ${subjectLocation}?.querySelector('.agent-message-pane-number')?.textContent.match(/^ · [0-9]+$/) &&
      ${bubbleLabel('review-please')}?.textContent === '보내기 담당'
    `))
    await driver.move(20, 45)
    await driver.shot('local-agent-messages-selected-agent')
    await js(`${subjectLocation}.querySelector('[data-action=go]').click()`)
    check('the heading action opens the exact live terminal pane by shell ID', await until(`
      !${dialog} && !!document.activeElement?.closest('[data-local-shell-id]')?.querySelector('[aria-label="codex-1 메시지함"]')
    `))
    await js(`document.querySelector('[aria-label="codex-1 메시지함"]').click()`)
    await showView('목록')
    check('the list keeps Close visible and scrolls the thread when it fills the dialog', await until(`(() => {
      const thread = ${dialog}.querySelector('.agent-message-thread')
      return thread.scrollHeight > thread.clientHeight &&
        ${dialog}.querySelector('.modal-actions button').getBoundingClientRect().bottom <= ${dialog}.getBoundingClientRect().bottom
    })()`))
    await driver.shot('local-agent-messages-roles-list')
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
    check('a roleless agent heading uses its ID and puts location below', await until(`
      ${subject}?.textContent === 'claude-7 의 메시지' &&
      ${subjectLocation}?.firstElementChild.textContent === 'other workspace · 1'
    `))
    await openFilter()
    check('the second project only offers its agents in the filter', await js(`
      ${filterOptions}.map(${optionId}).join(',') === '전체,codex-6,claude-7'
    `))
    await chooseAgent('전체')
    await showView('관계도')
    check('connected agents without messages appear as isolated cards in the current project', await until(`
      ${card('codex-6')}?.querySelector('.agent-message-map-card-name strong')?.textContent === 'codex-6' &&
      ${card('claude-7')}?.querySelector('.agent-message-map-card-name strong')?.textContent === 'claude-7' &&
      ${card('claude-7')}?.querySelector('.agent-message-map-card-folder > span')?.textContent === 'other workspace' &&
      ${card('claude-7')}?.querySelector('.agent-message-map-card-folder > small')?.textContent === '1' &&
      !${card('claude-7')}?.querySelector('.agent-message-map-card-meta > small') &&
      !${card('codex-1')} && ${edges}.length === 0
    `))
    fs.writeFileSync(file('claude-7-program-status'), 'state=idle:app=claude')
    await until(`${cardStatus('claude-7')}?.dataset.status === 'idle'`)
    await driver.move(...await driver.center(`${card('claude-7')}.querySelector('.agent-message-map-card-name strong')`))
    check('the roleless card tooltip contains the ID and the location once', await until(identityTooltip('claude-7', 'Claude Code'), 3000) &&
      // No "where the state came from" note on the state line (user, 2026-11-25)
      await js(`${tooltip}?.textContent === 'claude-7\\nClaude Code · 쉼\\nother workspace'`))
    await driver.shot('local-agent-message-map-tooltip-id')
    await driver.move(20, 45)
    const otherMessage = await mcp('codex-6', 'send_message', { to: 'claude-7', text: 'other-workspace-message' })
    check('an unread arrival adds a highlighted directional edge to the open map', await until(`
      ${edges}.length === 1 && ${edges}[0].dataset.unread === 'true' && ${edges}[0].getAttribute('aria-label').includes('codex-6 → claude-7, 1개, 안 읽음 1개')
    `))
    await js(`${edges}[0].click()`)
    check('the roleless edge heading shows the two IDs around its double arrow', await until(`
      document.querySelector('.agent-message-participants')?.textContent === 'claude-7 ⇄ codex-6'
    `))
    await mcp('claude-7', 'read_inbox', {})
    check('the map drops the highlight immediately when the agent reads the message', await until(`
      ${edges}[0].dataset.unread === 'false' && ${edges}[0].getAttribute('aria-label').includes('읽음·답 없음 1개') &&
      ${messageTexts}.join(',') === 'other-workspace-message'
    `))
    await mcp('claude-7', 'acknowledge_message', { message_id: otherMessage.id })
    check('the open map updates the direction to answered', await until(`
      ${edges}[0].getAttribute('aria-label').includes('답함 1개')
    `))
    await send('Emulation.setDeviceMetricsOverride', { width: 740, height: 720, deviceScaleFactor: 1, mobile: false })
    check('a narrower window places the message thread below the map and keeps Close visible', await until(`
      document.querySelector('.agent-message-map-detail').getBoundingClientRect().top >=
      document.querySelector('.agent-message-map-viewport').getBoundingClientRect().bottom &&
      ${dialog}.querySelector('.modal-actions button').getBoundingClientRect().bottom <= ${dialog}.getBoundingClientRect().bottom
    `))
    await until(`!document.querySelector('.agent-delivery-notice')`, 3500)
    await driver.shot('local-agent-message-map-narrow')
    await send('Emulation.clearDeviceMetricsOverride')
    await showView('목록')
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
    check('a user-chosen lookalike role still shows the real agent ID in the conversation',
      await js(`window.electronAPI.agentMessageSetRole('codex-1', '나').then(result => result.success)`) && await until(`
        [...${dialog}.querySelectorAll('.agent-message-actor')].some(actor =>
          actor.querySelector('.agent-message-actor-name')?.textContent === '나' &&
          actor.querySelector('.agent-message-actor-id')?.textContent === 'codex-1')
      `))

    const bridgeFile = file('agent-message-connection')
    const entry = createEntry('aside', bridgeFile)
    const external = await js(`window.electronAPI.agentMessageMcpExternal('read')`)
    check('external MCP setup exposes only the configured bridge path and Aside kind', external.success &&
      external.environment === `EZSHELL_AGENT_BRIDGE_FILE=${bridgeFile}\nEZSHELL_AGENT_BRIDGE_KIND=aside`)
    const asideClient = new Client({ name: 'aside-e2e', version: '1' })
    try {
      await asideClient.connect(new StdioClientTransport({ ...entry, cwd: workspace, stderr: 'pipe' }))
      const aside = await waitFor(async () => (await js('window.electronAPI.agentMessagesSnapshot()')).agents
        .find(agent => agent.kind === 'aside' && agent.mcpConnected))
      if (!aside) throw new Error('Aside MCP did not register')
      check('external Aside has a polling instruction and no terminal association', aside.shellId === '' &&
        asideClient.getInstructions()?.includes('Check read_inbox at the start of a task and periodically'))
      await showView('관계도')
      check('the relationship map displays Aside with its ID and provider without a jump action', await until(`
        ${card(aside.id)}?.querySelector('strong')?.textContent === ${JSON.stringify(aside.id)} &&
        ${card(aside.id)}?.querySelector('[data-kind="aside"]') &&
        ${cardPick(aside.id)}?.getAttribute('aria-label').includes('Aside ·') &&
        !${card(aside.id)}?.querySelector('[data-action="go"]') && !${row(aside.id)}
      `))
      await js(`${cardPick(aside.id)}.click()`)
      await showView('목록')
      check('the list shows the same Aside identity without a pane action', await until(`
        ${subject}?.textContent === ${JSON.stringify(`${aside.id} 의 메시지`)} &&
        ${subject}?.querySelector('[data-kind="aside"]') && !${subjectLocation}
      `))
    } finally {
      await asideClient.close()
    }

    // Run last because the authenticated hook changes this fixture's status source.
    const codexSession = '01a1ec18-0000-7000-8000-000000000071'
    const stamp = new Date()
    const padDate = number => String(number).padStart(2, '0')
    const rollouts = file(path.join('codex-home', 'sessions', String(stamp.getFullYear()), padDate(stamp.getMonth() + 1), padDate(stamp.getDate())))
    fs.mkdirSync(rollouts, { recursive: true })
    fs.writeFileSync(path.join(rollouts, `rollout-${codexSession}.jsonl`), JSON.stringify({
      type: 'session_meta', payload: { id: codexSession, cwd: workspace, timestamp: stamp.toISOString() }
    }) + '\n')
    const codexSnapshot = 'window.electronAPI.agentMessagesSnapshot().then(state => state.agents.find(agent => agent.id === "codex-1"))'
    check('the rollout alone never assigns the role layout key', await until(`window.electronAPI.agentUsageState().then(reports =>
      reports.some(report => report.agentId === 'codex-1' && report.usage.sessionId === ${JSON.stringify(codexSession)}))`) &&
      !(await js(codexSnapshot)).layoutKey)
    const hookInput = file('codex-role-hook.json')
    fs.writeFileSync(hookInput, JSON.stringify({ hook_event_name: 'SessionStart', session_id: codexSession, source: 'startup' }))
    fs.writeFileSync(file('codex-1-command'), `"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_AGENT_HOOK_SCRIPT%" codex < "${hookInput}"`)
    const hookResult = await waitFor(() => read('codex-1-result'))
    if (hookResult) fs.unlinkSync(file('codex-1-result'))
    const roleRecord = () => JSON.parse(read('agent-roles.json') || '{}')[`codex:${codexSession}`]
    check('the matching hook and rollout persist both roles and expose only the layout key',
      Boolean(hookResult && JSON.parse(hookResult).exit === 0 && await waitFor(roleRecord)) &&
      roleRecord()?.user === '나' && roleRecord()?.agent === 'MCP 역할 갱신' &&
      await until(`(${codexSnapshot}).then(agent => !!agent?.layoutKey && !agent.resumeId && agent.role === '나')`),
      JSON.stringify(roleRecord()))

    await closeMessages()
    await until(`!${dialog}`)
    const terminal = `([...document.querySelectorAll('.local-terminal-pane .xterm')]
      .find(item => getComputedStyle(item).visibility === 'visible' && item.getBoundingClientRect().width > 0))`
    const openTerminalMenu = async () => {
      const point = await driver.center(terminal)
      if (!point) throw new Error('missing visible terminal for the copied text test')
      await driver.click(...point, 'right')
    }
    await js(`navigator.clipboard.writeText = async text => { window.copiedTextForAgent = text };
      navigator.clipboard.readText = async () => window.copiedTextForAgent`)
    const copyAction = `document.querySelector('.toast-success .toast-action')`
    const copiedDialog = `document.querySelector('.copied-text-agent-dialog')`
    const draft = `${copiedDialog}?.querySelector('textarea')`
    const select = `${copiedDialog}?.querySelector('select')`
    const sendButton = `${copiedDialog}?.querySelector('button[type=submit]')`
    const openCopiedDraft = async () => {
      await openTerminalMenu()
      await driver.pick('모두 선택')
      await openTerminalMenu()
      await driver.pick('복사')
      if (!(await until(`${copyAction}?.textContent === '에이전트에 보내기'`, 3500))) {
        throw new Error('missing copied text toast action')
      }
      const copied = await js('window.copiedTextForAgent')
      await js(`window.copiedTextForAgent = 'the clipboard changed after copying'`)
      await driver.click(...await driver.center(copyAction))
      return copied
    }
    const beforeCopy = await js(`window.electronAPI.agentMessagesSnapshot().then(state => state.messages.length)`)
    const canceledText = await openCopiedDraft()
    check('the copy toast opens the exact copied text and waits for a recipient', Boolean(canceledText?.includes('\n')) &&
      await until(`${draft}?.value === ${JSON.stringify(canceledText.replace(/\r\n?/g, '\n'))} && ${sendButton}.disabled`))
    await js(`${copiedDialog}.querySelector('button[type=button]').click()`)
    check('canceling the copied text draft leaves the inboxes alone', await until(`!${copiedDialog}`) &&
      await js(`window.electronAPI.agentMessagesSnapshot().then(state => state.messages.length === ${beforeCopy})`))

    const sentText = await openCopiedDraft()
    check('the copied text picker shows the active agent and its workspace', await until(`
      [...${select}.options].some(option => option.value === 'claude-7' && option.textContent.includes('other workspace'))
    `))
    await js(`(() => {
      const recipient = ${select}
      recipient.value = 'claude-7'
      recipient.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await driver.click(...await driver.center(sendButton))
    check('sending copied text delivers the captured original once to the chosen inbox', await until(`!${copiedDialog}`) &&
      (await mcp('claude-7', 'read_inbox')).messages.filter(message => message.from === 'user' && message.text === sentText).length === 1)
    check('the copied text IPC rejects missing agents, user as recipient, and oversized bodies', await js(`Promise.all([
      window.electronAPI.agentMessageSendCopiedText('codex-999', 'unknown'),
      window.electronAPI.agentMessageSendCopiedText('user', 'self'),
      window.electronAPI.agentMessageSendCopiedText('claude-7', 'x'.repeat(8001)),
    ]).then(results => results.every(result => !result.success))`))
  } finally {
    driver.close()
  }
}

run().then(finish).catch(error => {
  console.error(error)
  process.exitCode = 1
})
