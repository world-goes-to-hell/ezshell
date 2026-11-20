// Agent chat view (docs/plan/2026-11-19-agent-chat-view.md): every pane with an agent can show it as a
// chat at the same time, each with its own conversation, read from the agent's transcript file. Sending
// types into that agent's own composer. The fake agents and transcript folders: e2e/support/agentChatApp.js.
const fs = require('fs')
const http = require('node:http')
const path = require('path')
const { connect, createChecks, sleep, unlock, openLocalProject, pages } = require('../support/driver')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE
const file = name => path.join(profile, name)
const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : ''
const projects = path.join(profile, 'claude-home', 'projects', 'test')
const SESSIONS = ['5a6f0d9e-1b2c-4d3e-8f90-0a1b2c3d4e5f', '6b7a1e0f-2c3d-4e5f-9a01-1b2c3d4e5f60']
const line = value => JSON.stringify(value) + '\n'
const prompt = (uuid, text, timestamp = '2026-11-19T10:00:00Z') => line({ type: 'user', uuid, timestamp, message: { role: 'user', content: text } })
const answer = (uuid, text) => line({ type: 'assistant', uuid, timestamp: '2026-11-19T10:00:01Z', message: { id: uuid, role: 'assistant', content: [{ type: 'text', text }] } })
const toolUse = (uuid, id) => line({ type: 'assistant', uuid, message: { id: uuid, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } })

