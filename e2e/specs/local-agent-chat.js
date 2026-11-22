// Agent chat view (docs/plan/2026-11-19-agent-chat-view.md): every pane with an agent can show it as a
// chat at the same time, each with its own conversation, read from the agent's transcript file. Sending
// types into that agent's own composer. The fake agents and transcript folders: e2e/support/agentChatApp.js.
const fs = require('fs')
const http = require('node:http')
const path = require('path')
const { connect, createChecks, sleep, unlock, openLocalAgent, pages } = require('../support/driver')

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
async function reportSession(agent, sessionId, rateLimits = undefined) {
  const input = file(agent + '-status.json')
  fs.writeFileSync(input, JSON.stringify({ session_id: sessionId, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, context_window: { used_percentage: 10, context_window_size: 1000000 }, ...(rateLimits ? { rate_limits: rateLimits } : {}) }))
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
  const composer = index => `${cover(index)}?.querySelector('.agent-chat-input')`
  const focusedChat = index => `(() => {
    const input = ${composer(index)}
    if (!input || document.activeElement !== input) return false
    const outline = getComputedStyle(${pane(index)}, '::before')
    return outline.borderTopWidth === '2px' && outline.borderTopColor === getComputedStyle(input).borderTopColor
  })()`
  const coverText = index => js(`${cover(index)}?.querySelector('.agent-chat-log')?.textContent ?? ''`)
  const chatThemeButton = index => `${cover(index)}.querySelector('.agent-chat-theme-trigger')`
  async function chooseChatTheme(index, label) {
    await click(...await center(chatThemeButton(index)))
    const option = `[...document.querySelectorAll('.select-menu-content [role="menuitemradio"]')]
      .find(item => item.textContent.trim() === ${JSON.stringify(label)})`
    if (!(await until(`!!${option}`, 3000))) throw new Error(`chat theme missing: ${label}`)
    await js(`(${option}).scrollIntoView({ block: 'nearest' })`)
    await click(...await center(`(${option})`))
  }
  async function pasteIntoChat(index) {
    await js(`${cover(index)}.querySelector('.agent-chat-input').focus()`)
    const key = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }

  async function openAgent(kind) {
    await openLocalAgent(driver, kind, profile)
  }

  // A Claude in a local tab, with its transcript
  await openAgent('claude')
  check('a Claude opens in a local tab', await until(`document.body.textContent.includes('fixture ready: claude-1')`, 30000))

  // The chat key in the terminal turns the pane into a chat
  await js(`${pane(0)}.querySelector('.xterm-helper-textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  check('Ctrl+Shift+F11 in the terminal shows its agent as a chat', await until(`!!${cover(0)}`, 5000))
  check('a chat without a transcript starts empty', await until(`${cover(0)}.querySelector('.agent-chat-empty')?.textContent === '대화가 시작되면 여기에 보입니다.'`, 5000))
  check('the focused composer gets a pane outline even in a single idle chat', await until(focusedChat(0), 2000))
  await js(`${pane(0)}.querySelector('.xterm-helper-textarea').focus()`)
  check('the terminal behind a chat cannot steal focus from the composer', await js(`document.activeElement === ${composer(0)}`))
  // The pane's own mail button is under the chat: the header has one to the agent's inbox
  check('the chat header has the agent\'s mail button after 터미널', await until(`(() => {
    const buttons = [...${cover(0)}.querySelectorAll('.agent-chat-head .agent-chat-head-btn')]
    return buttons.length === 3 && buttons[0].textContent.includes('터미널') && buttons[1].matches('.agent-chat-mail') &&
      buttons[1].textContent.includes('메시지') && buttons[2].textContent.includes('질문 목록')
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
  const filler = line({ type: 'attachment', attachment: { text: '한글'.repeat(1700) } })
  const receivedTask = { id: 'task-from-codex', from: 'codex-8', text: '릴리스 노트를 검토해 줘.\n누락 항목도 알려줘.' }
  const inboxResult = task => [{ type: 'text', text: JSON.stringify({ messages: [task] }) }]
  const claudeInbox = id => line({ type: 'assistant', uuid: id, message: {
    content: [{ type: 'tool_use', id, name: 'mcp__ezshell-cli-mcp__read_inbox', input: {} }]
  } }) + line({ type: 'user', uuid: `${id}-result`, message: {
    content: [{ type: 'tool_result', tool_use_id: id, content: inboxResult(receivedTask) }]
  } })
  fs.writeFileSync(firstTranscript, prompt('older-question', '오래된 배포 질문') + answer('older-answer', '예전 배포 답변') +
    prompt('wake', 'New ezShell message: read it with read_inbox, then handle it.') + claudeInbox('inbox-first') + claudeInbox('inbox-repeat') +
    answer('task-answer', '릴리스 노트 검토를 마쳤습니다.') + filler.repeat(450) + prompt('u1', '첫 칸 질문', firstSentAt) + answer('a1', '첫 칸 **답변**'))
  const reported = await reportSession('claude-1', SESSIONS[0])
  check('the fake Claude reports its session', reported.exit === 0, JSON.stringify(reported))
  check('the chat shows that agent\'s conversation from its transcript', await until(`(${cover(0)}?.textContent ?? '').includes('첫 칸 질문') && !!${cover(0)}.querySelector('.agent-chat-md strong')`, 8000), await coverText(0))
  check('the first transcript replaces the echo without duplicating it and clears reply progress', await until(`
    ${cover(0)}.querySelectorAll('.agent-chat-user').length === 1 &&
    !${cover(0)}.querySelector('.agent-chat-reply-progress')
  `, 3000))
  const appTheme = `document.documentElement.dataset.theme`
  const xtermColor = `getComputedStyle(${pane(0)}.querySelector('.local-terminal-host')).getPropertyValue('--terminal-background')`
  const beforeChatTheme = await js(`[${appTheme}, ${xtermColor}]`)
  await chooseChatTheme(0, '카톡 모드')
  check('Kakao chat has a yellow sent bubble, a white received bubble, and its own canvas', await until(`
    ${cover(0)}.dataset.chatTheme === 'chat-kakao' && getComputedStyle(${cover(0)}).backgroundColor === 'rgb(220, 232, 244)' &&
    getComputedStyle(${cover(0)}.querySelector('.agent-chat-user .agent-chat-bubble')).backgroundColor === 'rgb(255, 223, 98)' &&
    getComputedStyle(${cover(0)}.querySelector('.agent-chat-assistant')).backgroundColor === 'rgb(255, 255, 255)'
  `))
  check('changing the chat theme keeps the app and underlying xterm colors',
    JSON.stringify(await js(`[${appTheme}, ${xtermColor}]`)) === JSON.stringify(beforeChatTheme))
  await shot('local-agent-chat-kakao')
  await chooseChatTheme(0, '미드나잇')
  check('Midnight uses a dark canvas without touching the app theme', await until(`
    ${cover(0)}.dataset.chatTheme === 'chat-midnight' && getComputedStyle(${cover(0)}).colorScheme === 'dark' &&
    ${appTheme} === ${JSON.stringify(beforeChatTheme[0])}
  `))
  await chooseChatTheme(0, 'Nord')
  check('an existing app theme can be selected solely for the chat', await until(`
    ${cover(0)}.dataset.chatTheme === 'nord' && !${cover(0)}.hasAttribute('data-chat-bubbles') &&
    ${appTheme} === ${JSON.stringify(beforeChatTheme[0])}
  `))
  await chooseChatTheme(0, '앱 테마 따르기')
  check('following the app removes the local palette', await until(`!${cover(0)}.hasAttribute('data-chat-theme')`))
  const questionPanel = index => `${cover(index)}.querySelector('.agent-chat-questions')`
  const openQuestions = index => js(`${cover(index)}.querySelector('.agent-chat-questions-toggle').click()`)
  const pickQuestion = (index, text) => js(`[...${questionPanel(index)}.querySelectorAll('li button')]
    .find(button => button.textContent.includes(${JSON.stringify(text)}))?.click()`)
  await openQuestions(0)
  check('the question list includes an unloaded question from the same Claude transcript', await until(`
    ${questionPanel(0)}?.textContent.includes('오래된 배포 질문') &&
    !${cover(0)}.querySelector('.agent-chat-log').textContent.includes('오래된 배포 질문')
  `))
  await send('Input.insertText', { text: '배포' })
  check('question search hides unrelated questions', await until(`
    ${questionPanel(0)}.querySelectorAll('li').length === 1 && ${questionPanel(0)}.textContent.includes('오래된 배포 질문')
  `))
  await pickQuestion(0, '오래된 배포 질문')
  check('choosing the old question shows its original answer and highlights the question', await until(`
    ${cover(0)}.querySelector('[data-question-target]')?.textContent.includes('오래된 배포 질문') &&
    ${cover(0)}.querySelector('.agent-chat-log').textContent.includes('예전 배포 답변')
  `))
  await js(`${cover(0)}.querySelector('.agent-chat-question-location button').click()`)
  check('latest conversation returns from the old context to the active chat', await until(`
    !${cover(0)}.querySelector('.agent-chat-question-location') && ${cover(0)}.querySelector('.agent-chat-log').textContent.includes('첫 칸 질문')
  `))
  await openQuestions(0)
  await send('Input.insertText', { text: 'codex-8' })
  check('the archived task is searchable by sender and repeated reads yield one result', await until(`
    ${questionPanel(0)}.querySelectorAll('li').length === 1 && ${questionPanel(0)}.textContent.includes('받은 작업 · Codex 8')
    && !${questionPanel(0)}.textContent.includes('New ezShell message')
  `))
  await pickQuestion(0, '릴리스 노트를 검토해 줘.')
  check('choosing a received task shows its original body at the first inbox read', await until(`
    ${cover(0)}.querySelector('[data-question-target]')?.dataset.chatRow === 'item:tool:inbox-first'
    && ${cover(0)}.querySelector('[data-question-target] .agent-chat-received-message div')?.textContent === ${JSON.stringify(receivedTask.text)}
    && ${cover(0)}.querySelector('.agent-chat-log').textContent.includes('릴리스 노트 검토를 마쳤습니다.')
  `))
  await js(`${cover(0)}.querySelector('.agent-chat-question-location button').click()`)
  await until(`!${cover(0)}.querySelector('.agent-chat-question-location')`)
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

  // An answer pinned out into a small window of its own, read while working in another tab
  const pinnedAnswer = `[...${cover(0)}.querySelectorAll('.agent-chat-assistant')].find(item => item.textContent.includes('셋째 줄은'))`
  await driver.move(...await center(pinnedAnswer))
  const pinButton = `${pinnedAnswer}.querySelector('.agent-chat-pin')`
  check('an answer offers 띄워 두기 on hover', await until(`!!${pinButton} && getComputedStyle(${pinButton}).opacity === '1'`, 3000))
  await click(...await center(pinButton))
  let pinPage = null
  for (let tries = 0; tries < 60 && !pinPage; tries++) {
    pinPage = (await pages()).find(page => /pinnedReplyMode=true/.test(page.url))
    if (!pinPage) await sleep(150)
  }
  check('it opens the answer in a window of its own', !!pinPage, JSON.stringify((await pages()).map(page => page.url)))
  const pin = await connect(page => /pinnedReplyMode=true/.test(page.url))
  try {
    check('the window shows the answer as it was', await pin.until(`(document.querySelector('.pinned-reply-body')?.textContent ?? '').includes('셋째 줄은') && !!document.querySelector('.pinned-reply-body a[href="linked-note.txt"]')`, 5000))
    const pinLine = await pin.js(`window.electronAPI.pinnedReplyOpenLink(${JSON.stringify(lines.replace(/\\/g, '/') + ':3')}, 'app')`)
    check('a link of the pinned answer opens', pinLine?.ok === true, JSON.stringify(pinLine))
    // Not in this answer (its "메모" link names linked-note.txt, so that one opens)
    const pinRefused = await pin.js(`window.electronAPI.pinnedReplyOpenLink('C:/Windows/win.ini', 'app')`)
    check('a path not in the pinned answer does not open from it', pinRefused?.ok === false && pinRefused.error.includes('대화에 나온'), JSON.stringify(pinRefused))
    await click(...await center(pinButton))
    await sleep(400)
    check('pinning the same answer again keeps one window', (await pages()).filter(page => /pinnedReplyMode=true/.test(page.url)).length === 1)
    await pin.js(`document.querySelector('.pinned-reply-btn[data-action="fold"]').click()`)
    check('folding leaves only its header', await pin.until(`window.innerHeight <= 48 && !document.querySelector('.pinned-reply-body')`, 3000), await pin.js('window.innerHeight'))
    await pin.js(`document.querySelector('.pinned-reply-btn[data-action="fold"]').click()`)
    check('unfolding gives its height back', await pin.until(`window.innerHeight >= 120 && !!document.querySelector('.pinned-reply-body')`, 3000), await pin.js('window.innerHeight'))
    await js(`${cover(0)}.querySelector('.agent-chat-head-btn').click()`)
    await until(`!${cover(0)}`, 3000)
    await pin.js(`document.querySelector('.pinned-reply-btn[data-action="source"]').click()`)
    check('원래 대화로 가기 shows that pane as a chat again', await until(`!!${cover(0)}`, 5000))
    await pin.js(`document.querySelector('.pinned-reply-btn[data-action="close"]').click()`)
  } finally {
    pin.close()
  }
  let pinGone = false
  for (let tries = 0; tries < 30 && !pinGone; tries++) {
    pinGone = !(await pages()).some(page => /pinnedReplyMode=true/.test(page.url))
    if (!pinGone) await sleep(150)
  }
  check('closing it closes the window', pinGone)
  const firstShell = await js(`${pane(0)}.dataset.localShellId`)
  const firstTab = `.terminal-tab[data-tab-id=${JSON.stringify(await js(`${pane(0)}.dataset.localTabId`))}]`

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
    await js(`document.querySelector(${JSON.stringify(firstTab)}).click()`)
    check('returning to the chat tab focuses its composer and shows the pane outline', await until(focusedChat(0), 2500))
    await js(`document.querySelector('.terminal-tab[data-tab-id^="browser:"] .tab-close').click()`)
    await until(`!!${cover(0)}`)
  } finally {
    web.close()
  }

  // Split right from the chat and start a second Claude in the new shell.
  const chatLog = index => `${cover(index)}.querySelector('.agent-chat-log')`
  await driver.menuPick(...await center(chatLog(0)), '분할', '좌우 분할')
  check('splitting from chat adds a shell and keeps the original chat open', await until(`
    ${PANES}.length === 2 && /PS [A-Z]:/.test(${pane(1)}.textContent) && ${cover(0)}?.textContent.includes('첫 칸 질문')
  `, 60000))
  const secondShell = await js(`${pane(1)}.dataset.localShellId`)
  await js(`window.electronAPI.localShellWrite(${JSON.stringify(secondShell)}, 'claude\\r')`)
  check('a Claude typed into the second pane binds to that shell', await until(`
    window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent => agent.shellId === ${JSON.stringify(secondShell)} && agent.active && agent.kind === 'claude'))
  `, 30000), read('manual-claude-mcp-error'))
  fs.writeFileSync(path.join(projects, `${SESSIONS[1]}.jsonl`), prompt('u1', '둘째 칸 질문') + toolUse('a1', 'toolu_1'))
  await reportSession('manual-claude', SESSIONS[1])

  await click(...await center(pane(1)), 'right')
  const showChatItem = `[...document.querySelectorAll('.terminal-menu-item')].find(i => i.textContent.startsWith('채팅으로 보기 ('))`
  await until(`!!${showChatItem}`, 4000)
  await click(...await center(showChatItem))
  check('both panes of the tab show their chats at the same time', await until(`!!${cover(0)} && !!${cover(1)}`, 5000))
  check('each chat shows its own conversation', await until(`(${cover(0)}.textContent.includes('첫 칸 질문') && !${cover(0)}.textContent.includes('둘째 칸')) &&
    (${cover(1)}.textContent.includes('둘째 칸 질문') && !${cover(1)}.textContent.includes('첫 칸'))`, 8000), JSON.stringify([await coverText(0), await coverText(1)]))
  await click(...await center(composer(0)))
  check('the pane outline follows the clicked composer in a split chat', await until(`${focusedChat(0)} && !${pane(1)}.matches(':focus-within')`, 2500))
  check('a tool call without its result shows as running', await js(`${cover(1)}.querySelector('.agent-chat-tool')?.textContent.includes('실행 중')`))
  await shot('local-agent-chat-two-panes')

  // A result appended to the transcript shows up
  fs.appendFileSync(path.join(projects, `${SESSIONS[1]}.jsonl`), line({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '12 passed' }] } }) + answer('a2', '테스트가 통과했습니다'))
  check('what the agent writes next appears in its chat', await until(`${cover(1)}.textContent.includes('테스트가 통과했습니다') && !${cover(1)}.querySelector('.agent-chat-tool').textContent.includes('실행 중')`, 8000), await coverText(1))

  const subagents = index => `${cover(index)}?.querySelector('.agent-chat-subagents')`
  const subagentEntry = index => `${subagents(index)}?.querySelector('.agent-chat-subagents-entry')`
  const subagentPreview = "document.querySelector('.agent-chat-subagent-preview')"
  const delegation = 'toolu_delegate'
  const childId = 'abc123'
  const claudeChildFolder = path.join(projects, SESSIONS[1], 'subagents')
  const claudeChild = path.join(claudeChildFolder, `agent-${childId}.jsonl`)
  const claudeParent = path.join(projects, `${SESSIONS[1]}.jsonl`)
  fs.appendFileSync(claudeParent, line({ type: 'assistant', uuid: 'delegate', timestamp: new Date().toISOString(), message: {
    id: 'delegate', content: [{ type: 'tool_use', id: delegation, name: 'Agent', input: { subagent_type: 'Explore', description: '분할 테스트 검토' } }]
  } }))
  check('only the parent pane shows its running subagent in a collapsed summary', await until(`
    ${subagents(1)}?.querySelector('summary')?.textContent.includes('작업 중 1') &&
    !${subagents(1)}.open && !${subagents(0)}
  `, 8000))
  await js(`${subagents(1)}?.querySelector('summary')?.click()`)
  check('expanding the summary shows the subagent name and task', await until(`
    ${subagents(1)}?.open && ${subagents(1)}.querySelector('li strong').textContent === 'Explore' &&
    ${subagents(1)}.querySelector('.agent-chat-subagents-task').textContent === '분할 테스트 검토'
  `, 4000))
  fs.mkdirSync(claudeChildFolder, { recursive: true })
  fs.writeFileSync(path.join(claudeChildFolder, `agent-${childId}.meta.json`), JSON.stringify({ toolUseId: delegation }))
  fs.writeFileSync(claudeChild, line({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'Internal content' },
    { type: 'tool_use', name: 'WebSearch', input: { query: '분할 테스트 사례' } }
  ] } }))
  await driver.move(...await center(subagentEntry(1)))
  check('hovering Claude shows its running child tool from the metadata link', await until(`
    ${subagentPreview}?.textContent.includes('분할 테스트 사례') && !${subagentPreview}.textContent.includes('Internal content')
  `, 8000))
  fs.appendFileSync(claudeChild, line({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Read', input: { file_path: 'pane-layout.test.ts' } }
  ] } }))
  check('the subagent preview follows the child independently of parent chat output', await until(`
    ${subagentPreview}?.textContent.includes('pane-layout.test.ts')
  `, 8000))
  fs.appendFileSync(claudeChild, answer('child-result', '분할 테스트 검토를 마쳤습니다'))
  fs.appendFileSync(claudeParent, line({ type: 'user', uuid: 'delegate-started', toolUseResult: { agentId: childId, status: 'async_launched' }, message: {
    content: [{ type: 'tool_result', tool_use_id: delegation, content: 'Background agent launched' }]
  } }))
  fs.appendFileSync(claudeParent, prompt('delegate-ended', `<task-notification><task-id>${childId}</task-id><tool-use-id>${delegation}</tool-use-id><status>completed</status><summary>Agent finished</summary></task-notification>`, new Date().toISOString()))
  check('the Claude preview updates to the recorded child result', await until(`
    ${subagents(1)}?.querySelector('summary')?.textContent.includes('완료 1') &&
    ${subagentPreview}?.querySelector('.agent-chat-subagents-result')?.textContent === '분할 테스트 검토를 마쳤습니다'
  `, 8000))
  await shot('local-agent-chat-subagents')
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check('Escape closes the preview and keeps the subagents expanded', await until(`!${subagentPreview} && ${subagents(1)}.open`, 4000))
  await js(`${subagents(1)}?.querySelector('summary')?.click()`)

  // The tokens the question used, at the end of its turn (2026-11-21 user request)
  fs.appendFileSync(path.join(projects, `${SESSIONS[1]}.jsonl`), line({
    type: 'assistant', uuid: 'a-usage', timestamp: '2026-11-19T10:00:05Z',
    message: { id: 'm-usage', role: 'assistant', content: [{ type: 'text', text: '정리했습니다' }], usage: { input_tokens: 4, cache_creation_input_tokens: 2000, cache_read_input_tokens: 121000, output_tokens: 3412 } }
  }) + line({ type: 'system', subtype: 'turn_duration', durationMs: 52000, timestamp: '2026-11-19T10:00:06Z' }))
  const usageLine = `[...${cover(1)}.querySelectorAll('.agent-chat-usage')].map(line => line.textContent).join('|')`
  check('the turn shows the tokens it used under its last answer', await until(`
    ${usageLine} === '토큰 입력 12.3만 · 출력 3,412 · 캐시 98% · 52초' &&
    ${cover(1)}.querySelector('.agent-chat-assistant + .agent-chat-usage')?.previousElementSibling?.textContent.includes('정리했습니다')
  `, 8000), await js(usageLine))

  // Claude's windows come from its status line, before the question and after its last answer
  const windows = (fiveHour, sevenDay) => ({
    five_hour: { used_percentage: fiveHour, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    seven_day: { used_percentage: sevenDay, resets_at: Math.floor(Date.now() / 1000) + 86400 }
  })
  await reportSession('manual-claude', SESSIONS[1], windows(20, 50))
  await new Promise(done => setTimeout(done, 300))
  fs.appendFileSync(path.join(projects, `${SESSIONS[1]}.jsonl`), prompt('u-limits', '한도 질문', new Date().toISOString()) + line({
    type: 'assistant', uuid: 'a-limits', timestamp: new Date().toISOString(),
    message: { id: 'm-limits', role: 'assistant', content: [{ type: 'text', text: '한도 답변' }], usage: { input_tokens: 100, output_tokens: 5 } }
  }))
  await new Promise(done => setTimeout(done, 300))
  await reportSession('manual-claude', SESSIONS[1], windows(23, 51))
  check('a Claude question shows how much of its windows it took', await until(`${usageLine}.endsWith('|토큰 입력 100 · 출력 5 · 5시간 +3% · 주간 +1%')`, 8000), await js(usageLine))

  // A draft starting with "/" lists the slash commands; Esc closes the list and keeps the draft
  await js(`${cover(0)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.insertText', { text: '/co' })
  const slashNames = `[...${cover(0)}.querySelectorAll('.agent-chat-slash-name')].map(name => name.textContent).join(',')`
  check('typing "/co" lists the commands that start with it', await until(`${slashNames}.startsWith('/compact,/config,/context,/cost')`, 3000), await js(slashNames))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check('Esc closes the list and keeps the draft', await until(`!${cover(0)}.querySelector('.agent-chat-slash') && ${cover(0)}.querySelector('.agent-chat-input').value === '/co'`, 3000))
  for (let index = 0; index < 3; index++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }
  await until(`${cover(0)}.querySelector('.agent-chat-input').value === ''`, 3000)

  // A slash command that opens a screen of the CLI's own (/config): the pane shows the terminal while it is
  // open, and goes back to the chat once the composer is back
  await send('Input.insertText', { text: '/config' })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  check('a command that opens a screen hands the pane to the terminal', await until(`!${cover(0)} && !!document.querySelector('.agent-screen-return')`, 8000))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check('the terminal\'s keys reach that screen', await waitFor(() => read('claude-1-screen-closed') === 'x'))
  check('once the screen closes the pane is a chat again', await until(`!!${cover(0)} && !document.querySelector('.agent-screen-return')`, 8000))
  await until(`document.activeElement === ${cover(0)}?.querySelector('.agent-chat-input')`, 3000)

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
  await js(`${cover(0)}.querySelector('.agent-chat-attachment button').click()`)
  check('removing the image disables send for an empty draft', await until(`!${preview} && ${cover(0)}.querySelector('.agent-chat-send').disabled`))
  await pasteIntoChat(0)
  await until(`${preview}?.naturalWidth === 1`)
  // A second screenshot is added beside the first (2026-11-20 user report: it replaced the first)
  await pasteIntoChat(0)
  check('a second screenshot is kept beside the first', await until(`[...${cover(0)}.querySelectorAll('.agent-chat-attachment img')].filter(img => img.naturalWidth === 1).length === 2`))
  fs.writeFileSync(file('clipboard-text'), '클립보드 텍스트')
  await pasteIntoChat(0)
  check('text paste still fills the draft and retains the screenshots', await until(`${cover(0)}.querySelectorAll('.agent-chat-attachment').length === 2 &&
    ${cover(0)}.querySelector('.agent-chat-input').value === '클립보드 텍스트' && !${sendButton}.disabled`))
  await js(`${sendButton}.click()`)
  const isPng = path => path?.endsWith('.png') && fs.existsSync(path) && fs.readFileSync(path).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  check('Claude receives both screenshots and exactly the entered text', await waitFor(() => {
    if (read('claude-1-chat-sent') !== '3') return false
    const [first, second, separator, body, ...extra] = read('claude-1-chat-text').split('\n')
    return !extra.length && separator === '' && body === '클립보드 텍스트' && first !== second && isPng(first) && isPng(second)
  }), `${read('claude-1-chat-text')} ${await chatFeedback()}`)
  check('the draft preview is cleared after sending', await until(`!${preview} && !${cover(0)}.querySelector('.agent-chat-input').value`))
  fs.unlinkSync(file('clipboard-text'))
  await pasteIntoChat(0)
  await until(`${preview}?.naturalWidth === 1 && !${sendButton}.disabled`)
  await js(`${sendButton}.click()`)
  check('a screenshot can be sent on its own', await waitFor(() => read('claude-1-chat-sent') === '4'
    && isPng(read('claude-1-chat-text'))), await chatFeedback())
  fs.appendFileSync(path.join(projects, `${SESSIONS[0]}.jsonl`), line({
    type: 'user', uuid: 'attachment-only', timestamp: new Date().toISOString(),
    message: { role: 'user', content: [{ type: 'image' }] }
  }) + answer('attachment-only-seen', '첨부 파일을 받았습니다.', new Date().toISOString()))
  check('the recorded image-only send keeps one screenshot entry in the conversation', await until(`
    ${cover(0)}.textContent.includes('첨부 파일을 받았습니다.') &&
    [...${cover(0)}.querySelectorAll('.agent-chat-user')].filter(bubble => bubble.textContent === '스크린샷 첨부').length === 1
  `))

  const previewWidths = `[...${cover(0)}.querySelectorAll('.agent-chat-attachment img')].map(img => img.naturalWidth).join(',')`
  await pasteIntoChat(0)
  await until(`${previewWidths} === '1'`)
  await pasteIntoChat(0)
  check('pasting again appends a second image', await until(`${previewWidths} === '1,1'`))
  await driver.menuPick(...await center(chatLog(0)), '편의', '이미지 첨부…')
  check('the image picker adds both selected files to the existing previews', await until(`${previewWidths} === '1,1,2,3'`))
  await js(`${cover(0)}.querySelectorAll('.agent-chat-attachment button')[1].click()`)
  check('removing one preview leaves the other images in order', await until(`${previewWidths} === '1,2,3'`))
  await send('Input.insertText', { text: '세 이미지 비교해 줘.\n목록과 상세를 확인해 줘.' })
  await js(`${sendButton}.click()`)
  check('all remaining images and the full text reach the unfocused composer', await waitFor(() => {
    if (read('claude-1-chat-sent') !== '5') return false
    const lines = read('claude-1-chat-text').split('\n')
    const separator = lines.indexOf('')
    const attachments = lines.slice(0, separator)
    return separator === 3 && new Set(attachments).size === 3
      && attachments.every((file, index) => fs.existsSync(file) && fs.readFileSync(file).readUInt32BE(16) === index + 1)
      && lines.slice(separator + 1).join('\n') === '세 이미지 비교해 줘.\n목록과 상세를 확인해 줘.'
  }), await chatFeedback())
  check('sending several images clears the entire attachment tray', await until(`${previewWidths} === ''`))

  // A permission prompt in the terminal shows as choices in the chat, and a choice answers it
  fs.writeFileSync(file('claude-1-approval'), '─'.repeat(60) + '\r\n Bash command\r\n\r\n   npm run build\r\n\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and don\'t ask again for npm run build commands\r\n   3. No, and tell Claude what to do differently (esc)')
  check('the prompt shows in the chat with its question, command and choices', await until(`(() => {
    const card = ${cover(0)}?.querySelector('.agent-chat-approval')
    return !!card && card.textContent.includes('Do you want to proceed?') && card.textContent.includes('npm run build') &&
      card.querySelectorAll('.agent-chat-approval-option').length === 3 && !${cover(0)}.querySelector('.agent-chat-input')
  })()`, 8000), await js(`${cover(0)}?.querySelector('.agent-chat-approval')?.textContent ?? 'no card'`))
  check('the other pane\'s chat shows no prompt', await js(`!${cover(1)}.querySelector('.agent-chat-approval')`))
  await click(...await center(chatLog(0)), 'right')
  check('paste is disabled while the chat is waiting for an approval', await until(`
    [...document.querySelectorAll('.terminal-menu-item')].find(item => item.textContent.trim() === '붙여넣기')?.hasAttribute('data-disabled')
  `))
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(`!document.querySelector('.terminal-menu')`)
  await shot('local-agent-chat-approval')
  const second = await center(`${cover(0)}.querySelectorAll('.agent-chat-approval-option')[1]`)
  await click(second[0], second[1])
  check('choosing answers the prompt with that number', await waitFor(() => read('claude-1-approval-answer') === '2'), read('claude-1-approval-answer'))
  check('the composer comes back once the prompt is gone', await until(`!${cover(0)}.querySelector('.agent-chat-approval') && !!${cover(0)}.querySelector('.agent-chat-input')`, 8000))

  const openChatMenu = async () => {
    const log = await center(chatLog(0))
    await click(log[0], log[1], 'right')
    return until(`[...document.querySelectorAll('.terminal-menu-item')].some(item => item.textContent === '채팅 전체 복사')`)
  }
  await js(`navigator.clipboard.writeText = async text => { window.copiedConversation = text }`)
  check('right-click in the chat offers conversation actions', await openChatMenu())
  check('the chat menu has the basic actions and both pane and utility submenus', await js(`
    ['복사', '붙여넣기', '모두 선택', '분할', '편의'].every(label =>
      [...document.querySelectorAll('.terminal-menu-item')].some(item => item.textContent.trim() === label))
  `))
  await driver.pick('모두 선택')
  check('select all from chat selects only the conversation in that pane', await until(`
    window.getSelection().toString().includes('첫 칸 질문') && !window.getSelection().toString().includes('둘째 칸 질문')
  `))
  await js(`(() => {
    const log = ${chatLog(0)}
    const point = log.getBoundingClientRect()
    log.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: point.left + 20, clientY: point.top + 40 }))
  })()`)
  await driver.pick('복사')
  check('copy transfers the selected conversation text', await until(`
    window.copiedConversation?.includes('첫 칸 질문') && !window.copiedConversation.includes('둘째 칸 질문')
  `))
  await js('window.getSelection().removeAllRanges()')

  const box = `${cover(0)}.querySelector('.agent-chat-input')`
  fs.writeFileSync(file('clipboard-text'), '우클릭 붙여넣기')
  await openChatMenu()
  await driver.pick('붙여넣기')
  check('paste from the conversation puts the clipboard in its own composer and focuses it', await until(`
    ${box}.value === '우클릭 붙여넣기' && document.activeElement === ${box} &&
    !${cover(1)}.querySelector('.agent-chat-input').value
  `))
  fs.unlinkSync(file('clipboard-text'))
  await click(...await center(box), 'right')
  await driver.pick('모두 선택')
  check('select all from the composer selects the whole draft', await until(`
    ${box}.selectionStart === 0 && ${box}.selectionEnd === ${box}.value.length && ${box}.value.length > 0
  `))
  const backspace = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...backspace })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...backspace })
  await until(`!${box}.value`)

  await openChatMenu()
  await driver.pick('채팅 전체 복사')
  check('copy all includes the recorded conversation and the latest unrecorded send from this pane', await until(`
    (window.copiedConversation ?? '').includes('나\\n첫 칸 질문')
    && window.copiedConversation.includes('Claude\\n첫 칸 **답변**')
    && window.copiedConversation.includes('나\\n스크린샷 첨부')
    && window.copiedConversation.includes('세 이미지 비교해 줘.')
    && !window.copiedConversation.includes('둘째 칸 질문')
  `), await js(`window.copiedConversation ?? ''`))
  await driver.menuPick(...await center(chatLog(0)), '편의', '채팅을 파일로 저장…')
  check('the utility menu saves the conversation of the pane as text', await waitFor(() => {
    const saved = read('saved-chat.txt')
    return saved.includes('나\n첫 칸 질문') && saved.includes('세 이미지 비교해 줘.') && !saved.includes('둘째 칸 질문')
  }))
  await openChatMenu()
  await driver.pick('채팅 닫고 터미널로 전환')
  check('the context menu closes only this chat and focuses its original live terminal', await until(`
    !${cover(0)} && !!${cover(1)} && ${pane(0)}.dataset.localShellId === ${JSON.stringify(firstShell)}
    && document.activeElement?.classList.contains('xterm-helper-textarea')
    && (${pane(0)}.textContent ?? '').includes('fixture ready: claude-1')
  `))
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await until(`!!${cover(0)}`)

  // Back to the terminal with the key, from the chat box
  await js(`${cover(0)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  check('the key in the chat goes back to the terminal and focuses it', await until(`!${cover(0)} && !!${cover(1)} && document.activeElement?.classList.contains('xterm-helper-textarea') && !!document.activeElement.closest('[data-local-shell-id="${firstShell}"]')`, 3000))

  // A window reload brings the tab back as it was: the pane that was a chat is a chat again, the other a terminal
  await chooseChatTheme(1, '종이 노트')
  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('after a reload the split tab is back with its two shells', await until(`${PANES}.length === 2 &&
    ${pane(0)}.dataset.localShellId === ${JSON.stringify(firstShell)} && ${pane(1)}.dataset.localShellId === ${JSON.stringify(secondShell)}`, 15000))
  check('the pane that was a chat shows its chat again, the other stays a terminal', await until(`!!${cover(1)} && !${cover(0)}`, 10000))
  check('the restored chat shows its conversation', await until(`(${cover(1)}?.textContent ?? '').includes('둘째 칸 질문')`, 8000), await coverText(1))
  check('the Paper chat theme survives reload while the terminal keeps its original colors', await until(`
    ${cover(1)}?.dataset.chatTheme === 'chat-paper' && ${appTheme} === ${JSON.stringify(beforeChatTheme[0])} &&
    ${xtermColor} === ${JSON.stringify(beforeChatTheme[1])}
  `))
  await chooseChatTheme(1, '앱 테마 따르기')

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

  const childChat = index => `${cover(index)}?.querySelector('.agent-chat-subagent-conversation')`
  const childDraft = index => `${childChat(index)}?.querySelector('.agent-chat-subagent-input')`
  const childSend = index => `${childChat(index)}?.querySelector('button[type=submit]')`
  const openChild = async index => {
    await js(`if (!${subagents(index)}.open) ${subagents(index)}.querySelector('summary').click()`)
    await js(`${subagentEntry(index)}.click()`)
  }
  await js(`${cover(1)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.insertText', { text: '부모 대화 초안' })
  fs.writeFileSync(file('manual-claude-chat-target'), '분할 테스트 검토')
  await openChild(1)
  check('clicking a Claude subagent opens its own prior conversation and direct input', await until(`
    ${childChat(1)}?.textContent.includes('직접 연결') &&
    ${childChat(1)}?.textContent.includes('분할 테스트 검토를 마쳤습니다')
  `, 8000), await js(`${childChat(1)}?.textContent ?? 'Subagent conversation closed'`))
  await js(`${childDraft(1)}.focus()`)
  await send('Input.insertText', { text: '한 가지 더 확인해줘' })
  await js(`${childSend(1)}.click()`)
  check('the selected Claude subagent gets the exact follow-up text', await waitFor(() =>
    read('manual-claude-chat-sent') === '2' && read('manual-claude-chat-text') === '한 가지 더 확인해줘'))
  await js(`${childChat(1)}.querySelector('.agent-chat-head-btn').click()`)
  check('returning from a subagent keeps the parent draft',
    await until(`!${childChat(1)} && ${cover(1)}.querySelector('.agent-chat-input').value === '부모 대화 초안'`))
  fs.writeFileSync(file('manual-claude-chat-target'), '')

  // The second agent ends: its chat says so and stops taking input
  fs.writeFileSync(file('manual-claude-exit-code'), '0')
  check('when the agent ends its chat says so and has no text box', await until(`${cover(1)}.textContent.includes('종료되었습니다') && !${cover(1)}.querySelector('.agent-chat-input')`, 15000), await js(`${cover(1)}?.textContent.slice(-120)`))
  check('the PowerShell pane stays open after its Claude process exits', await until(`
    window.electronAPI.localShellAttach(${JSON.stringify(secondShell)}).then(state => state?.exited === false)
  `))
  check('no transcript path reached the window', await js(`!document.body.innerHTML.includes('claude-home')`))
  check('Claude chat has no Codex speed buttons', await js(`!document.querySelector('.agent-usage-speed')`))

  await openAgent('codex')
  const codexAgent = () => js(`window.electronAPI.agentMessagesSnapshot().then(state =>
    state.agents.find(agent => agent.kind === 'codex' && agent.active)?.id)`)
  const codexId = await waitFor(codexAgent)
  check('Codex opens a chat for attaching an image', Boolean(codexId) && await until(`${pane(0)}?.textContent.includes(${JSON.stringify('fixture ready: ' + codexId)})`))
  const codexUsage = `${pane(0)}?.querySelector('.agent-pane-usage')`
  const fastButton = `${codexUsage}?.querySelector('[data-speed="fast"]')`
  const ultraButton = `${codexUsage}?.querySelector('[data-speed="ultrafast"]')`
  check('the Codex terminal does not show the chat speed controls', await js(`!${fastButton}`))
  await js(`${pane(0)}.querySelector('.xterm-helper-textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await until(`!!${cover(0)}?.querySelector('.agent-chat-input')`)
  check('Fast is in the usage row before the first usage report and the chat header has no idle label', await until(`
    !!${fastButton} && !${codexUsage}.querySelector('.agent-usage-readout') &&
    !${cover(0)}.querySelector('.agent-chat-head').textContent.includes('입력 대기') &&
    !${cover(0)}.querySelector('.agent-usage-speed')
  `))
  const date = new Date()
  const day = [String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')]
  const rollouts = path.join(profile, 'codex-home', 'sessions', ...day)
  const codexCwd = await js(`window.electronAPI.agentMessagesSnapshot().then(state => state.agents.find(agent => agent.id === ${JSON.stringify(codexId)})?.cwd)`)
  const codexTranscript = path.join(rollouts, 'rollout-subagent-test.jsonl')
  const codexLine = (type, payload, ordinal) => line({ type, payload, ordinal, timestamp: new Date().toISOString() })
  const codexParentId = '01a1ec18-9b8a-71c1-839d-2e31c010300f'
  const codexChildId = '01a1ec18-9b8a-71c1-839d-2e31c0103010'
  const opaque = 'gAAAA' + '1aQz_9'.repeat(20) + '=='
  const codexUsageLine = percent => codexLine('event_msg', {
    type: 'token_count', rate_limits: { primary: { window_minutes: 10080, used_percent: percent } }
  })
  fs.mkdirSync(rollouts, { recursive: true })
  fs.writeFileSync(codexTranscript, codexLine('session_meta', { id: codexParentId, cwd: codexCwd, timestamp: date.toISOString(), source: 'cli' }) +
    codexLine('turn_context', { model: 'gpt-6', effort: 'xhigh' }) + codexUsageLine(22) +
    codexLine('response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'delegate', arguments: JSON.stringify({ task_name: 'review', message: opaque }) }) +
    codexLine('response_item', { type: 'function_call_output', call_id: 'delegate', output: JSON.stringify({ task_name: '/root/review' }) }))
  fs.writeFileSync(path.join(rollouts, `rollout-child-${codexChildId}.jsonl`),
    codexLine('session_meta', { id: codexChildId, thread_source: 'subagent', parent_thread_id: codexParentId, agent_path: '/root/review', forked_from_id: codexParentId, subagent_history_start_ordinal: 2 }, 0) +
    codexLine('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Inherited parent output' }] } }, 1) +
    codexLine('event_msg', { type: 'item_completed', item: { type: 'Extension', kind: 'web.search', query: '채팅 저장 검토', action: { type: 'search' } } }, 2))
  check('Codex shows its delegated task from persisted rollout records', await until(`
    ${subagents(0)}?.querySelector('summary')?.textContent.includes('작업 중 1')
  `, 12000))
  const codexShowsSettings = percent => `
    ${codexUsage}?.querySelector('.agent-usage-model')?.textContent === 'gpt-6' &&
    ${codexUsage}?.querySelector('.agent-usage-effort')?.textContent === 'xhigh' &&
    ${codexUsage}?.textContent.includes('${percent}%')
  `
  check('Codex chat shows its model, effort, and usage', await until(codexShowsSettings(22), 12000))
  fs.appendFileSync(codexTranscript, codexLine('response_item', {
    type: 'function_call_output', call_id: 'large-output', output: 'x'.repeat(300 * 1024)
  }) + codexUsageLine(29))
  check('Codex chat keeps its model and effort when long tool output pushes them out of the usage tail',
    await until(codexShowsSettings(29), 12000))
  await js(`${subagents(0)}?.querySelector('summary')?.click()`)
  await driver.move(...await center(subagentEntry(0)))
  check('the Codex hover preview uses the child rollout, with neither inherited history nor ciphertext', await until(`
    ${subagentPreview}?.textContent.includes('채팅 저장 검토') &&
    !${subagentPreview}.textContent.includes('Inherited parent output') &&
    !${subagents(0)}.textContent.includes(${JSON.stringify(opaque)}) &&
    !${subagentPreview}.textContent.includes(${JSON.stringify(opaque)})
  `, 8000))
  fs.appendFileSync(codexTranscript, codexLine('inter_agent_communication', {
    author: '/root/review', recipient: '/root', content: '<subagent_notification>{"agent_path":"/root/review","status":{"completed":"채팅 저장을 검토했습니다"}}</subagent_notification>'
  }))
  check('the Codex preview updates with a delegated result', await until(`
    ${subagents(0)}?.querySelector('summary')?.textContent.includes('완료 1') &&
    ${subagentPreview}?.querySelector('.agent-chat-subagents-result')?.textContent === '채팅 저장을 검토했습니다'
  `, 8000))
  await js(`${subagents(0)}?.querySelector('summary')?.click()`)
  const codexInput = `${cover(0)}.querySelector('.agent-chat-input')`
  check('Codex chat reads the initial Fast setting', await until(`${fastButton}?.getAttribute('aria-pressed') === 'false'`))
  check('Codex chat hides Ultrafast when the native command is unavailable', await waitFor(() => read(codexId + '-speed-checked')) && await js(`!${ultraButton}`))
  fs.writeFileSync(file(codexId + '-ultrafast-eligible'), '')
  fs.writeFileSync(file(codexId + '-speed-model'), 'gpt-6.2-astra')
  fs.writeFileSync(file(codexId + '-draft'), '')
  check('Codex chat shows Ultrafast once the selected model offers it', await until(`${ultraButton}?.getAttribute('aria-pressed') === 'false'`))
  check('both buttons fit without being clipped in a narrow usage row', await js(`(() => {
    const row = ${codexUsage}
    row.style.width = '200px'
    const bounds = row.getBoundingClientRect()
    const fits = [...row.querySelectorAll('.agent-usage-speed')].every(button => {
      const rect = button.getBoundingClientRect()
      return rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right
    })
    row.style.removeProperty('width')
    return fits
  })()`))
  await js(`${codexInput}.focus()`)
  await send('Input.insertText', { text: 'Codex 이미지 테스트' })
  await click(...await center(fastButton))
  check('the Fast button turns on the CLI setting', await until(`${fastButton}?.getAttribute('aria-pressed') === 'true'`) && read(codexId + '-fast-toggles') === '1')
  await js(`${fastButton}.click()`)
  check('the Fast button turns it off and keeps the draft', await until(`
    ${fastButton}?.getAttribute('aria-pressed') === 'false' && ${codexInput}.value === 'Codex 이미지 테스트'
  `) && read(codexId + '-fast-toggles') === '2' && !read(codexId + '-chat-sent'))
  await js(`${fastButton}.click()`)
  await until(`${fastButton}?.getAttribute('aria-pressed') === 'true' && !${ultraButton}?.disabled`)
  await js(`${ultraButton}.click()`)
  check('Ultrafast replaces Fast in the CLI and in the usage row', await until(`
    ${ultraButton}?.getAttribute('aria-pressed') === 'true' && ${fastButton}?.getAttribute('aria-pressed') === 'false'
  `) && read(codexId + '-speed') === 'ultrafast')
  await until(`!${ultraButton}?.disabled`)
  await js(`${ultraButton}.click()`)
  check('clicking Ultrafast again returns to Standard and leaves the draft intact', await until(`
    ${ultraButton}?.getAttribute('aria-pressed') === 'false' && ${fastButton}?.getAttribute('aria-pressed') === 'false'
    && ${codexInput}.value === 'Codex 이미지 테스트'
  `) && read(codexId + '-ultrafast-toggles') === '2' && !read(codexId + '-chat-sent') && !read(codexId + '-speed-probe'))
  await pasteIntoChat(0)
  await until(`${preview}?.naturalWidth === 1 && !${sendButton}.disabled`)
  await js(`${sendButton}.click()`)
  check('Codex receives the screenshot path and exactly the entered text', await waitFor(() => {
    if (read(codexId + '-chat-sent') !== '1') return false
    const [attachment, separator, body, ...extra] = read(codexId + '-chat-text').split('\n')
    return !extra.length && separator === '' && body === 'Codex 이미지 테스트' && isPng(attachment)
  }), await chatFeedback())

  fs.writeFileSync(file(codexId + '-chat-target'), 'Main [default]')
  await openChild(0)
  check('a Codex subagent that uses a path offers a relay through its confirmed parent', await until(`
    ${childChat(0)}?.textContent.includes('부모를 통해 전달') &&
    ${childChat(0)}?.textContent.includes('채팅 저장을 검토했습니다') &&
    !${childChat(0)}?.textContent.includes('Inherited parent output')
  `, 8000))
  await js(`${childDraft(0)}.focus()`)
  await send('Input.insertText', { text: '저장 처리만 다시 확인해줘' })
  await js(`${childSend(0)}.click()`)
  check('Codex sends a follow-up request targeting the existing child path', await waitFor(() =>
    read(codexId + '-chat-sent') === '2' && /"\/root\/review".*followup_task/.test(read(codexId + '-chat-text')) &&
    read(codexId + '-chat-text').endsWith('"저장 처리만 다시 확인해줘"')))
  check('the Codex child shows the parent relay as a request', await until(`${childChat(0)}.textContent.includes('부모에게 전달 요청')`))
  await shot('local-agent-subagent-conversation')
  await js(`${childChat(0)}.querySelector('.agent-chat-head-btn').click()`)

  // A long transcript keeps only its viewport mounted even as text continues to arrive.
  const completed = item => codexLine('event_msg', { type: 'item_completed', item })
  const longAnswer = (id, text) => completed({ id, type: 'AgentMessage', content: [{ type: 'text', text }] })
  fs.appendFileSync(codexTranscript, completed({ id: 'scroll-question', type: 'UserMessage', content: [{ type: 'text', text: '로그 기록을 검토해 줘' }] }) +
    completed({ id: 'scroll-tool', type: 'CommandExecution', command: 'inspect history', aggregated_output: '도구 상세 결과' }) +
    Array.from({ length: 220 }, (_, index) => longAnswer('scroll-' + index, `긴 대화 ${index}번\n\n**표시 테스트**`)).join(''))
  const longLog = chatLog(0)
  const numberOfRows = `${longLog}.querySelectorAll('.agent-chat-row').length`
  const atEnd = `${longLog}.scrollHeight - ${longLog}.scrollTop - ${longLog}.clientHeight < 40`
  const scrollLongLog = toEnd => js(`(() => { const log = ${longLog}; log.scrollTop = ${toEnd ? 'log.scrollHeight' : '0'} })()`)
  check('long chat follows new items and mounts only the nearby rows', await until(`
    ${longLog}.textContent.includes('긴 대화 219번') && !${longLog}.textContent.includes('긴 대화 0번') &&
    ${numberOfRows} < 70 && ${atEnd}
  `), `${await js(numberOfRows)} rows mounted out of 222`)
  await openQuestions(0)
  check('Codex lists its question outside the virtual viewport', await until(`
    ${questionPanel(0)}?.textContent.includes('로그 기록을 검토해 줘') && !${longLog}.textContent.includes('로그 기록을 검토해 줘')
  `))
  await pickQuestion(0, '로그 기록을 검토해 줘')
  check('choosing a loaded question scrolls the virtual list to the question row', await until(`
    ${longLog}.querySelector('[data-question-target]')?.textContent.includes('로그 기록을 검토해 줘') &&
    ${longLog}.textContent.includes('긴 대화 0번') && !${longLog}.textContent.includes('긴 대화 219번')
  `))
  await js(`${cover(0)}.querySelector('.agent-chat-question-location button').click()`)
  check('latest conversation scrolls back to the live end', await until(`${atEnd} && ${longLog}.textContent.includes('긴 대화 219번')`))
  await scrollLongLog(false)
  check('scrolling back mounts older messages', await until(`
    ${longLog}.textContent.includes('긴 대화 0번') && !${longLog}.textContent.includes('긴 대화 219번')
  `))
  await js(`${longLog}.querySelector('.agent-chat-tool summary').click()`)
  await until(`${longLog}.querySelector('.agent-chat-tool')?.open`)
  fs.appendFileSync(codexTranscript, longAnswer('scroll-update', '읽는 동안 도착한 답변'))
  await sleep(800)
  check('a reader stays at the old position when new output arrives', await js(`
    ${longLog}.scrollTop < 80 && ${longLog}.textContent.includes('긴 대화 0번')
  `))
  await scrollLongLog(true)
  check('the latest reply appears after going to the bottom', await until(`${longLog}.textContent.includes('읽는 동안 도착한 답변') && !${longLog}.querySelector('.agent-chat-tool')`))
  await scrollLongLog(false)
  check('a tool stays expanded when it returns to view', await until(`${longLog}.querySelector('.agent-chat-tool')?.open`))
  await openChatMenu()
  await driver.pick('모두 선택')
  check('explicit select all includes every loaded message', await until(`
    getSelection().toString().includes('긴 대화 0번') && getSelection().toString().includes('긴 대화 219번')
  `))
  await js('getSelection().removeAllRanges()')
  check('clearing the selection releases rows outside of view', await until(`${numberOfRows} < 70`))

  await openQuestions(0)
  const codexReply = { id: 'reply-from-claude', from: 'claude-7', replyTo: 'sent-task', text: '새 작업의 상태를 확인했습니다.' }
  fs.appendFileSync(codexTranscript, completed({ id: 'wake-codex', type: 'UserMessage',
    content: [{ type: 'text', text: 'New ezShell message: read it with read_inbox, then handle it.' }] }) +
    completed({ id: 'inbox-codex', type: 'McpToolCall', server: 'ezshell-cli-mcp', tool: 'read_inbox', status: 'completed',
      result: { content: inboxResult(codexReply) } }))
  check('an open question list refreshes when Codex reads an incoming reply', await until(`
    ${questionPanel(0)}.textContent.includes('받은 답장 · Claude 7') && !${questionPanel(0)}.textContent.includes('New ezShell message')
  `))
  await send('Input.insertText', { text: '받은 답장' })
  check('received replies can be searched by their label', await until(`
    ${questionPanel(0)}.querySelectorAll('li').length === 1 && ${questionPanel(0)}.textContent.includes(${JSON.stringify(codexReply.text)})
  `))
  await pickQuestion(0, codexReply.text)
  check('the received reply highlights the right Codex tool row', await until(`
    ${longLog}.querySelector('[data-question-target]')?.dataset.chatRow === 'item:McpToolCall:inbox-codex'
    && ${longLog}.querySelector('[data-question-target] .agent-chat-received-message div')?.textContent === ${JSON.stringify(codexReply.text)}
  `))

  // Locking drops every conversation
  await js(`document.activeElement?.blur(); document.body.focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 2 })
  check('locking the app removes the chats', await until(`document.querySelectorAll('input[type=password]').length > 0 && !document.querySelector('.agent-chat-cover')`, 8000))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