async function waitFor(test, tries = 160) {
  for (let index = 0; index < tries; index++) {
    const value = await test()
    if (value) return value
    await sleep(75)
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
  fs.writeFileSync(input, JSON.stringify({ session_id: sessionId, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, context_window: { used_percentage: 10, context_window_size: 1000000 } }))
  return inAgent(agent, `"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_AGENT_USAGE_SCRIPT%" < "${input}"`)
}

;(async () => {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  const { js, until, send, shot, click, center } = driver
  await unlock(driver)
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([profile]))})`)

  const PANES = `[...document.querySelectorAll('.local-terminal-tab')].filter(t => getComputedStyle(t).visibility !== 'hidden').flatMap(t => [...t.querySelectorAll(':scope > .local-terminal-pane')])`
  const pane = index => `${PANES}[${index}]`
  const cover = index => `${pane(index)}?.querySelector('.agent-chat-cover')`
  const coverText = index => js(`${cover(index)}?.querySelector('.agent-chat-log')?.textContent ?? ''`)
  async function pasteIntoChat(index) {
    await js(`${cover(index)}.querySelector('.agent-chat-input').focus()`)
    const key = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }

  // A Claude in a local tab, with its transcript
  await openLocalProject(driver)
  await until(`!!document.querySelector('#local-project-agent')`)
  await js(`(() => {
    const select = document.querySelector('#local-project-agent')
    select.value = 'claude'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await js(`document.querySelector('.local-project-dialog button[type=submit]').click()`)
  check('a Claude opens in a local tab', await until(`document.body.textContent.includes('fixture ready: claude-1')`, 30000))

  // The chat key in the terminal turns the pane into a chat
  await js(`${pane(0)}.querySelector('.xterm-helper-textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  check('Ctrl+Shift+F11 in the terminal shows its agent as a chat', await until(`!!${cover(0)}`, 5000))
  check('a chat without a transcript starts empty', await until(`${cover(0)}.querySelector('.agent-chat-empty')?.textContent === '대화가 시작되면 여기에 보입니다.'`, 5000))
  // The pane's own mail button is under the chat: the header has one to the agent's inbox
  check('the chat header has the agent\'s mail button after 터미널', await until(`(() => {
    const buttons = [...${cover(0)}.querySelectorAll('.agent-chat-head .agent-chat-head-btn')]
    return buttons.length === 2 && buttons[0].textContent.includes('터미널') && buttons[1].matches('.agent-chat-mail') && buttons[1].textContent.includes('메시지')
  })()`, 5000))
  await js(`${cover(0)}.querySelector('.agent-chat-mail').click()`)
  check('the mail button opens that agent\'s inbox', await until(`(document.querySelector('.agent-messages-dialog')?.textContent ?? '').includes('claude-1')`, 5000))
  await js(`document.querySelector('.agent-messages-dialog .modal-actions button').click()`)
  await until(`!document.querySelector('.agent-messages-dialog')`)
  await js(`${cover(0)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.insertText', { text: '첫 칸 질문' })
  await driver.enter()
  const firstSentAt = new Date().toISOString()
  check('the first prompt is shown before a transcript exists', await until(`
    ${cover(0)}.querySelector('.agent-chat-user')?.textContent === '첫 칸 질문' &&
    !${cover(0)}.querySelector('.agent-chat-empty')
  `, 1500))
  check('the log shows that a reply is being generated', await until(`
    ${cover(0)}.querySelector('.agent-chat-reply-progress')?.textContent.trim() === '답변 생성 중…'
  `, 3000) && await waitFor(() => read('claude-1-chat-sent') === '1'))

  const firstTranscript = path.join(projects, `${SESSIONS[0]}.jsonl`)
  fs.writeFileSync(firstTranscript, prompt('u1', '첫 칸 질문', firstSentAt) + answer('a1', '첫 칸 **답변**'))
  const reported = await reportSession('claude-1', SESSIONS[0])
  check('the fake Claude reports its session', reported.exit === 0, JSON.stringify(reported))
  check('the chat shows that agent\'s conversation from its transcript', await until(`(${cover(0)}?.textContent ?? '').includes('첫 칸 질문') && !!${cover(0)}.querySelector('.agent-chat-md strong')`, 8000), await coverText(0))
  check('the first transcript replaces the echo without duplicating it and clears reply progress', await until(`
    ${cover(0)}.querySelectorAll('.agent-chat-user').length === 1 &&
    !${cover(0)}.querySelector('.agent-chat-reply-progress')
  `, 3000))
  const setChatDraft = text => js(`(() => {
    const input = ${cover(0)}.querySelector('.agent-chat-input')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await setChatDraft('가'.repeat(16001))
  await js(`${cover(0)}.querySelector('.agent-chat-send').click()`)
  check('a rejected send restores the draft and removes its optimistic bubble', await until(`
    [...document.querySelectorAll('.toast')].some(toast => toast.textContent.includes('보내지 못했습니다')) &&
    ${cover(0)}.querySelector('.agent-chat-input').value.length === 16001 &&
    ${cover(0)}.querySelectorAll('.agent-chat-user').length === 1 &&
    !${cover(0)}.querySelector('.agent-chat-reply-progress')
  `, 3000))
  await setChatDraft('')
  check('the conversation can be selected by dragging (the app turns selection off elsewhere)', await js(`getComputedStyle(${cover(0)}.querySelector('.agent-chat-log')).userSelect === 'text'`))

  // A file of this PC named in an answer opens from a menu on its link
  const note = file('linked-note.txt')
  fs.writeFileSync(note, '링크로 연 파일')
  fs.appendFileSync(path.join(projects, `${SESSIONS[0]}.jsonl`), answer('a-link', `메모는 [linked-note.txt](${note.replace(/\\/g, '/')}) 에 있습니다`))
  check('a link to a file of this PC shows as a link', await until(`!!${cover(0)}.querySelector('.agent-chat-md a[href$="linked-note.txt"]')`, 8000), await coverText(0))
  const link = await center(`${cover(0)}.querySelector('.agent-chat-md a[href$="linked-note.txt"]')`)
  await click(link[0], link[1])
  check('clicking it offers to open it in ezShell or the file manager', await until(`(() => {
    const labels = [...document.querySelectorAll('.terminal-menu-item')].map(item => item.textContent.trim())
    return labels.includes('ezShell 에서 열기') && labels.includes('파일 탐색기에서 열기') && labels.includes('경로 복사')
  })()`, 4000))
  await driver.pick('ezShell 에서 열기')
  let fileWindow = null
  for (let tries = 0; tries < 60 && !fileWindow; tries++) {
    fileWindow = (await pages()).find(page => /remoteFileMode=true/.test(page.url))
    if (!fileWindow) await sleep(150)
  }
  check('ezShell opens the file in its file window', !!fileWindow, JSON.stringify((await pages()).map(page => page.url)))
  const refused = await js(`window.electronAPI.agentChatOpenLink(${JSON.stringify(await js(`${pane(0)}.dataset.localShellId`))}, 'C:/Windows/win.ini', 'app')`)
  check('a path that was not in the conversation is not opened', refused && refused.ok === false && refused.error.includes('대화에 나온'), JSON.stringify(refused))
  // As the agents write them: Codex adds the line ("…/lines.txt:3"), Claude writes a path relative to its folder
  const lines = file('linked-lines.txt')
  fs.writeFileSync(lines, ['하나', '둘', '셋', '넷', '다섯'].join('\n'))
  fs.appendFileSync(path.join(projects, `${SESSIONS[0]}.jsonl`), answer('a-line-link', `셋째 줄은 [lines.txt:3](${lines.replace(/\\/g, '/')}:3), 같은 폴더의 [메모](linked-note.txt) 도 보세요`))
  check('a relative link of an answer shows as a link', await until(`!!${cover(0)}.querySelector('.agent-chat-md a[href="linked-note.txt"]')`, 8000), await coverText(0))
  const shellOfChat = await js(`${pane(0)}.dataset.localShellId`)
  const lineOpen = await js(`window.electronAPI.agentChatOpenLink(${JSON.stringify(shellOfChat)}, ${JSON.stringify(lines.replace(/\\/g, '/') + ':3')}, 'app')`)
  check('a link with a line opens the file (the line is not part of its name)', lineOpen?.ok === true, JSON.stringify(lineOpen))
  const relativeOpen = await js(`window.electronAPI.agentChatOpenLink(${JSON.stringify(shellOfChat)}, 'linked-note.txt', 'app')`)
  check('a relative link opens against the agent\'s folder', relativeOpen?.ok === true, JSON.stringify(relativeOpen))
  check('the terminal stays mounted under the chat', await js(`!!${pane(0)}.querySelector('.xterm-screen') && ${pane(0)}.querySelector('.xterm-screen').offsetWidth > 0`))
  const firstShell = await js(`${pane(0)}.dataset.localShellId`)

  const web = http.createServer((_request, response) => response.end('Chat web link'))
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve))
  try {
    const address = `http://127.0.0.1:${web.address().port}/chat-link?q=1#part`
    fs.appendFileSync(firstTranscript, answer('web-link', `[웹 미리보기](${address})`))
    const anchor = `${cover(0)}.querySelector('.agent-chat-md a[href="${address}"]')`
    await until(`!!${anchor}`, 8000)
    await driver.send('Page.bringToFront')
    await click(...await center(anchor))
    check('the chat web menu offers ezShell, the default browser, and copying', await until(`(() => {
      const labels = [...document.querySelectorAll('.terminal-menu-item')].map(item => item.textContent.trim())
      return labels.includes('ezShell 브라우저에서 열기') && labels.includes('브라우저에서 열기') && labels.includes('주소 복사')
    })()`))
    await driver.pick('ezShell 브라우저에서 열기')
    check('the chat link opens a new internal tab at the original address', await until(`(() => {
      const id = document.querySelector('.terminal-tab.active[data-tab-id^="browser:"]')?.dataset.tabId
      return id && window.electronAPI.browserReviewState(id).then(state => state.url === ${JSON.stringify(address)} && !state.loading)
    })()`))
    const unlisted = await js(`window.electronAPI.agentChatOpenLink(
      ${JSON.stringify(firstShell)}, ${JSON.stringify(address + 'unknown')}, 'browser-tab')`)
    check('the internal opener still requires a link from the conversation', unlisted?.ok === false)
    await js(`document.querySelector('.terminal-tab.active[data-tab-id^="browser:"] .tab-close').click()`)
    await until(`!!${cover(0)}`)
  } finally {
    web.close()
  }

  // A second pane with its own Claude, typed into its shell
  await js(`document.querySelector('.agent-chat-head-btn').click()`)
  await until(`!${cover(0)}`, 3000)
  const r = await js(`(() => { const b = ${pane(0)}.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2] })()`)
  await driver.menuPick(r[0], r[1], '분할', '좌우 분할')
  check('the tab splits into two panes', await until(`${PANES}.length === 2 && /PS [A-Z]:/.test(${pane(1)}.textContent)`, 60000))
  const secondShell = await js(`${pane(1)}.dataset.localShellId`)
  await js(`window.electronAPI.localShellWrite(${JSON.stringify(secondShell)}, 'claude\\r')`)
  check('a Claude typed into the second pane binds to that shell', await until(`
    window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent => agent.shellId === ${JSON.stringify(secondShell)} && agent.active && agent.kind === 'claude'))
  `, 30000), read('manual-claude-mcp-error'))
  fs.writeFileSync(path.join(projects, `${SESSIONS[1]}.jsonl`), prompt('u1', '둘째 칸 질문') + toolUse('a1', 'toolu_1'))
  await reportSession('manual-claude', SESSIONS[1])

  // Both panes as chats at once (Orca allows one per tab)
  for (const index of [0, 1]) {
    const box = await js(`(() => { const b = ${pane(index)}.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2] })()`)
    await click(box[0], box[1], 'right')
    await until(`[...document.querySelectorAll('.terminal-menu-item')].some(i => i.textContent.startsWith('채팅으로 보기 ('))`, 4000)
    const item = await center(`[...document.querySelectorAll('.terminal-menu-item')].find(i => i.textContent.startsWith('채팅으로 보기 ('))`)
    await click(item[0], item[1])
    await until(`!!${cover(index)}`, 5000)
  }
  check('both panes of the tab show their chats at the same time', await until(`!!${cover(0)} && !!${cover(1)}`, 5000))
  check('each chat shows its own conversation', await until(`(${cover(0)}.textContent.includes('첫 칸 질문') && !${cover(0)}.textContent.includes('둘째 칸')) &&
    (${cover(1)}.textContent.includes('둘째 칸 질문') && !${cover(1)}.textContent.includes('첫 칸'))`, 8000), JSON.stringify([await coverText(0), await coverText(1)]))
  check('a tool call without its result shows as running', await js(`${cover(1)}.querySelector('.agent-chat-tool')?.textContent.includes('실행 중')`))
  await shot('local-agent-chat-two-panes')

  // A result appended to the transcript shows up
  fs.appendFileSync(path.join(projects, `${SESSIONS[1]}.jsonl`), line({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '12 passed' }] } }) + answer('a2', '테스트가 통과했습니다'))
  check('what the agent writes next appears in its chat', await until(`${cover(1)}.textContent.includes('테스트가 통과했습니다') && !${cover(1)}.querySelector('.agent-chat-tool').textContent.includes('실행 중')`, 8000), await coverText(1))

  // Sending from the first chat types into that agent's composer only
  await js(`${cover(0)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.insertText', { text: '다음 할 일은?' })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  check('the line reaches the first agent\'s composer and is entered', await waitFor(() => read('claude-1-chat-sent') === '2'), read('claude-1-chat-text'))
  check('it is exactly what was written', read('claude-1-chat-text') === '다음 할 일은?', JSON.stringify(read('claude-1-chat-text')))
  check('the second agent got nothing', !read('manual-claude-chat-text'))
  check('the box is cleared after sending', await until(`${cover(0)}.querySelector('.agent-chat-input').value === ''`, 3000))
  const plain = fs.existsSync(file(String(firstShell).replace(':', '-') + '-input')) ? fs.readFileSync(file(String(firstShell).replace(':', '-') + '-input'), 'utf8') : ''
  check('the line did not go through the terminal\'s own input', !plain.includes('다음 할 일은?'))
  // Not in the transcript yet (Claude writes a slash command only when it is done): a look at the
  // terminal and back keeps it shown (2026-11-20 user report: a /compact sent from the chat vanished)
  check('the sent line shows in the chat at once', await until(`[...${cover(0)}.querySelectorAll('.agent-chat-user')].some(bubble => bubble.textContent.includes('다음 할 일은?'))`, 3000), await coverText(0))
  await js(`${cover(0)}.querySelector('.agent-chat-head-btn').click()`)
  await until(`!${cover(0)}`, 3000)
  await js(`${pane(0)}.querySelector('.xterm-helper-textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  check('after a look at the terminal, the line not yet in the transcript is still shown', await until(`!!${cover(0)} && (${cover(0)}.textContent.includes('첫 칸 질문')) && [...${cover(0)}.querySelectorAll('.agent-chat-user')].some(bubble => bubble.textContent.includes('다음 할 일은?'))`, 8000), await coverText(0))

  // The fixture provides an actual PNG from the main-process clipboard, like Windows Snipping Tool.
  const preview = `${cover(0)}.querySelector('.agent-chat-attachment img')`
  const sendButton = `${cover(0)}.querySelector('.agent-chat-send')`
  const chatFeedback = () => js(`[...document.querySelectorAll('.toast')].map(toast => toast.textContent).join(' ')`)
  await pasteIntoChat(0)
  check('Ctrl+V shows a decoded screenshot preview in the focused chat', await until(`${preview}?.naturalWidth === 1`))
  check('pasting leaves the screenshot in the draft', read('claude-1-chat-sent') === '2')
  check('the other chat has no attachment', await js(`!${cover(1)}.querySelector('.agent-chat-attachment')`))
  await js(`${cover(0)}.querySelector('[aria-label="이미지 첨부 제거"]').click()`)
  check('removing the image disables send for an empty draft', await until(`!${preview} && ${cover(0)}.querySelector('.agent-chat-send').disabled`))
  await pasteIntoChat(0)
  await until(`${preview}?.naturalWidth === 1`)
  fs.writeFileSync(file('clipboard-text'), '클립보드 텍스트')
  await pasteIntoChat(0)
  check('text paste still fills the draft and retains the screenshot', await until(`${preview}?.naturalWidth === 1 &&
    ${cover(0)}.querySelector('.agent-chat-input').value === '클립보드 텍스트' && !${sendButton}.disabled`))
  await js(`${sendButton}.click()`)
  check('sending delivers the screenshot reference and the message text to the selected agent', await waitFor(() => {
    if (read('claude-1-chat-sent') !== '3') return false
    const [, attachment, , body] = read('claude-1-chat-text').split('\n')
    return body === '클립보드 텍스트' && attachment?.endsWith('.png') && fs.existsSync(attachment)
      && fs.readFileSync(attachment).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  }), `${read('claude-1-chat-text')} ${await chatFeedback()}`)
  check('the draft preview is cleared after sending', await until(`!${preview} && !${cover(0)}.querySelector('.agent-chat-input').value`))
  fs.unlinkSync(file('clipboard-text'))
  await pasteIntoChat(0)
  await until(`${preview}?.naturalWidth === 1 && !${sendButton}.disabled`)
  await js(`${sendButton}.click()`)
  check('a screenshot can be sent without any text', await waitFor(() => read('claude-1-chat-sent') === '4'
    && read('claude-1-chat-text').split('\n').length === 2 && read('claude-1-chat-text').endsWith('.png')), await chatFeedback())

  // A permission prompt in the terminal shows as choices in the chat, and a choice answers it
  fs.writeFileSync(file('claude-1-approval'), '─'.repeat(60) + '\r\n Bash command\r\n\r\n   npm run build\r\n\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and don\'t ask again for npm run build commands\r\n   3. No, and tell Claude what to do differently (esc)')
  check('the prompt shows in the chat with its question, command and choices', await until(`(() => {
    const card = ${cover(0)}?.querySelector('.agent-chat-approval')
    return !!card && card.textContent.includes('Do you want to proceed?') && card.textContent.includes('npm run build') &&
      card.querySelectorAll('.agent-chat-approval-option').length === 3 && !${cover(0)}.querySelector('.agent-chat-input')
  })()`, 8000), await js(`${cover(0)}?.querySelector('.agent-chat-approval')?.textContent ?? 'no card'`))
  check('the other pane\'s chat shows no prompt', await js(`!${cover(1)}.querySelector('.agent-chat-approval')`))
  await shot('local-agent-chat-approval')
  const second = await center(`${cover(0)}.querySelectorAll('.agent-chat-approval-option')[1]`)
  await click(second[0], second[1])
  check('choosing answers the prompt with that number', await waitFor(() => read('claude-1-approval-answer') === '2'), read('claude-1-approval-answer'))
  check('the composer comes back once the prompt is gone', await until(`!${cover(0)}.querySelector('.agent-chat-approval') && !!${cover(0)}.querySelector('.agent-chat-input')`, 8000))

  // Back to the terminal with the key, from the chat box
  await js(`${cover(0)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  check('the key in the chat goes back to the terminal and focuses it', await until(`!${cover(0)} && !!${cover(1)} && document.activeElement?.classList.contains('xterm-helper-textarea') && !!document.activeElement.closest('[data-local-shell-id="${firstShell}"]')`, 3000))

  // A window reload brings the tab back as it was: the pane that was a chat is a chat again, the other a terminal
  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('after a reload the split tab is back with its two shells', await until(`${PANES}.length === 2 &&
    ${pane(0)}.dataset.localShellId === ${JSON.stringify(firstShell)} && ${pane(1)}.dataset.localShellId === ${JSON.stringify(secondShell)}`, 15000))
  check('the pane that was a chat shows its chat again, the other stays a terminal', await until(`!!${cover(1)} && !${cover(0)}`, 10000))
  check('the restored chat shows its conversation', await until(`(${cover(1)}?.textContent ?? '').includes('둘째 칸 질문')`, 8000), await coverText(1))

  // Dropping the MCP child leaves the manually started CLI and its transcript running.
  const manualAgent = await js(`window.electronAPI.agentMessagesSnapshot().then(state =>
    state.agents.find(agent => agent.shellId === ${JSON.stringify(secondShell)} && agent.active).id)`)
  const manualState = connected => `window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent =>
    agent.id === ${JSON.stringify(manualAgent)} && agent.shellId === ${JSON.stringify(secondShell)} && agent.active && agent.mcpConnected === ${connected}))`
  fs.writeFileSync(file('manual-claude-mcp-disconnect'), '')
  check('MCP disconnects while the manually started Claude remains active', await until(manualState(false)))
  fs.appendFileSync(path.join(projects, `${SESSIONS[1]}.jsonl`), answer('a3', '연결이 끊겨도 새 답변을 표시합니다.'))
  check('the chat still follows the transcript and offers an input box', await until(`
    ${cover(1)}?.textContent.includes('연결이 끊겨도 새 답변을 표시합니다.') && !!${cover(1)}.querySelector('.agent-chat-input')
  `))
  await js(`${cover(1)}.querySelector('.agent-chat-head-btn').click()`)
  await until(`!${cover(1)}`)
  const [rightX, rightY] = await center(pane(1))
  await click(rightX, rightY, 'right')
  const chatMenu = `[...document.querySelectorAll('.terminal-menu-item')].find(item => item.textContent.startsWith('채팅으로 보기 ('))`
  check('the terminal menu can reopen the disconnected agent’s chat', await until(`!!${chatMenu} && !${chatMenu}.hasAttribute('data-disabled')`))
  await js(`${chatMenu}.click()`)
  check('the reopened chat shows the same conversation', await until(`${cover(1)}?.textContent.includes('연결이 끊겨도 새 답변을 표시합니다.')`))
  await js(`${cover(1)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.insertText', { text: '연결 없이 질문' })
  await js(`${cover(1)}.querySelector('.agent-chat-send').click()`)
  check('chat input still reaches only the live Claude composer', await waitFor(() =>
    read('manual-claude-chat-sent') === '1' && read('manual-claude-chat-text') === '연결 없이 질문'))
  fs.writeFileSync(file('manual-claude-mcp-reconnect'), '')
  check('reconnecting MCP restores the same agent ID', await until(manualState(true)), read('manual-claude-mcp-error'))

  // The second agent ends: its chat says so and stops taking input
  fs.writeFileSync(file('manual-claude-exit-code'), '0')
  check('when the agent ends its chat says so and has no text box', await until(`${cover(1)}.textContent.includes('종료되었습니다') && !${cover(1)}.querySelector('.agent-chat-input')`, 15000), await js(`${cover(1)}?.textContent.slice(-120)`))
  check('the PowerShell pane stays open after its Claude process exits', await until(`
    window.electronAPI.localShellAttach(${JSON.stringify(secondShell)}).then(state => state?.exited === false)
  `))
  check('no transcript path reached the window', await js(`!document.body.innerHTML.includes('claude-home')`))

  // Locking drops every conversation
  await js(`document.activeElement?.blur(); document.body.focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 2 })
  check('locking the app removes the chats', await until(`document.querySelectorAll('input[type=password]').length > 0 && !document.querySelector('.agent-chat-cover')`, 8000))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
