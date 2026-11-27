// Agent chat view (docs/plan/2026-11-19-agent-chat-view.md): every pane with an agent can show it as a
// chat at the same time, each with its own conversation, read from the agent's transcript file. Sending
// types into that agent's own composer. The fake agents and transcript folders: e2e/support/agentChatApp.js.
const fs = require('fs')
const http = require('node:http')
const path = require('path')
const { connect, createChecks, sleep, unlock, openLocalAgent, pages, pickTabGroup } = require('../support/driver')
const { checkChatLinkPreviews, checkSplitChatLinkPreview } = require('../support/chatLinkPreviews')

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
  const openChatActions = async index => driver.click(...await driver.center(`${cover(index)}.querySelector('.agent-chat-head')`), 'right')
  const chooseChatAction = async (index, label) => {
    await openChatActions(index)
    await driver.pick(label)
  }
  const setChatDraft = (text, index = 0) => js(`(() => {
    const input = ${composer(index)}
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const focusedChat = index => `(() => {
    const input = ${composer(index)}
    if (!input || document.activeElement !== input) return false
    const frame = ${pane(index)}
    const outline = getComputedStyle(frame, '::before')
    // Split cards tune the pane outline against their own surface. The input has its own focus color.
    const token = frame.parentElement.matches('.is-split') ? '--pane-card-focus' : '--pane-focus-color'
    const expected = getComputedStyle(frame).getPropertyValue(token).trim()
    const color = new OffscreenCanvas(1, 1).getContext('2d')
    color.fillStyle = outline.borderTopColor
    const actual = color.fillStyle
    color.fillStyle = expected
    return expected && color.fillStyle === actual && outline.borderTopWidth === '2px' &&
      outline.borderTopStyle === 'solid' && outline.top === '1px' && outline.boxShadow !== 'none'
  })()`
  const coverText = index => js(`${cover(index)}?.querySelector('.agent-chat-log')?.textContent ?? ''`)
  const chatThemeButton = index => `${cover(index)}.querySelector('.agent-chat-theme-trigger')`
  async function chooseChatTheme(index, label) {
    await click(...await center(chatThemeButton(index)))
    const match = label === '앱 테마 따르기'
      ? `item.textContent.trim().startsWith('앱 테마 따르기 · ')`
      : `item.textContent.trim() === ${JSON.stringify(label)}`
    const option = `[...document.querySelectorAll('.select-menu-content [role="menuitemradio"]')]
      .find(item => ${match})`
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

  // An error line on the terminal gets its tint (Terminal Log Highlight), which must not show over the chat
  fs.writeFileSync(file('claude-1-command-history'), 'fixture ready: claude-1\r\n2026-11-25 10:00:00 SEVERE [main] boom\r\n')
  const logTints = `[...${pane(0)}.querySelectorAll('.xterm-decoration.terminal-log-row')].filter(el => el.getClientRects().length)`
  check('an error line on the agent terminal is tinted', await until(`${logTints}.length > 0`, 5000))

  // The chat key in the terminal turns the pane into a chat
  await js(`${pane(0)}.querySelector('.xterm-helper-textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  check('Ctrl+Shift+F11 in the terminal shows its agent as a chat', await until(`!!${cover(0)}`, 5000))
  check('a chat without a transcript starts empty', await until(`${cover(0)}.querySelector('.agent-chat-empty')?.textContent === '대화가 시작되면 여기에 보입니다.'`, 5000))
  // xterm's decorations (z-index 6) drew over the chat cover (5): the tints are dropped under the chat,
  // and the terminal host is its own stacking context so no layer of it can come over a cover
  check('the terminal tints are not drawn over the chat view', await until(`${logTints}.length === 0 &&
    getComputedStyle(${pane(0)}.querySelector('.local-terminal-host')).isolation === 'isolate'`, 3000), await js(`${logTints}.length`))
  check('the focused composer gets a pane outline even in a single idle chat', await until(focusedChat(0), 2000))
  await js(`${pane(0)}.querySelector('.xterm-helper-textarea').focus()`)
  check('the terminal behind a chat cannot steal focus from the composer', await js(`document.activeElement === ${composer(0)}`))
  const screenshotComment = '이 영역을 봐 주세요.\n두 번째 줄도 확인해 주세요.'
  fs.writeFileSync(file('clipboard-comment'), screenshotComment)
  await setChatDraft('앞뒤')
  await js(`${composer(0)}.setSelectionRange(1, 1)`)
  await pasteIntoChat(0)
  check('pasting a capture inserts the comment at the caret and attaches the image', await until(`
    ${composer(0)}.value === ${JSON.stringify('앞 [첨부이미지 1]\n' + screenshotComment + ' 뒤')} &&
    ${cover(0)}.querySelector('.agent-chat-attachment img')?.naturalWidth === 1
  `))
  await js(`${cover(0)}.querySelector('.agent-chat-attachment button').click()`)
  await setChatDraft('')
  fs.unlinkSync(file('clipboard-comment'))
  check('the chat header replaces the action buttons with a message notification icon', await until(`
    !${cover(0)}.querySelector('.agent-chat-head .agent-chat-head-btn') &&
    !!${cover(0)}.querySelector('.agent-chat-notification')
  `, 5000))
  await openChatActions(0)
  check('the three chat actions are directly available in the right-click menu', await until(`
    ['채팅 닫고 터미널로 전환', '메시지', '질문 목록'].every(label =>
      [...document.querySelectorAll('.terminal-menu > .terminal-menu-item')].some(item => item.textContent.trim() === label)
    )
  `))
  await driver.pick('메시지')
  check('the message action opens that agent\'s inbox', await until(`(document.querySelector('.agent-messages-dialog')?.textContent ?? '').includes('claude-1')`, 5000))
  await js(`document.querySelector('.agent-messages-dialog .modal-actions button').click()`)
  await until(`!document.querySelector('.agent-messages-dialog')`)
  await js(`${composer(0)}.focus()`)
  const contextKey = { key: 'F10', code: 'F10', windowsVirtualKeyCode: 121, modifiers: 8 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...contextKey })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...contextKey })
  await driver.pick('질문 목록')
  check('opening the question list from the keyboard menu focuses its search', await until(`
    document.activeElement === ${cover(0)}.querySelector('.agent-chat-questions-search input')
  `))
  await js(`${cover(0)}.querySelector('[aria-label="질문 목록 닫기"]').click()`)
  check('closing the question list returns focus to the composer', await until(`
    !${cover(0)}.querySelector('.agent-chat-questions') && document.activeElement === ${composer(0)}
  `))
  await chooseChatAction(0, '채팅 닫고 터미널로 전환')
  check('choosing the terminal action returns focus to the same pane terminal', await until(`
    !${cover(0)} && document.activeElement === ${pane(0)}.querySelector('.xterm-helper-textarea')
  `))
  check('back on the terminal its error line is tinted again', await until(`${logTints}.length > 0`, 3000))
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await until(`!!${composer(0)}`)
  await js(`${cover(0)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.insertText', { text: '첫 칸 질문' })
  await driver.enter()
  const firstSentAt = new Date().toISOString()
  check('the first prompt is shown before a transcript exists', await until(`
    ${cover(0)}.querySelector('.agent-chat-user .agent-chat-bubble')?.textContent === '첫 칸 질문' &&
    !${cover(0)}.querySelector('.agent-chat-empty')
  `, 1500))
  const composerProgress = `${cover(0)}.querySelector('.agent-chat-composer .agent-chat-reply-progress')`
  check('the composer shows that a reply is being generated', await until(`
    ${composerProgress}?.textContent.trim() === '답변 생성 중…'
  `, 3000) && await waitFor(() => read('claude-1-chat-sent') === '1'))
  fs.writeFileSync(file('claude-1-program-status'), 'state=working:app=claude')
  await until(`${cover(0)}.querySelector('.agent-chat-status')?.dataset.status === 'working'`, 5000)

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
  check('a reply from the transcript replaces the echo and leaves the working status above the input', await until(`
    ${cover(0)}.querySelectorAll('.agent-chat-user').length === 1 &&
    ${composerProgress}?.textContent.trim() === '작업 중…' &&
    ${composerProgress}.getBoundingClientRect().bottom <= ${composer(0)}.getBoundingClientRect().top
  `, 3000))
  await shot('local-agent-chat-working-footer')
  await setChatDraft('쓰던 초안')
  await js(`${cover(0)}.focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check('Esc restores an already recorded question above the draft and preserves its history', await until(`
    ${composer(0)}.value === '첫 칸 질문\\n쓰던 초안' &&
    ${cover(0)}.querySelector('.agent-chat-user .agent-chat-bubble')?.textContent === '첫 칸 질문'
  `, 8000) && read('claude-1-chat-interrupt') === 'esc' && !read('claude-1-taken-back'))
  await setChatDraft('')
  fs.writeFileSync(file('claude-1-program-status'), 'state=idle:app=claude')
  check('the composer clears its progress label when the agent becomes idle', await until(`
    !${composerProgress}
  `, 3000))
  const appTheme = `document.documentElement.dataset.theme`
  const xtermColor = `getComputedStyle(${pane(0)}.querySelector('.local-terminal-host')).getPropertyValue('--terminal-background')`
  const beforeChatTheme = await js(`[${appTheme}, ${xtermColor}]`)
  await chooseChatTheme(0, '카톡 모드')
  check('Kakao chat has a yellow sent bubble, a white received bubble, and its own canvas', await until(`
    ${cover(0)}.dataset.chatTheme === 'chat-kakao' && getComputedStyle(${cover(0)}).backgroundColor === 'rgb(220, 232, 244)' &&
    getComputedStyle(${cover(0)}.querySelector('.agent-chat-user .agent-chat-bubble')).backgroundColor === 'rgb(255, 223, 98)' &&
    getComputedStyle(${cover(0)}.querySelector('.agent-chat-assistant > .agent-chat-md')).backgroundColor === 'rgb(255, 255, 255)'
  `))
  check('Kakao shows the local send time to the bottom left of the sent bubble', await until(`(() => {
    const message = ${cover(0)}.querySelector('.agent-chat-user-message')
    const time = message?.querySelector('time')
    const bubble = message?.querySelector('.agent-chat-bubble')?.getBoundingClientRect()
    if (!time || !bubble || getComputedStyle(time).visibility !== 'visible') return false
    const label = time.getBoundingClientRect()
    return /^(오전|오후) \\d{1,2}:\\d{2}$/.test(time.textContent) &&
      Math.abs(Date.parse(time.dateTime) - Date.parse(${JSON.stringify(firstSentAt)})) < 5000 &&
      label.right < bubble.left && label.bottom <= bubble.bottom && label.bottom >= bubble.bottom - 4
  })()`))
  check('changing the chat theme keeps the app and underlying xterm colors',
    JSON.stringify(await js(`[${appTheme}, ${xtermColor}]`)) === JSON.stringify(beforeChatTheme))
  // The pane draws the focus border and the working trace itself, so the theme's colors must reach it
  const paneVar = name => `getComputedStyle(${pane(0)}).getPropertyValue(${JSON.stringify(name)}).trim()`
  const paneBorder = `getComputedStyle(${pane(0)}, '::before').borderTopColor`
  check('the Kakao theme gives the pane its own focus and trace colors', await until(`
    ${paneVar('--chat-focus')} === '#2f68b0' && ${paneVar('--motion-accent')} === '#a86f00' &&
    (!${pane(0)}.matches(':focus-within') || ${paneBorder} === 'rgb(47, 104, 176)')
  `), JSON.stringify(await js(`[${paneVar('--chat-focus')}, ${paneVar('--motion-accent')}, ${paneBorder}]`)))
  await shot('local-agent-chat-kakao')
  // A normal sentence can wrap to several visual lines before it contains a newline.
  const inputRow = `${composer(0)}.parentElement`
  const inputSize = `(() => {
    const input = ${composer(0)}
    return { height: input.offsetHeight, lineHeight: parseFloat(getComputedStyle(input).lineHeight) }
  })()`
  await js(`${inputRow}.style.setProperty('max-width', '440px'); ${composer(0)}.focus()`)
  const single = await js(inputSize)
  const threeLines = `${composer(0)}.offsetHeight >= ${single.height + single.lineHeight * 2 - 2}`
  const noInputScroll = `${composer(0)}.scrollHeight <= ${composer(0)}.clientHeight + 1`
  await send('Input.insertText', { text: '터미널에서 작성한 질문을 채팅 모드에 붙여 넣고 줄바꿈을 확인합니다. '.repeat(5) })
  check('soft-wrapped text makes the input grow past two lines without scrolling', await until(`${threeLines} && ${noInputScroll}`, 3000), JSON.stringify(await js(inputSize)))
  check('attach and send stay aligned with the bottom of the growing input', await js(`(() => {
    const bounds = ${composer(0)}.getBoundingClientRect()
    const buttons = [...${inputRow}.querySelectorAll('button')]
    return buttons.length === 2 && buttons.every(button => {
      const rect = button.getBoundingClientRect()
      return Math.abs(rect.bottom - bounds.bottom) < 1 && (rect.right <= bounds.left || rect.left >= bounds.right)
    })
  })()`))
  const wrapped = await js(inputSize)
  await js(`${inputRow}.style.removeProperty('max-width')`)
  check('widening the input reflows the same draft', await until(`${composer(0)}.offsetHeight < ${wrapped.height} && ${noInputScroll}`, 3000))
  await shot('local-agent-chat-multiline-composer')
  await setChatDraft('첫 줄\n둘째 줄\n셋째 줄')
  check('explicit line breaks grow the input too', await until(`${threeLines} && ${noInputScroll}`, 3000))
  await setChatDraft('검토할 내용\n'.repeat(14))
  check('long drafts scroll within the composer at the eight-line limit', await until(`
    Math.abs(${composer(0)}.offsetHeight - ${single.height + single.lineHeight * 7}) <= 2 &&
    ${composer(0)}.scrollHeight > ${composer(0)}.clientHeight
  `, 3000))
  await setChatDraft('')
  check('clearing the text brings back the single-line composer', await until(`${composer(0)}.offsetHeight === ${single.height} && !${composer(0)}.value`, 3000))

  // The same PTY stays interactive beneath the conversation until the checklist closes.
  const checklist = `${cover(0)}?.querySelector('.agent-chat-inline-question')`
  const questionScreen = `${pane(0)}?.querySelector('[data-chat-question] > .local-terminal-host')`
  const questionInputFile = (await js(`${pane(0)}.dataset.localShellId`)).replace(':', '-') + '-input'
  fs.writeFileSync(file('claude-1-program-status'), 'state=working:app=claude')
  await until(`${cover(0)}.querySelector('.agent-chat-status')?.dataset.status === 'working'`, 5000)
  fs.writeFileSync(file('claude-1-approval'), [
    '─'.repeat(60), '←  □ 확인 범위  ✓ Submit  →', '', '│ 어떤 내용을 확인할까요?', '',
    '❯ 1. [ ] 첫 번째 항목', '  2. [ ] 두 번째 항목', '  3. [ ] Type something',
    '   Submit', '─'.repeat(60), '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'
  ].join('\r\n'))
  check('a Claude checklist shows the live question under the conversation', await until(`
    ${checklist}?.textContent.includes('답변 대기 중') && ${checklist}.textContent.includes('어떤 내용을 확인할까요?') &&
    ${questionScreen}?.textContent.includes('첫 번째 항목') && !${questionScreen}.inert &&
    ${questionScreen}.getBoundingClientRect().top >= ${cover(0)}.getBoundingClientRect().bottom - 1 &&
    ${cover(0)}.querySelector('.agent-chat-status')?.dataset.status === 'blocked' &&
    ${composer(0)}.readOnly && !${cover(0)}.querySelector('.agent-chat-approval-option')
  `, 8000))
  fs.writeFileSync(file('claude-1-program-status'), 'state=idle:app=claude')
  await waitFor(() => !fs.existsSync(file('claude-1-program-status')))
  check('the same unanswered question shows response needed in chat and in the shared agent state', await until(`
    ${cover(0)}.querySelector('.agent-chat-status')?.textContent.trim() === '응답 필요' &&
    window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent => agent.id === 'claude-1' && agent.status === 'blocked'))
  `, 5000))
  await shot('local-agent-chat-inline-question')
  await click(...await center(`${checklist}.querySelector('button')`))
  check('the answer button focuses the checklist inside chat without sending a choice', await until(`
    !!${cover(0)} && !${pane(0)}.querySelector('.agent-screen-return') &&
    ${questionScreen}?.querySelector('.xterm-helper-textarea') === document.activeElement
  `, 8000) && !read('claude-1-approval-answer'))
  const beforeQuestionKeys = read(questionInputFile).length
  const pressQuestionKey = async (key, windowsVirtualKeyCode, code = key) => {
    const params = { key, code, windowsVirtualKeyCode }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  await pressQuestionKey('ArrowDown', 40)
  await pressQuestionKey('Enter', 13)
  check('navigation and selection reach the same PTY', !!await waitFor(() =>
    /^\x1b(?:\[|O)B\r$/.test(read(questionInputFile).slice(beforeQuestionKeys))))
  fs.writeFileSync(file('claude-1-approval'), [
    'Review your answers', '  선택: 두 번째 항목', '',
    '❯ 1. Submit answers', '  2. Go back', 'Tab/Arrow keys to navigate · Esc to cancel'
  ].join('\r\n'))
  check('reviewing the answers keeps the checklist and keyboard focus in chat', await until(`
    !!${checklist} && ${questionScreen}?.textContent.includes('Review your answers') &&
    ${questionScreen}.querySelector('.xterm-helper-textarea') === document.activeElement
  `, 8000))
  await pressQuestionKey('Enter', 13)
  check('submitting the review sends only the user’s Enter', !!await waitFor(() =>
    /^\x1b(?:\[|O)B\r\r$/.test(read(questionInputFile).slice(beforeQuestionKeys))))
  fs.writeFileSync(file('claude-1-approval'), '')
  fs.writeFileSync(file('claude-1-program-status'), 'state=idle:app=claude')
  check('closing the checklist restores the regular chat composer', await until(`
    ${composer(0)} === document.activeElement && !${checklist} && !${questionScreen} && ${pane(0)}.querySelector('.local-terminal-host').inert &&
    window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent => agent.id === 'claude-1' && agent.status === 'idle'))
  `, 8000))

  fs.writeFileSync(file('claude-1-approval'), [
    '─'.repeat(60), ' Accessing workspace:', '', ' C:\\temp\\new-workspace', '',
    ' Quick safety check: Is this a project you created or one you trust?', '',
    ' Security guide', '', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'
  ].join('\r\n'))
  check('Claude folder trust shows the real terminal and blocks the chat composer', await until(`
    ${checklist}?.textContent.includes('이 폴더를 신뢰할지 터미널에서 답해 주세요.') &&
    ${questionScreen}?.textContent.includes('Yes, I trust this folder') && !${questionScreen}.inert &&
    ${cover(0)}.querySelector('.agent-chat-status')?.dataset.status === 'blocked' &&
    ${composer(0)}.readOnly && !${cover(0)}.querySelector('.agent-chat-approval-option') &&
    window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent => agent.id === 'claude-1' && agent.status === 'blocked'))
  `, 8000))
  const beforeTrustKeys = read(questionInputFile).length
  // xterm sends its own focus reports when the user moves between the chat and terminal.
  const trustKeys = () => read(questionInputFile).slice(beforeTrustKeys).replace(/\x1b\[[IO]/g, '')
  check('a direct chat send is rejected without typing into folder trust', await js(`
    window.electronAPI.agentChatSend(${pane(0)}.dataset.localShellId, 'This must not be pasted').then(result => result.ok === false)
  `) && trustKeys() === '')
  await click(...await center(`${checklist}.querySelector('button')`))
  check('the folder trust button focuses the terminal without selecting a choice', await until(`
    ${questionScreen}?.querySelector('.xterm-helper-textarea') === document.activeElement
  `) && trustKeys() === '', JSON.stringify(trustKeys()))
  await pressQuestionKey('Enter', 13)
  check('only the user’s Enter reaches the folder trust prompt', !!await waitFor(() => trustKeys() === '\r'), JSON.stringify(trustKeys()))
  fs.writeFileSync(file('claude-1-approval'), '')
  check('after folder trust closes the keyboard returns to the chat composer', await until(`
    ${composer(0)} === document.activeElement && !${composer(0)}.readOnly && !${checklist} && !${questionScreen}
  `, 8000))

  const shells = `${cover(0)}?.querySelector('.agent-chat-background-shells')`
  const shellFooter = badge => ['─'.repeat(60), '> ', '─'.repeat(60), '  ⏵⏵ auto mode on' + badge, '\x1b[2;3H'].join('\r\n')
  fs.writeFileSync(file('claude-1-screen'), shellFooter(' · 1 shell · ↓ to manage'))
  check('a background Shell is visible below the chat while Claude accepts input', await until(`
    ${shells}?.querySelector('summary').textContent.includes('Shell 1개 실행 중') && !${shells}.open && !!${composer(0)}
  `, 8000))
  const shellCall = 'toolu_shell_test'
  fs.appendFileSync(firstTranscript, line({ type: 'assistant', uuid: 'shell-call', message: { content: [{
    type: 'tool_use', name: 'Bash', id: shellCall, input: { command: 'npm run dev', description: '개발 서버 시작', run_in_background: true }
  }] } }) + line({ type: 'user', toolUseResult: { backgroundTaskId: 'shell-test' }, message: {
    content: [{ type: 'tool_result', tool_use_id: shellCall, content: 'Command running in background' }]
  } }))
  await js(`${shells}.querySelector('summary').click()`)
  check('expanding the Shell count shows the recorded command without leaving chat', await until(`
    ${shells}?.open && ${shells}.querySelector('.agent-chat-shell-jobs code')?.textContent === 'npm run dev' && !!${composer(0)}
  `, 8000))
  await shot('local-agent-chat-background-shell')
  fs.writeFileSync(file('claude-1-screen'), shellFooter(''))
  check('the Shell count goes away as soon as the terminal footer clears', await until(`!${shells} && !!${composer(0)}`, 8000))
  fs.appendFileSync(firstTranscript, line({ type: 'user', isMeta: true, message: {
    content: '<task-notification><task-id>shell-test</task-id><status>completed</status></task-notification>'
  } }))
  fs.writeFileSync(file('claude-1-screen'), '')

  await chooseChatTheme(0, '미드나잇')
  check('Midnight uses a dark canvas without touching the app theme', await until(`
    ${cover(0)}.dataset.chatTheme === 'chat-midnight' && getComputedStyle(${cover(0)}).colorScheme === 'dark' &&
    ${appTheme} === ${JSON.stringify(beforeChatTheme[0])} && !${cover(0)}.querySelector('.agent-chat-timestamp[data-always-visible]')
  `))
  check('Midnight swaps the pane trace to its own color', await until(`${paneVar('--motion-accent')} === '#8fd3ff'`))
  await shot('local-agent-chat-midnight')

  for (const [name, id, scheme, canvas, bubble] of [
    ['디스코드풍', 'chat-discord', 'dark', 'rgb(39, 42, 52)', 'rgb(61, 66, 98)'],
    ['레트로 아케이드', 'chat-arcade', 'dark', 'rgb(8, 27, 24)', 'rgb(21, 57, 46)'],
    ['복숭아 소다', 'chat-peach', 'light', 'rgb(255, 240, 232)', 'rgb(255, 213, 205)'],
    ['네온 시티', 'chat-neon', 'dark', 'rgb(24, 17, 32)', 'rgb(74, 36, 83)'],
    ['앰버 CRT', 'chat-amber', 'dark', 'rgb(27, 20, 12)', 'rgb(78, 50, 22)'],
    ['흑백 만화', 'chat-comic', 'light', 'rgb(239, 237, 232)', 'rgb(222, 219, 212)']
  ]) {
    await chooseChatTheme(0, name)
    check(`${name} applies its own canvas, bubble and color scheme`, await until(`
      ${cover(0)}.dataset.chatTheme === ${JSON.stringify(id)} &&
      getComputedStyle(${cover(0)}).colorScheme === ${JSON.stringify(scheme)} &&
      getComputedStyle(${cover(0)}).backgroundColor === ${JSON.stringify(canvas)} &&
      getComputedStyle(${cover(0)}.querySelector('.agent-chat-user .agent-chat-bubble')).backgroundColor === ${JSON.stringify(bubble)} &&
      getComputedStyle(${cover(0)}.querySelector('.agent-chat-log')).backgroundImage !== 'none' &&
      ${appTheme} === ${JSON.stringify(beforeChatTheme[0])}
    `))
    await shot(`local-agent-${id}`)
  }

  for (const [name, id, scheme] of [
    ['macOS Light', 'macos-light', 'light'],
    ['macOS Dark', 'macos-dark', 'dark']
  ]) {
    await chooseChatTheme(0, name)
    check(`${name} gives the chat rounded controls and bubbles while the app uses the square theme`, await until(`
      ${cover(0)}.dataset.chatTheme === ${JSON.stringify(id)} &&
      getComputedStyle(${cover(0)}).colorScheme === ${JSON.stringify(scheme)} &&
      getComputedStyle(${composer(0)}).borderTopLeftRadius === '7px' &&
      getComputedStyle(${cover(0)}.querySelector('.agent-chat-user .agent-chat-bubble')).borderTopLeftRadius === '10px' &&
      getComputedStyle(${chatThemeButton(0)}).borderTopLeftRadius === '5px' &&
      getComputedStyle(document.documentElement).getPropertyValue('--radius-md').trim() === '0' &&
      ${appTheme} === ${JSON.stringify(beforeChatTheme[0])}
    `))
    await shot(`local-agent-chat-${id}`)
  }

  await chooseChatTheme(0, 'Nord')
  check('an existing app theme can be selected solely for the chat', await until(`
    ${cover(0)}.dataset.chatTheme === 'nord' && !${cover(0)}.hasAttribute('data-chat-bubbles') &&
    ${appTheme} === ${JSON.stringify(beforeChatTheme[0])}
  `))
  await chooseChatTheme(0, '앱 테마 따르기')
  check('following the app removes the local palette', await until(`!${cover(0)}.hasAttribute('data-chat-theme') && ${paneVar('--chat-focus')} === ''`))
  const questionPanel = index => `${cover(index)}.querySelector('.agent-chat-questions')`
  const openQuestions = index => chooseChatAction(index, '질문 목록')
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
  await setChatDraft('가'.repeat(16001))
  await js(`${cover(0)}.querySelector('.agent-chat-send').click()`)
  check('a rejected send restores the draft and removes its optimistic bubble', await until(`
    [...document.querySelectorAll('.toast')].some(toast => toast.textContent.includes('보내지 못했습니다')) &&
    ${composer(0)}.value === '가'.repeat(16001) &&
    ${cover(0)}.querySelector('[data-chat-row="item:user:u1"]')?.textContent.includes('첫 칸 질문') &&
    !${cover(0)}.querySelector('[data-chat-row^="item:outgoing:"]') &&
    !${cover(0)}.querySelector('.agent-chat-reply-progress')
  `, 3000))
  await setChatDraft('')

  // 2026-11-23 user request: Claude's AskUserQuestion answered on the chat's own card. The questions come
  // from the transcript; main presses the keys of the (fake) dialog and submits once its review matches.
  const askCard = `${cover(0)}?.querySelector('.agent-ask')`
  const askQuestions = [
    { question: '어떤 과일을 넣을까요?', header: '과일', multiSelect: true, options: [{ label: 'Apple', description: '빨간 과일' }, { label: 'Banana', description: '노란 과일' }, { label: 'Cherry', description: '작은 과일' }] },
    { question: '어떤 색으로 할까요?', header: '색', multiSelect: false, options: [{ label: 'Red', description: '따뜻한 색' }, { label: 'Green', description: '차분한 색' }] }
  ]
  const askTool = (uuid, id, questions) => line({ type: 'assistant', uuid, timestamp: '2026-11-19T10:05:00Z', message: { id: uuid, role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions } }] } })
  const clickAskControl = async target => {
    if (!await until(`(${target})?.disabled === false`, 3000)) throw new Error(`question control stayed disabled: ${target}`)
    await click(...await center(target))
  }
  const clickAsk = selector => clickAskControl(`${askCard}.querySelector(${JSON.stringify(selector)})`)
  const clickAskOption = label => clickAskControl(`[...${askCard}.querySelectorAll('.agent-ask-option')].find(button => button.textContent.includes(${JSON.stringify(label)}))`)
  // A toast left by the checks above would cover the card's buttons
  await js(`document.querySelectorAll('.toast .toast-close').forEach(button => button.click())`)
  await until(`!document.querySelector('.toast')`, 5000)
  await setChatDraft('질문 전 초안')
  await js(`${composer(0)}.focus()`)
  fs.appendFileSync(firstTranscript, askTool('a-ask', 'toolu_ask', askQuestions))
  fs.writeFileSync(file('claude-1-program-status'), 'state=working:app=claude')
  fs.writeFileSync(file('claude-1-ask-dialog'), JSON.stringify(askQuestions))
  check('Claude’s question card leaves the draft focused and read-only', await until(`
    ${askCard}?.textContent.includes('어떤 과일을 넣을까요?') && ${askCard}.textContent.includes('빨간 과일') &&
    ${askCard}.querySelectorAll('.agent-ask-step').length === 3 && !${questionScreen} && ${composer(0)}.readOnly &&
    document.activeElement === ${composer(0)} && ${composer(0)}.value === '질문 전 초안' &&
    ${cover(0)}.querySelector('.agent-ask-summary')?.textContent.includes('답변 대기 중')
  `, 8000))
  await until(`${askCard}?.querySelector('.agent-ask-option')?.disabled === false`, 3000)
  await pressQuestionKey('1', 49, 'Digit1')
  await pressQuestionKey(' ', 32, 'Space')
  await driver.enter()
  check('keys in the blocked composer neither change the draft nor choose an answer', await js(`
    ${composer(0)}.value === '질문 전 초안' && !${askCard}.querySelector('[aria-checked=true]') &&
    ${cover(0)}.querySelector('.agent-chat-send').disabled
  `) && !read('claude-1-ask-submitted'))
  await shot('local-agent-chat-ask-card')
  await clickAskOption('Apple')
  await clickAskOption('Cherry')
  await clickAskOption('직접 입력')
  await until(`document.activeElement === ${askCard}?.querySelector('.agent-ask-input')`, 3000)
  await send('Input.insertText', { text: '빨간사과' })
  await driver.enter()
  check('Enter in a focused free-text answer advances to the next question', await until(`${askCard}?.textContent.includes('어떤 색으로 할까요?')`, 3000))
  await clickAskOption('Green')
  check('the review lists every answer before sending', await until(`
    ${askCard}?.querySelector('.agent-ask-review')?.textContent.includes('Apple, Cherry, 빨간사과') && ${askCard}.textContent.includes('Green')
  `, 3000))
  await shot('local-agent-chat-ask-review')
  await clickAsk('.agent-ask-review .agent-ask-send')
  const submitted = await waitFor(() => read('claude-1-ask-submitted'))
  check('main answered Claude’s dialog with the chosen answers', submitted === JSON.stringify(['Apple, Cherry, 빨간사과', 'Green']))
  fs.appendFileSync(firstTranscript, line({
    type: 'user', uuid: 'u-ask', timestamp: '2026-11-19T10:05:30Z', toolUseResult: { questions: askQuestions, answers: { '어떤 과일을 넣을까요?': 'Apple, Cherry, 빨간사과', '어떤 색으로 할까요?': 'Green' } },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: 'Your questions have been answered' }] }
  }))
  fs.writeFileSync(file('claude-1-program-status'), 'state=idle:app=claude')
  check('the answered question stays in the conversation with its answers', await until(`
    !${askCard} && ${composer(0)}.readOnly === false && ${composer(0)}.value === '질문 전 초안' &&
    ${cover(0)}.querySelector('.agent-ask-summary')?.textContent.includes('Apple, Cherry, 빨간사과')
  `, 8000))
  await setChatDraft('')

  // The card's own way out: the same dialog in the terminal under the chat, as before
  fs.unlinkSync(file('claude-1-ask-submitted'))
  const colorOnly = [askQuestions[1]]
  fs.appendFileSync(firstTranscript, askTool('a-ask-2', 'toolu_ask_2', colorOnly))
  fs.writeFileSync(file('claude-1-program-status'), 'state=working:app=claude')
  fs.writeFileSync(file('claude-1-ask-dialog'), JSON.stringify(colorOnly))
  await until(`${askCard}?.textContent.includes('어떤 색으로 할까요?')`, 8000)
  await clickAsk('.agent-ask-terminal')
  check('answering in the terminal brings back the live dialog under the chat', await until(`
    !${askCard} && ${questionScreen}?.textContent.includes('Type something') && !!${checklist}
  `, 8000))
  // Answered there with its number key, as in the CLI
  await until(`${questionScreen}?.querySelector('.xterm-helper-textarea') === document.activeElement`, 3000)
  await send('Input.insertText', { text: '1' })
  check('the key typed in that terminal answers the dialog', (await waitFor(() => read('claude-1-ask-submitted'))) === JSON.stringify(['Red']))
  fs.appendFileSync(firstTranscript, line({
    type: 'user', uuid: 'u-ask-2', timestamp: '2026-11-19T10:06:00Z', toolUseResult: { answers: { '어떤 색으로 할까요?': 'Red' } },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask_2', content: 'answered' }] }
  }))
  fs.writeFileSync(file('claude-1-program-status'), 'state=idle:app=claude')
  await until(`!!${composer(0)} && !${questionScreen}`, 8000)

  // Choices with previews (2026-11-23 user report: that dialog was not recognized, the chat had neither the
  // card nor a waiting sign): the card shows the pointed-at choice's preview, no typed answer, and sends
  // only with its button; main moves the selection with the number and picks it with Enter
  fs.unlinkSync(file('claude-1-ask-submitted'))
  const photo = [{ question: '카드에 넣을 사진의 출처를 정해 주세요.', header: '유형별 사진', multiSelect: false, options: [
    { label: '기존 아이콘으로 유형 카드 (Recommended)', description: '아이콘', preview: '+----------+\n| [아이콘] |\n+----------+' },
    { label: '이미지 파일을 받아서 적용', description: '파일', preview: '+--------+\n| upload |\n|        |\n|        |\n|        |\n|        |\n+--------+' },
    { label: '나중에 정하기', description: '보류' }
  ] }]
  fs.appendFileSync(firstTranscript, askTool('a-ask-3', 'toolu_ask_3', photo))
  fs.writeFileSync(file('claude-1-program-status'), 'state=working:app=claude')
  fs.writeFileSync(file('claude-1-ask-dialog'), JSON.stringify(photo))
  check('a question with previews shows as a card with the first choice’s preview and no typed answer', await until(`
    ${askCard}?.textContent.includes('카드에 넣을 사진') && ${askCard}.querySelector('.agent-ask-preview-text[data-shown]')?.textContent.includes('[아이콘]') &&
    ![...${askCard}.querySelectorAll('.agent-ask-option')].some(button => button.textContent.includes('직접 입력'))
  `, 8000))
  // The card keeps its height from choice to choice (2026-11-27 user report: the preview box took the shown
  // preview's size, the card grew and shrank, and the choices moved under the pointer)
  const askHeight = () => js(`Math.round(${askCard}.getBoundingClientRect().height)`)
  const heightBefore = await askHeight()
  const later = `[...${askCard}.querySelectorAll('.agent-ask-option')].find(button => button.textContent.includes('나중에 정하기'))`
  // The choices take the pointer once the card is armed (a disabled button gets no pointer events)
  await until(`(${later})?.disabled === false`, 3000)
  const [laterX, laterY] = await center(later)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: laterX, y: laterY })
  const saysNone = await until(`${askCard}.querySelector('.agent-ask-preview-text[data-shown]')?.textContent.includes('미리보기가 없는')`, 3000)
  const heightPointed = await askHeight()
  check('pointing at a choice without a preview says so and keeps the card’s height', saysNone && heightPointed === heightBefore,
    JSON.stringify({ saysNone, heightBefore, heightPointed }))
  await clickAskOption('이미지 파일을 받아서 적용')
  check('picking a choice shows its preview and does not send yet', await until(`
    ${askCard}?.querySelector('.agent-ask-preview-text[data-shown]')?.textContent.includes('upload') && !${askCard}.querySelector('.agent-ask-sending')
  `, 3000) && !read('claude-1-ask-submitted') && (await askHeight()) === heightBefore)
  await shot('local-agent-chat-ask-preview')
  await clickAsk('.agent-ask-send')
  check('its send button answers the dialog with the picked choice', (await waitFor(() => read('claude-1-ask-submitted'))) === JSON.stringify(['이미지 파일을 받아서 적용']))
  fs.appendFileSync(firstTranscript, line({
    type: 'user', uuid: 'u-ask-3', timestamp: '2026-11-19T10:06:30Z', toolUseResult: { answers: { '카드에 넣을 사진의 출처를 정해 주세요.': '이미지 파일을 받아서 적용' } },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ask_3', content: 'answered' }] }
  }))
  fs.writeFileSync(file('claude-1-program-status'), 'state=idle:app=claude')
  await until(`!!${composer(0)} && !${askCard}`, 8000)
  check('the conversation can be selected by dragging (the app turns selection off elsewhere)', await js(`getComputedStyle(${cover(0)}.querySelector('.agent-chat-log')).userSelect === 'text'`))

  // A Windows drive path with Codex's leading slash opens its preview from the answer
  const note = file('linked-note.txt')
  fs.writeFileSync(note, '링크로 연 파일')
  fs.appendFileSync(path.join(projects, `${SESSIONS[0]}.jsonl`), answer('a-link', `메모는 [linked-note.txt](/${note.replace(/\\/g, '/')}) 에 있습니다`))
  const driveLink = `${cover(0)}.querySelector('.agent-chat-md a[href^="/"][href$="linked-note.txt"]')`
  check('a slash-prefixed Windows drive path shows as a file link', await until(`!!${driveLink}`, 8000), await coverText(0))
  await js(`${driveLink}.scrollIntoView({ block: 'nearest' })`)
  const link = await center(driveLink)
  await click(link[0], link[1])
  const previewActions = `document.querySelector('.chat-link-preview-actions')`
  const previewAction = label => `[...${previewActions}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`
  check('the file preview shows its data, metadata and three actions', await until(`(() => {
    if (!${previewActions}) return false
    const labels = [...${previewActions}.querySelectorAll('button')].map(item => item.textContent.trim())
    return labels.join('|') === 'ezShell로 열기|파일 탐색기로 열기|경로 복사' &&
      !!document.querySelector('.chat-link-preview-metadata time')?.dateTime &&
      document.querySelector('.chat-link-preview .cm-content')?.textContent.includes('링크로 연 파일')
  })()`, 4000))
  await js(`${previewAction('ezShell로 열기')}.click()`)
  let fileWindow = null
  for (let tries = 0; tries < 60 && !fileWindow; tries++) {
    fileWindow = (await pages()).find(page => /remoteFileMode=true/.test(page.url))
    if (!fileWindow) await sleep(150)
  }
  check('ezShell opens the file in its file window', !!fileWindow, JSON.stringify((await pages()).map(page => page.url)))
  await js(`document.querySelector('.chat-link-preview [aria-label="미리보기 닫기"]').click()`)
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
  // Claude often writes a path as inline code, not as a link (2026-11-23 user report: it could not be opened)
  const coded = file('coded-path.sql')
  fs.writeFileSync(coded, 'select 1;')
  fs.appendFileSync(path.join(projects, `${SESSIONS[0]}.jsonl`), answer('a-code-path', `파일 위치: \`${coded}\``))
  const codeLink = `${cover(0)}.querySelector('.agent-chat-md a.md-code-link[href$="coded-path.sql"]')`
  check('a path written as inline code shows as a file link', await until(`!!${codeLink} && !!${codeLink}.querySelector('code')`, 8000), await coverText(0))
  const codeOpen = await js(`window.electronAPI.agentChatOpenLink(${JSON.stringify(shellOfChat)}, ${codeLink}.getAttribute('href'), 'app')`)
  check('that link opens (main counts the inline code as a link of the conversation)', codeOpen?.ok === true, JSON.stringify(codeOpen))
  // A folder link opens the workspace panel's file tree up to that folder (2026-11-24 user request)
  fs.mkdirSync(file(path.join('reveal-me', 'inner-folder')), { recursive: true })
  fs.writeFileSync(file(path.join('reveal-me', 'inner-folder', 'deep.txt')), '안')
  fs.appendFileSync(path.join(projects, `${SESSIONS[0]}.jsonl`), answer('a-folder-link', '시안은 `reveal-me/inner-folder/` 폴더에 있습니다'))
  const folderLink = `${cover(0)}.querySelector('.agent-chat-md a.md-code-link[href="reveal-me/inner-folder/"]')`
  check('a folder written as inline code shows as a link', await until(`!!${folderLink}`, 8000), await coverText(0))
  await js(`${folderLink}.scrollIntoView({ block: 'nearest' })`)
  await click(...await center(folderLink))
  const revealedRow = `[...document.querySelectorAll('.workspace-panel .workspace-tree-row')].find(row => row.textContent.trim() === 'inner-folder')`
  check('clicking it opens the workspace files tree up to that folder and lights it', await until(`
    !!${revealedRow} && ${revealedRow}.classList.contains('is-revealed') && ${revealedRow}.getAttribute('aria-expanded') === 'true' &&
    [...document.querySelectorAll('.workspace-panel .workspace-tree-row')].some(row => row.textContent.trim() === 'deep.txt')
  `, 10000), await js(`document.querySelector('.workspace-panel')?.innerText.slice(0, 600) ?? 'no panel'`))
  await shot('local-agent-chat-folder-reveal')
  await js(`document.querySelector('.workspace-panel .workspace-close[aria-label="작업 공간 닫기"]')?.click()`)
  check('the terminal stays mounted under the chat', await js(`!!${pane(0)}.querySelector('.xterm-screen') && ${pane(0)}.querySelector('.xterm-screen').offsetWidth > 0`))
  await checkChatLinkPreviews({ driver, cover: cover(0), shellId: shellOfChat, profile, check,
    addAnswer: text => fs.appendFileSync(firstTranscript, answer('a-previews', text)) })

  // An answer pinned out into a small window of its own, read while working in another tab
  await chooseChatTheme(0, '카톡 모드')
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
    const pinCanvas = `getComputedStyle(document.querySelector('.pinned-reply')).backgroundColor`
    check('the pinned reply opens with the chat palette and the reply bubble', await pin.js(`
      ${pinCanvas} === 'rgb(220, 232, 244)' &&
      getComputedStyle(document.querySelector('.pinned-reply-message')).backgroundColor === 'rgb(255, 255, 255)'
    `))
    await pin.shot('local-agent-chat-pinned-theme')
    await chooseChatTheme(0, '미드나잇')
    check('an open pin follows changes to the chat theme', await pin.until(`${pinCanvas} === 'rgb(19, 22, 37)'`))
    await chooseChatTheme(0, '앱 테마 따르기')
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
    const [normalWidth, normalHeight] = await pin.js('[innerWidth, innerHeight]')
    const maximize = `document.querySelector('.pinned-reply-btn[data-action="maximize"]')`
    const fold = `document.querySelector('.pinned-reply-btn[data-action="fold"]')`
    const maximized = `${maximize}.getAttribute('aria-label') === '이전 크기로 복원' && innerWidth > ${normalWidth} && innerHeight > ${normalHeight}`
    await pin.js(`${maximize}.click()`)
    check('the pinned answer maximizes', await pin.until(maximized, 3000), await pin.js('[innerWidth, innerHeight]'))
    await pin.js(`${fold}.click()`)
    check('a maximized reply still folds to its header', await pin.until(`innerHeight <= 48 && ${maximize}.disabled`, 3000))
    await pin.js(`${fold}.click()`)
    check('unfolding returns the reply to its maximized size', await pin.until(maximized, 3000))
    await pin.js(`${maximize}.click()`)
    check('restore returns to the original size', await pin.until(`
      ${maximize}.getAttribute('aria-label') === '최대화' && innerWidth === ${normalWidth} && innerHeight === ${normalHeight}
    `, 3000), await pin.js('[innerWidth, innerHeight]'))
    await chooseChatAction(0, '채팅 닫고 터미널로 전환')
    await until(`!${cover(0)}`, 3000)
    await pin.js(`${maximize}.click()`)
    await pin.until(maximized, 3000)
    await pin.js(`document.querySelector('.pinned-reply-btn[data-action="source"]').click()`)
    check('원래 대화로 가기 shows that pane as a chat again', await until(`!!${cover(0)}`, 5000))
    check('returning to the chat restores the pin so the chat is visible', await pin.until(`
      ${maximize}.getAttribute('aria-label') === '최대화' && innerWidth === ${normalWidth}
    `, 3000))
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
    const browserTabId = await js(`document.querySelector('.terminal-tab.active[data-tab-id^="browser:"]').dataset.tabId`)
    await js(`document.querySelector(${JSON.stringify(firstTab)}).click()`)
    check('returning to the chat tab focuses its composer and shows the pane outline', await until(focusedChat(0), 2500))
    fs.appendFileSync(firstTranscript, answer('a-preview-narrow', '[이미지](preview/workspace.png)'))
    await checkSplitChatLinkPreview({ driver, cover: cover(0), browserTabId, profile, check })
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
  check('the pane outline follows the clicked composer in a split chat', await until(`
    ${focusedChat(0)} && !${pane(1)}.matches(':focus-within') && getComputedStyle(${pane(1)}, '::before').borderTopWidth === '1px'
  `, 2500))
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
    ${cover(1)}.querySelector('.agent-chat-incoming + .agent-chat-usage')?.previousElementSibling?.querySelector('.agent-chat-md')?.textContent.includes('정리했습니다')
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
  check('a Claude question shows the before and after readings for both windows', await until(`
    ${usageLine}.endsWith('|토큰 입력 100 · 출력 5 · 5시간 20% → 23% (+3%p) · 주간 50% → 51% (+1%p)')
  `, 8000), await js(usageLine))
  await shot('local-agent-chat-turn-usage')

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

  await setChatDraft('/login')
  await js(`${cover(0)}.querySelector('.agent-chat-send').click()`)
  check('Claude login hands off to the terminal even with the old composer painted', await until(`
    !${cover(0)} && ${pane(0)}.querySelector('.agent-screen-return')?.textContent.includes('Claude 로그인')
  `, 8000))
  fs.writeFileSync(file('claude-1-screen'), [
    '────────────', '❯ ', '────────────', '? for shortcuts', 'Login', '',
    '  Logged in as test@example.test', '  ✓ Login successful. Press Enter to continue'
  ].join('\r\n'))
  check('the login confirmation asks for Enter and waits for the user', await until(`
    ${pane(0)}.querySelector('.agent-screen-return')?.textContent.includes('Enter를 눌러')
  `, 8000) && !read('claude-1-login-closed'))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  check('one Enter completes login and returns focus to chat', await waitFor(() => read('claude-1-login-closed') === 'confirmed') &&
    await until(`!!${composer(0)} && document.activeElement === ${composer(0)} && !${pane(0)}.querySelector('.agent-screen-return')`, 8000))

  // 2026-11-26 user report: a screen the CLI opened by itself ("Teach auto mode about your environment?")
  // stood in the terminal while the chat showed nothing. It goes to the terminal too, and back once it closes
  fs.writeFileSync(path.join(profile, 'claude-1-screen'), [
    'Teach auto mode about your environment?',
    '',
    '  How you use Claude here     Mixed',
    '❯ Also scan shell history     on',
    '  Also scan your other repos  off',
    '',
    '  Continue',
    '',
    '↑/↓ to navigate · Space to toggle · Esc to cancel'
  ].join('\r\n'))
  check('a screen the CLI opens by itself hands the pane to the terminal', await until(`!${cover(0)} && !!document.querySelector('.agent-screen-return')`, 10000))
  fs.writeFileSync(path.join(profile, 'claude-1-screen'), '')
  check('once that screen closes the pane is a chat again', await until(`!!${cover(0)} && !document.querySelector('.agent-screen-return')`, 8000))
  await until(`document.activeElement === ${cover(0)}?.querySelector('.agent-chat-input')`, 3000)

  // Sending from the first chat types into that agent's composer only
  const numberedLead = '1. 첫 번째 항목만 넣어 줘'
  const numberedDraft = `${numberedLead}\n2. 지난 기록도 포함해 줘\n3. 확인이 필요한 목록은 따로 적어 줘`
  await js(`${cover(0)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.insertText', { text: numberedDraft })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  check('the numbered draft reaches the first Claude composer and is submitted', await waitFor(() => read('claude-1-chat-sent') === '2'), read('claude-1-chat-text'))
  check('it is exactly what was written', read('claude-1-chat-text') === numberedDraft, JSON.stringify(read('claude-1-chat-text')))
  check('the second agent got nothing', !read('manual-claude-chat-text'))
  check('the box is cleared after sending', await until(`${cover(0)}.querySelector('.agent-chat-input').value === ''`, 3000))
  const plain = fs.existsSync(file(String(firstShell).replace(':', '-') + '-input')) ? fs.readFileSync(file(String(firstShell).replace(':', '-') + '-input'), 'utf8') : ''
  check('the line did not go through the terminal\'s own input', !plain.includes(numberedLead))
  // Not in the transcript yet (Claude writes a slash command only when it is done): a look at the
  // terminal and back keeps it shown (2026-11-20 user report: a /compact sent from the chat vanished)
  check('the sent line shows in the chat at once', await until(`[...${cover(0)}.querySelectorAll('.agent-chat-user')].some(bubble => bubble.textContent.includes(${JSON.stringify(numberedLead)}))`, 3000), await coverText(0))
  await chooseChatAction(0, '채팅 닫고 터미널로 전환')
  await until(`!${cover(0)}`, 3000)
  await js(`${pane(0)}.querySelector('.xterm-helper-textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  check('after a look at the terminal, the line not yet in the transcript is still shown', await until(`!!${cover(0)} && (${cover(0)}.textContent.includes('첫 칸 질문')) && [...${cover(0)}.querySelectorAll('.agent-chat-user')].some(bubble => bubble.textContent.includes(${JSON.stringify(numberedLead)}))`, 8000), await coverText(0))

  // The fixture provides an actual PNG from the main-process clipboard, like Windows Snipping Tool.
  const preview = `${cover(0)}.querySelector('.agent-chat-attachment img')`
  const sendButton = `${cover(0)}.querySelector('.agent-chat-send')`
  const sentImageMessage = text => `[...${cover(0)}.querySelectorAll('.agent-chat-user')]
    .find(row => row.querySelector('.agent-chat-bubble')?.textContent.trim() === ${JSON.stringify(text)})`
  const sentImageWidths = text => `[...(${sentImageMessage(text)})?.querySelectorAll('.agent-chat-sent-images img') ?? []]
    .map(img => img.naturalWidth).join(',')`
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
  const clipboardBody = '[첨부이미지 1] [첨부이미지 2] 클립보드 텍스트'
  check('text paste still fills the draft and retains the screenshots', await until(`${cover(0)}.querySelectorAll('.agent-chat-attachment').length === 2 &&
    ${composer(0)}.value === ${JSON.stringify(clipboardBody)} && !${sendButton}.disabled`))
  await js(`${sendButton}.click()`)
  const isPng = path => path?.endsWith('.png') && fs.existsSync(path) && fs.readFileSync(path).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  check('Claude receives both screenshots and exactly the entered text', await waitFor(() => {
    if (read('claude-1-chat-sent') !== '3') return false
    const [first, second, separator, body, ...extra] = read('claude-1-chat-text').split('\n')
    return !extra.length && separator === '' && body === clipboardBody && first !== second && isPng(first) && isPng(second)
  }), `${read('claude-1-chat-text')} ${await chatFeedback()}`)
  check('the draft preview is cleared after sending', await until(`!${preview} && !${cover(0)}.querySelector('.agent-chat-input').value`))
  check('both sent images appear above the text bubble', await until(`(() => {
    const row = ${sentImageMessage(clipboardBody)}
    const images = row?.querySelector('.agent-chat-sent-images')
    return ${sentImageWidths(clipboardBody)} === '1,1' &&
      images.getBoundingClientRect().bottom <= row.querySelector('.agent-chat-bubble').getBoundingClientRect().top
  })()`))
  fs.appendFileSync(firstTranscript, line({
    type: 'user', uuid: 'two-images', timestamp: new Date().toISOString(),
    message: { role: 'user', content: '[Image #1] [Image #2]\n' + clipboardBody }
  }))
  check('the transcript keeps the thumbnails and the references placed in the draft', await until(`
    !!${cover(0)}.querySelector('[data-chat-row="item:user:two-images"]') &&
    ${sentImageWidths(clipboardBody)} === '1,1'
  `))
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
    [...${cover(0)}.querySelectorAll('.agent-chat-user .agent-chat-bubble')].filter(bubble => bubble.textContent === '스크린샷 첨부').length === 1 &&
    ${sentImageWidths('스크린샷 첨부')} === '1'
  `))
  await chooseChatAction(0, '채팅 닫고 터미널로 전환')
  await until(`!${cover(0)}`)
  await js(`${pane(0)}.querySelector('.xterm-helper-textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
  check('the sent thumbnail is still present after switching away from the chat and returning', await until(`
    !!${cover(0)} && (() => ${sentImageWidths('스크린샷 첨부')} === '1')()
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
  const comparison = '세 이미지 비교해 줘.\n목록과 상세를 확인해 줘.'
  const comparisonBody = '[첨부이미지 1] [첨부이미지 2] [첨부이미지 3] ' + comparison
  await send('Input.insertText', { text: comparison })
  await js(`${sendButton}.click()`)
  check('all remaining images and the full text reach the unfocused composer', await waitFor(() => {
    if (read('claude-1-chat-sent') !== '5') return false
    const lines = read('claude-1-chat-text').split('\n')
    const separator = lines.indexOf('')
    const attachments = lines.slice(0, separator)
    return separator === 3 && new Set(attachments).size === 3
      && attachments.every((file, index) => fs.existsSync(file) && fs.readFileSync(file).readUInt32BE(16) === index + 1)
      && lines.slice(separator + 1).join('\n') === comparisonBody
  }), await chatFeedback())
  check('sending several images clears the entire attachment tray', await until(`${previewWidths} === ''`))
  check('sent thumbnails keep the order of the remaining images', await until(`${sentImageWidths(comparisonBody)} === '1,2,3'`))

  const longClaudeDraft = Array.from({ length: 40 }, (_, i) => `Claude paste fixture line ${i + 1}`).join('\n')
  fs.writeFileSync(file('claude-1-draft'), '기존 터미널 초안')
  await until(`window.electronAPI.agentChatScreenState(${JSON.stringify(firstShell)}).then(state => state?.composer === 'draft')`)
  fs.writeFileSync(file('claude-1-paste-chip'), '[Pasted text #2 +39 lines]')
  await setChatDraft(longClaudeDraft)
  await js(`${sendButton}.click()`)
  const forceSend = `${cover(0)}.querySelector('.agent-chat-force-send button')`
  check('a long Claude paste waits for the user to approve clearing the existing draft',
    await until(`!!${forceSend}`) && read('claude-1-chat-sent') === '5')
  await js(`${forceSend}?.click()`)
  check('a Claude paste chip after the forced clear sends the full text once',
    await waitFor(() => read('claude-1-chat-sent') === '6') && read('claude-1-chat-text') === longClaudeDraft, await chatFeedback())

  await driver.menuPick(...await center(chatLog(0)), '편의', '이미지 첨부…')
  check('the file picker attaches two images before the forced send', await until(`${previewWidths} === '2,3'`))
  fs.writeFileSync(file('claude-1-draft'), '[Image #1] [Pasted text #2 +41 lines]')
  await until(`window.electronAPI.agentChatScreenState(${JSON.stringify(firstShell)}).then(state => state?.composer === 'draft')`)
  fs.writeFileSync(file('claude-1-paste-chip'), '[Image #3] [Image #4][Pasted text #5 +39 lines]')
  const forcedImageBody = '[첨부이미지 1] [첨부이미지 2] ' + longClaudeDraft
  await setChatDraft(forcedImageBody)
  await js(`${sendButton}.click()`)
  check('a Claude image paste with an existing terminal draft waits for forced send',
    await until(`!!${forceSend}`) && read('claude-1-chat-sent') === '6' && await js(`${previewWidths} === '2,3'`), await chatFeedback())
  await js(`${forceSend}?.click()`)
  check('a Claude image paste chip after the forced clear sends both files and the full text once', await waitFor(() => {
    if (read('claude-1-chat-sent') !== '7') return false
    const [first, second, separator, ...body] = read('claude-1-chat-text').split('\n')
    return first !== second && separator === '' && body.join('\n') === forcedImageBody
      && [first, second].every((file, index) => fs.existsSync(file) && fs.readFileSync(file).readUInt32BE(16) === index + 2)
  }), await chatFeedback())
  check('the force-sent thumbnail order follows the attached files', await until(`${sentImageWidths(forcedImageBody)} === '2,3'`))

  // A permission prompt in the terminal shows as choices in the chat, and a choice answers it
  const approvalCard = `${cover(0)}?.querySelector('.agent-chat-approval')`
  const firstApprovalOption = `${approvalCard}?.querySelector('.agent-chat-approval-option')`
  fs.writeFileSync(file('claude-1-approval-answer'), '')
  await setChatDraft('승인 전 초안')
  await js(`${composer(0)}.focus()`)
  fs.writeFileSync(file('claude-1-approval'), '─'.repeat(60) + '\r\n Bash command\r\n\r\n   npm run build\r\n\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. Yes, and don\'t ask again for npm run build commands\r\n   3. No, and tell Claude what to do differently (esc)')
  check('the prompt shows in the chat with its question, command and choices', await until(`(() => {
    const card = ${approvalCard}
    return !!card && card.textContent.includes('Do you want to proceed?') && card.textContent.includes('npm run build') &&
      card.querySelectorAll('.agent-chat-approval-option').length === 3 && ${composer(0)}.readOnly && document.activeElement === ${composer(0)}
  })()`, 8000), await js(`${cover(0)}?.querySelector('.agent-chat-approval')?.textContent ?? 'no card'`))
  check('approval choices start disabled', await js(`${firstApprovalOption}?.disabled === true`))
  await until(`${firstApprovalOption}?.disabled === false`, 3000)
  await pressQuestionKey('1', 49, 'Digit1')
  await pressQuestionKey(' ', 32, 'Space')
  await driver.enter()
  check('typing in the blocked composer does not approve the command', !read('claude-1-approval-answer') && await js(`
    document.activeElement === ${composer(0)} && ${composer(0)}.value === '승인 전 초안' && ${cover(0)}.querySelector('.agent-chat-send').disabled
  `))
  check('the other pane\'s chat shows no prompt', await js(`!${cover(1)}.querySelector('.agent-chat-approval')`))
  await click(...await center(chatLog(0)), 'right')
  check('paste is disabled while the chat is waiting for an approval', await until(`
    [...document.querySelectorAll('.terminal-menu-item')].find(item => item.textContent.trim() === '붙여넣기')?.hasAttribute('data-disabled')
  `))
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(`!document.querySelector('.terminal-menu')`)
  await shot('local-agent-chat-approval')
  await js(`${approvalCard}.focus()`)
  await pressQuestionKey('2', 50, 'Digit2')
  check('choosing answers the prompt with that number', await waitFor(() => read('claude-1-approval-answer') === '2'), read('claude-1-approval-answer'))
  check('the saved draft becomes editable once the prompt is gone', await until(`
    !${approvalCard} && ${composer(0)}.readOnly === false && ${composer(0)}.value === '승인 전 초안'
  `, 8000))
  await setChatDraft('')

  const openChatMenu = async () => {
    const log = await center(chatLog(0))
    await click(log[0], log[1], 'right')
    return until(`[...document.querySelectorAll('.terminal-menu-item')].some(item => item.textContent === '채팅 전체 복사')`)
  }
  await js(`navigator.clipboard.writeText = async text => { window.copiedConversation = text }`)
  const titleButton = `${cover(0)}.querySelector('.agent-chat-title-copy')`
  const title = await js(`${titleButton}.textContent`)
  await click(...await center(titleButton))
  check('clicking the chat title copies the full title', Boolean(title) && await until(`window.copiedConversation === ${JSON.stringify(title)}`))
  await js('window.copiedConversation = null')
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
  await chooseChatAction(1, '채팅 닫고 터미널로 전환')
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

  // Sent while the agent works: the CLI holds it, so the bubble says it waits until Claude reads it
  // (2026-11-22 user request). Claude records the read as a queued_command attachment line.
  fs.writeFileSync(file('manual-claude-program-status'), 'state=working:app=claude')
  check('the second agent reports that it is working', await until(`${cover(1)}.querySelector('.agent-chat-status')?.dataset.status === 'working'`, 5000))
  await js(`${cover(1)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.insertText', { text: '작업 중에 보낸 질문' })
  await js(`${cover(1)}.querySelector('.agent-chat-send').click()`)
  check('a message sent while the agent works reaches it', await waitFor(() =>
    read('manual-claude-chat-sent') === '3' && read('manual-claude-chat-text') === '작업 중에 보낸 질문'))
  const waitingBubble = `[...${cover(1)}.querySelectorAll('.agent-chat-user')].find(row => row.textContent.includes('작업 중에 보낸 질문'))`
  check('that bubble says it waits, and the progress line is about the work before it', await until(`
    ${waitingBubble}?.querySelector('.agent-chat-waiting')?.textContent.includes('대기 중') &&
    ${cover(1)}.querySelector('.agent-chat-reply-progress')?.textContent === '앞 작업 진행 중…'
  `, 5000), await js(`${waitingBubble}?.outerHTML ?? 'no bubble'`))
  await shot('local-agent-chat-waiting')
  fs.appendFileSync(path.join(projects, `${SESSIONS[1]}.jsonl`), line({
    type: 'attachment', uuid: 'q-busy', timestamp: new Date().toISOString(),
    attachment: { type: 'queued_command', prompt: '작업 중에 보낸 질문', commandMode: 'prompt', origin: { kind: 'human' } }
  }))
  check('once Claude reads it mid-turn the wait mark goes and the bubble is not doubled', await until(`
    !${cover(1)}.querySelector('.agent-chat-waiting') &&
    [...${cover(1)}.querySelectorAll('.agent-chat-user')].filter(row => row.textContent.includes('작업 중에 보낸 질문')).length === 1 &&
    ${cover(1)}.querySelector('.agent-chat-reply-progress')?.textContent === '답변 생성 중…'
  `, 8000), await coverText(1))
  // Esc while it still waits: Claude puts the line back into its composer. The chat takes it back into its
  // own box (as the terminal shows it) so it can be sent again (2026-11-22 user report: the composer kept
  // it and the next send was refused because the composer was not empty)
  await js(`${cover(1)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.insertText', { text: '멈출 때 돌아올 질문' })
  await js(`${cover(1)}.querySelector('.agent-chat-send').click()`)
  check('a second line sent while working reaches the agent', await waitFor(() => read('manual-claude-chat-sent') === '4'))
  const returning = `[...${cover(1)}.querySelectorAll('.agent-chat-user')].filter(row => row.textContent.includes('멈출 때 돌아올 질문'))`
  await until(`${returning}.length === 1 && !!${returning}[0].querySelector('.agent-chat-waiting')`, 5000)
  fs.writeFileSync(file('manual-claude-restore-on-esc'), '멈출 때 돌아올 질문')
  await js(`${cover(1)}.querySelector('.agent-chat-input').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check('Esc stops the agent and the line comes back to the chat box, out of the conversation', await until(`
    ${cover(1)}.querySelector('.agent-chat-input').value === '멈출 때 돌아올 질문' && ${returning}.length === 0
  `, 8000) && read('manual-claude-taken-back') === 'x' && read('manual-claude-chat-interrupt').includes('esc'),
  JSON.stringify([await js(`${cover(1)}.querySelector('.agent-chat-input').value`), read('manual-claude-taken-back'), read('manual-claude-draft')]))
  fs.writeFileSync(file('manual-claude-program-status'), 'state=idle:app=claude')
  await until(`${cover(1)}.querySelector('.agent-chat-status')?.dataset.status !== 'working'`, 5000)
  await setChatDraft('취소한 질문 대신 보낼 새 질문', 1)
  await js(`${cover(1)}.querySelector('.agent-chat-send').click()`)
  check('editing the recovered draft submits only the replacement question', await waitFor(() =>
    read('manual-claude-chat-sent') === '5' && read('manual-claude-chat-text') === '취소한 질문 대신 보낼 새 질문'),
    JSON.stringify([read('manual-claude-chat-sent'), read('manual-claude-chat-text'), await js(`document.querySelector('.toast')?.textContent ?? ''`)]))

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
  await chooseChatTheme(0, '카톡 모드')
  check('the usage row joins the composer without a gap or divider in the chat theme', await js(`(() => {
    const composer = ${cover(0)}.querySelector('.agent-chat-composer')
    const usage = ${codexUsage}
    const usageStyle = getComputedStyle(usage)
    return Math.abs(composer.getBoundingClientRect().bottom - usage.getBoundingClientRect().top) < 0.5 &&
      usageStyle.borderTopWidth === '0px' && usageStyle.backgroundColor === getComputedStyle(composer).backgroundColor
  })()`))
  await shot('local-agent-chat-usage-footer')
  await chooseChatTheme(0, '앱 테마 따르기')
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
  check('one click turns Fast on as soon as the CLI footer changes', await until(`
    ${fastButton}?.getAttribute('aria-pressed') === 'true' && !${fastButton}.disabled
  `, 3000) && read(codexId + '-fast-toggles') === '1')
  await js(`${fastButton}.click()`)
  check('one click turns Fast off and keeps the draft', await until(`
    ${fastButton}?.getAttribute('aria-pressed') === 'false' && !${fastButton}.disabled && ${codexInput}.value === 'Codex 이미지 테스트'
  `, 3000) && read(codexId + '-fast-toggles') === '2' && !read(codexId + '-chat-sent'))
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
  for (let count = 1; count <= 3; count++) {
    await pasteIntoChat(0)
    await until(`${cover(0)}.querySelectorAll('.agent-chat-attachment img').length === ${count} && !${sendButton}.disabled`)
  }
  await js(`${sendButton}.click()`)
  check('Codex receives three native images and the entered text with its references', await waitFor(() => {
    if (read(codexId + '-chat-sent') !== '1') return false
    const images = JSON.parse(read(codexId + '-chat-images') || '[]')
    return new Set(images).size === 3 && images.every(isPng)
      && read(codexId + '-chat-text') === 'Codex 이미지 테스트 [첨부이미지 1] [첨부이미지 2] [첨부이미지 3]'
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

  // Sent while Codex works: Codex writes the message the moment it takes it (a command may still run),
  // so the bubble keeps waiting until the model makes something after it (2026-11-22)
  const codexItem = item => codexLine('event_msg', { type: 'item_completed', item })
  fs.writeFileSync(file(codexId + '-chat-target'), '')
  fs.writeFileSync(file(codexId + '-program-status'), 'state=working:app=codex')
  check('Codex reports that it is working', await until(`${cover(0)}.querySelector('.agent-chat-status')?.dataset.status === 'working'`, 5000))
  await js(`${codexInput}.focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.insertText', { text: '코덱스 작업 중 질문' })
  await js(`${sendButton}.click()`)
  check('a message sent while Codex works reaches it', await waitFor(() =>
    read(codexId + '-chat-sent') === '3' && read(codexId + '-chat-text') === '코덱스 작업 중 질문'),
    JSON.stringify([read(codexId + '-chat-sent'), read(codexId + '-chat-text'), await js(`[${codexInput}.value, ${sendButton}.disabled, document.querySelector('.toast')?.textContent ?? '']`)]))
  const codexBubbles = `[...${cover(0)}.querySelectorAll('.agent-chat-user')].filter(row => row.textContent.includes('코덱스 작업 중 질문'))`
  check('the Codex bubble says it waits', await until(`${codexBubbles}.length === 1 && !!${codexBubbles}[0].querySelector('.agent-chat-waiting')`, 5000))
  fs.appendFileSync(codexTranscript, codexItem({ id: 'busy-question', type: 'UserMessage', content: [{ type: 'text', text: '코덱스 작업 중 질문' }] }))
  check('recorded is not read: the bubble still waits, once', await until(`
    ${codexBubbles}.length === 1 && ${codexBubbles}[0].closest('[data-chat-row]')?.dataset.chatRow === 'item:UserMessage:busy-question'
  `, 8000) && await js(`!!${codexBubbles}[0].querySelector('.agent-chat-waiting') &&
    ${cover(0)}.querySelector('.agent-chat-reply-progress')?.textContent === '앞 작업 진행 중…'`), await js(`${codexBubbles}.map(row => row.outerHTML).join('|')`))
  fs.appendFileSync(codexTranscript, codexItem({ id: 'busy-answer', type: 'AgentMessage', content: [{ type: 'text', text: '작업 중 질문을 확인했습니다' }] }))
  check('once the model answers after it, the wait mark goes', await until(`
    ${cover(0)}.textContent.includes('작업 중 질문을 확인했습니다') && !${cover(0)}.querySelector('.agent-chat-waiting')
  `, 8000))
  fs.writeFileSync(file(codexId + '-program-status'), 'state=idle:app=codex')

  // Codex redraws older history before echoing /mcp. The chat card keeps just the result.
  await until(`window.electronAPI.agentMessagesSnapshot().then(state =>
    state.agents.some(agent => agent.id === ${JSON.stringify(codexId)} && agent.status === 'idle'))`)
  await js(`${codexInput}.focus()`)
  await send('Input.insertText', { text: '/mcp' })
  await js(`${sendButton}.click()`)
  const mcpCard = `${cover(0)}.querySelector('.agent-chat-mcp')`
  check('Codex /mcp displays server names, three states, and tool counts', await until(`(() => {
    const card = ${mcpCard}
    const rows = [...card?.querySelectorAll('.agent-chat-mcp-servers li') ?? []]
    return rows.length === 3 &&
      rows[0].textContent.includes('codex_apps') && rows[0].textContent.includes('도구 108개') &&
      rows[1].textContent.includes('ezshell-cli-mcp') && rows[1].textContent.includes('Codex를 다시 시작하면') &&
      rows[2].textContent.includes('msw-mcp') && rows[2].textContent.includes('도구 0개') &&
      rows.map(row => row.querySelector('[data-status]').dataset.status).join(',') === 'connected,failed,auth'
  })()`, 8000), await js(`${cover(0)}.querySelector('.agent-chat-output')?.textContent`))
  check('MCP starts with the raw output folded', await js(`${mcpCard}?.querySelector('details').open === false`))
  await js(`${mcpCard}?.querySelector('summary').click()`)
  check('the raw MCP output preserves diagnostics and starts after the command echo', await until(`(() => {
    const details = ${mcpCard}?.querySelector('details')
    const raw = details?.querySelector('pre').textContent
    return details?.open && raw.startsWith('🔌  MCP Tools') && raw.includes('Unknown MCP diagnostic.') &&
      !/local bridge|Context compacted|Worked for/.test(raw)
  })()`, 3000))
  await js(`${mcpCard}?.querySelector('summary').click()`)
  await shot('local-agent-chat-mcp')

  await js(`${codexInput}.focus()`)
  await send('Input.insertText', { text: '작성하던 메시지' })
  const loginButton = `${mcpCard}?.querySelector('button[aria-label="msw-mcp 로그인"]')`
  const detailsButton = `${mcpCard}?.querySelector('.agent-chat-mcp-actions button')`
  await until(`${loginButton}?.disabled === false`)
  await js(`${loginButton}?.click()`)
  check('MCP login sends the selected server command and keeps the draft', await waitFor(() =>
    read(codexId + '-chat-sent') === '5' && read(codexId + '-chat-text') === '/mcp login msw-mcp') &&
    await until(`${codexInput}.value === '작성하던 메시지' && ${detailsButton}?.disabled === false`))
  await js(`${detailsButton}?.click()`)
  check('MCP details sends /mcp verbose and displays plain verbose output', await waitFor(() =>
    read(codexId + '-chat-sent') === '6' && read(codexId + '-chat-text') === '/mcp verbose') &&
    await until(`[...${cover(0)}.querySelectorAll('.agent-chat-incoming > .agent-chat-output')].some(pre => pre.textContent.includes('test_tool'))`, 8000))
  await js(`${codexInput}.focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  fs.writeFileSync(file(codexId + '-mcp-without-echo'), '')
  await send('Input.insertText', { text: '/mcp' })
  await js(`${sendButton}.click()`)
  check('MCP keeps an echo-less result visible and disables actions on the previous card', await until(`(() => {
    const cards = [...${cover(0)}.querySelectorAll('.agent-chat-mcp')]
    const latest = cards.at(-1)
    return cards.length === 2 &&
      [...cards[0].querySelectorAll('button')].every(button => button.disabled) &&
      latest.querySelector('button[aria-label="msw-mcp 로그인"]')?.disabled &&
      latest.textContent.includes('터미널에서 확인해 주세요.') &&
      latest.querySelector('.agent-chat-mcp-actions button')?.disabled === false
  })()`, 8000))
  fs.writeFileSync(file(codexId + '-command-history'), '')

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
    ${questionPanel(0)}?.textContent.includes('로그 기록을 검토해 줘') &&
    !${longLog}.querySelector('[data-chat-row="item:UserMessage:scroll-question"]')
  `))
  await pickQuestion(0, '로그 기록을 검토해 줘')
  check('choosing a loaded question scrolls the virtual list to the question row', await until(`
    ${longLog}.querySelector('[data-question-target]')?.textContent.includes('로그 기록을 검토해 줘') &&
    ${longLog}.textContent.includes('긴 대화 0번') && !${longLog}.textContent.includes('긴 대화 219번')
  `))
  await js(`${cover(0)}.querySelector('.agent-chat-question-location button').click()`)
  check('latest conversation scrolls back to the live end', await until(`${atEnd} && ${longLog}.textContent.includes('긴 대화 219번')`))
  const jumpQuestion = `${cover(0)}.querySelector('.agent-chat-jump-question')`
  const jumpBottom = `${cover(0)}.querySelector('.agent-chat-jump-bottom')`
  check('at the end, the top bar offers the question the replies belong to and no way down', await until(`
    ${jumpQuestion}?.textContent.includes('로그 기록을 검토해 줘') && !${jumpBottom}
  `), await js(`${jumpQuestion}?.textContent ?? 'no bar'`))
  await js(`${jumpQuestion}.click()`)
  check('the top bar goes to that question, which shows below the bar', await until(`(() => {
    const row = [...${longLog}.querySelectorAll('.agent-chat-row')].find(row => row.textContent.includes('로그 기록을 검토해 줘'))
    const bar = ${jumpQuestion}
    return !!row && (!bar || (row.getBoundingClientRect().top >= bar.getBoundingClientRect().bottom - 1 && !bar.textContent.includes('로그 기록을 검토해 줘')))
  })()`), await js(`${jumpQuestion}?.textContent ?? 'no bar'`))
  check('away from the end, the way down shows', await until(`!!${jumpBottom} && !${jumpBottom}.dataset.fresh`))
  await shot('local-agent-chat-jump-controls')
  await scrollLongLog(false)
  check('scrolling back mounts older messages', await until(`
    !!${longLog}.querySelector('[data-chat-row="item:AgentMessage:busy-answer"]') &&
    !${longLog}.textContent.includes('긴 대화 219번')
  `))
  fs.writeFileSync(file(codexId + '-program-status'), 'state=working:app=codex')
  check('working stays visible above the composer while reading earlier messages', await until(`
    ${composerProgress}?.textContent.trim() === '작업 중…' &&
    ${longLog}.scrollTop < 80 && !${longLog}.textContent.includes('긴 대화 219번')
  `, 5000))
  fs.writeFileSync(file(codexId + '-program-status'), 'state=idle:app=codex')
  await until(`!${composerProgress}`, 5000)
  await js(`${longLog}.querySelector('.agent-chat-tool summary').click()`)
  await until(`${longLog}.querySelector('.agent-chat-tool')?.open`)
  const readingPosition = () => js(`(() => {
    const log = ${longLog}
    const viewport = log.getBoundingClientRect()
    for (const row of log.querySelectorAll('[data-chat-row^="item:"]')) {
      const bounds = row.getBoundingClientRect()
      if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
        return { id: row.dataset.chatRow, offset: bounds.top - viewport.top }
      }
    }
    return null
  })()`)
  const beforeAppend = await readingPosition()
  fs.appendFileSync(codexTranscript, longAnswer('scroll-update', '읽는 동안 도착한 답변'))
  const newOutput = await until(`${jumpBottom}?.dataset.fresh === 'true'`)
  const afterAppend = await readingPosition()
  check('a reader stays at the old position when new output arrives', newOutput && Boolean(
    beforeAppend && afterAppend && beforeAppend.id === afterAppend.id && Math.abs(beforeAppend.offset - afterAppend.offset) <= 1
  ), JSON.stringify({ beforeAppend, afterAppend }))
  check('new output while reading marks the way down', newOutput)
  await js(`${jumpBottom}.click()`)
  check('the latest reply appears after going to the bottom', await until(`${atEnd} && !${jumpBottom}`) && await until(`${longLog}.textContent.includes('읽는 동안 도착한 답변') && !${longLog}.querySelector('.agent-chat-tool')`))
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

  const quoteSource = ['인용할 답변의 첫째 문장입니다.', '두 번째 문단', '세 번째 문단', '네 번째 문단'].join('\n\n')
  const quoteSelection = '답변의 첫째'
  const quoteAnswer = `${longLog}.querySelector('[data-chat-row="item:AgentMessage:quote-source"] .agent-chat-assistant')`
  const quotePopup = `${cover(0)}.querySelector('.agent-chat-quote-selection')`
  const quoteCards = `${cover(0)}.querySelectorAll('.agent-chat-quote-card')`
  const quoteSend = `${cover(0)}.querySelector('.agent-chat-send')`
  await js(`${cover(0)}.querySelector('.agent-chat-question-location button')?.click()`)
  fs.appendFileSync(codexTranscript, longAnswer('quote-source', quoteSource))
  if (!await until(`!!${quoteAnswer}`)) await scrollLongLog(true)
  if (!await until(`!!${quoteAnswer}`)) throw new Error('the answer for quoting did not appear')
  await js(`(() => {
    const paragraph = ${quoteAnswer}.querySelector('p')
    const node = paragraph.firstChild
    const selected = ${JSON.stringify(quoteSelection)}
    const start = node.textContent.indexOf(selected)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + selected.length)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  })()`)
  if (!await until(`!!${quotePopup}`)) throw new Error('the selection quote button did not appear')
  await click(...await center(quotePopup))
  check('quoting selected answer text adds a card and focuses the composer', await until(`
    ${quoteCards}.length === 1 && ${quoteCards}[0].querySelector('.agent-chat-quote-preview').textContent === ${JSON.stringify(quoteSelection)} &&
    document.activeElement === ${composer(0)} && ${quoteSend}.disabled
  `))
  await js(`${quoteAnswer}.querySelector('.agent-chat-quote-reply').click()`)
  check('replying to the whole answer adds an expandable second card', await until(`
    ${quoteCards}.length === 2 && !!${quoteCards}[1].querySelector('.agent-chat-quote-toggle')
  `))
  await js(`${quoteCards}[1].querySelector('.agent-chat-quote-toggle').click()`)
  check('a long quote can be expanded', await until(`${quoteCards}[1].querySelector('.agent-chat-quote-preview').dataset.expanded === 'true'`))
  await js(`${quoteCards}[1].querySelector('.agent-chat-quote-toggle').click()`)
  const quoteAttachments = `${cover(0)}.querySelectorAll('.agent-chat-attachment')`
  await js(`${cover(0)}.querySelector('.agent-chat-add-image').click()`)
  check('quotes with only attached images ask for a reply body', await until(`
    ${quoteAttachments}.length === 2 && ${quoteSend}.disabled &&
    ${cover(0)}.querySelector('.agent-chat-quote-notice')?.textContent === '인용과 함께 보낼 내용을 입력해 주세요.'
  `))
  await js(`[...${quoteAttachments}].forEach(attachment => attachment.querySelector('button').click())`)
  await until(`${quoteAttachments}.length === 0`)
  await setChatDraft('/model')
  check('quotes block a slash command with an explanation', await until(`
    ${quoteSend}.disabled && ${cover(0)}.querySelector('.agent-chat-quote-notice')?.textContent.includes('슬래시 명령')
  `))
  const quoteBody = '인용한 부분을 더 설명해 줘.'
  const quotedMessage = `> ${quoteSelection}\n\n\n${quoteSource.split('\n').map(row => '> ' + row).join('\n')}\n\n${quoteBody}`
  await setChatDraft(quoteBody)
  await shot('local-agent-chat-quote-draft')
  await js(`${quoteSend}.click()`)
  check('the agent receives both Markdown quotes before the reply', await waitFor(() => read(codexId + '-chat-text') === quotedMessage))
  fs.appendFileSync(codexTranscript, completed({ id: 'quoted-message', type: 'UserMessage', content: [{ type: 'text', text: quotedMessage }] }))
  check('the recorded sent bubble renders two visibly separate quote blocks', await until(`(() => {
    const quotes = ${longLog}.querySelector('[data-chat-row="item:UserMessage:quoted-message"] .agent-chat-bubble')?.querySelectorAll('.agent-chat-sent-quote')
    return ${quoteCards}.length === 0 && quotes?.length === 2 &&
      [...quotes].every(quote => !!quote.querySelector('blockquote')) &&
      quotes[1].getBoundingClientRect().top - quotes[0].getBoundingClientRect().bottom >= 8
  })()`))
  await shot('local-agent-chat-quoted-reply')

  // `인계`: the answer and a comment go to another agent's inbox as a message from the user
  // (at the end: the receiving fake agent may be woken by it)
  const handoffCard = `${cover(0)}.querySelector('.agent-chat-handoff')`
  const handoffAgents = `${handoffCard}?.querySelectorAll('.agent-chat-handoff-agent input')`
  const handoffProjects = `${handoffCard}?.querySelectorAll('.agent-chat-handoff-project')`
  const openHandoff = () => js(`${quoteAnswer}.querySelector('.agent-chat-handoff-button').click()`)
  const handoffKey = async (key, windowsVirtualKeyCode, modifiers = 0) => {
    const down = key === 'Enter' && !modifiers ? { type: 'keyDown', text: '\r' } : { type: 'rawKeyDown' }
    await send('Input.dispatchKeyEvent', { ...down, key, code: key, windowsVirtualKeyCode, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode, modifiers })
  }
  await openHandoff()
  check('a single-project hand-off immediately lists eligible agents and excludes the sender', await until(`
    ${handoffProjects}.length === 0 && ${handoffAgents}.length > 0 &&
    ![...${handoffAgents}].some(input => input.value === ${JSON.stringify(codexId)})
  `))
  await handoffKey('Escape', 27)
  check('Esc closes only the hand-off card', await until(`!${handoffCard} && !!${cover(0)}`))

  const reviewFolder = path.join(profile, 'Atlas')
  fs.mkdirSync(reviewFolder)
  await js(`
    localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([profile, reviewFolder]))});
    window.dispatchEvent(new Event('ezshell:local-projects-changed'))
  `)
  const targetAgent = `window.electronAPI.agentMessagesSnapshot().then(state => state.agents.find(agent =>
    agent.active && agent.mcpConnected && agent.cwd === ${JSON.stringify(reviewFolder)})?.id)`
  await openLocalAgent(driver, 'claude', reviewFolder)
  check('the alternate project has a connected hand-off recipient', await until(targetAgent, 12000))
  const handoffTarget = await js(targetAgent)
  await js(`window.electronAPI.agentMessageSetRole(${JSON.stringify(handoffTarget)}, '리뷰어')`)
  await pickTabGroup(driver, path.basename(profile))
  if (!await until(`!!${quoteAnswer}`, 2000)) await scrollLongLog(true)
  if (!await until(`!!${quoteAnswer}`)) throw new Error('the hand-off answer did not return after switching work')
  await chooseChatTheme(0, '종이 노트')
  await openHandoff()
  check('projects show eligible and working counts with the sender project first', await until(`
    ${handoffProjects}.length === 2 &&
    ${handoffProjects}[0].querySelector('.agent-chat-handoff-name').textContent === ${JSON.stringify(path.basename(profile))} &&
    ${handoffProjects}[1].textContent.includes('Atlas') &&
    ${handoffProjects}[1].textContent.includes('에이전트 1명 · 작업 중 0명') &&
    ${handoffCard}.querySelector('.agent-chat-handoff-send').disabled
  `))
  await shot('local-agent-chat-handoff-projects-light')
  await handoffKey('ArrowDown', 40)
  check('Down focuses the next project', await until(`document.activeElement === ${handoffProjects}[1]`))
  await handoffKey('ArrowUp', 38)
  check('Up returns to the preceding project', await until(`document.activeElement === ${handoffProjects}[0]`))
  await handoffKey('ArrowDown', 40)
  await handoffKey('Enter', 13)
  check('Enter opens only the selected project with the role and provider logo', await until(`
    ${handoffAgents}.length === 1 && ${handoffAgents}[0].value === ${JSON.stringify(handoffTarget)} &&
    ${handoffCard}.querySelector('.agent-chat-handoff-back')?.textContent === 'Atlas' &&
    ${handoffCard}.querySelector('.agent-chat-handoff-agent svg') &&
    ${handoffCard}.querySelector('.agent-chat-handoff-agent .agent-chat-handoff-name').textContent.startsWith('리뷰어 · Claude Code')
  `))
  await shot('local-agent-chat-handoff-agent-light')
  await handoffKey('Backspace', 8)
  check('Backspace returns to the focused project', await until(`document.activeElement === ${handoffProjects}[1]`))
  await handoffKey('Enter', 13)
  await until(`${handoffAgents}.length === 1`)
  await handoffKey('ArrowLeft', 37)
  check('Left returns to the project list', await until(`${handoffProjects}.length === 2`))
  await handoffKey('Escape', 27)
  await chooseChatTheme(0, '미드나잇')
  await openHandoff()
  await until(`${handoffProjects}.length === 2`)
  await shot('local-agent-chat-handoff-projects-dark')
  await js(`${handoffProjects}[1].click()`)
  await until(`document.activeElement === ${handoffAgents}[0]`)
  await handoffKey('Enter', 13)
  check('Enter selects the recipient and moves to the comment', await until(`document.activeElement === ${handoffCard}.querySelector('textarea')`))
  await send('Input.insertText', { text: '이 답변을 검토해 주세요.' })
  await handoffKey('ArrowLeft', 37)
  check('Left in the comment keeps editing the comment', await until(`
    document.activeElement === ${handoffCard}.querySelector('textarea') && ${handoffAgents}.length === 1
  `))
  await js(`${handoffCard}.querySelector('.agent-chat-handoff-preview summary').click()`)
  await shot('local-agent-chat-handoff-agent-dark')
  check('the hand-off buttons have one size', await js(`(() => {
    const [cancel, sendButton] = ['.agent-chat-handoff-cancel', '.agent-chat-handoff-send'].map(selector => ${handoffCard}.querySelector(selector).getBoundingClientRect())
    return cancel.height === sendButton.height && cancel.top === sendButton.top
  })()`))
  await handoffKey('Enter', 13, 2)
  check('the chosen agent gets the answer and the comment from the user', await until(`window.electronAPI.agentMessagesSnapshot().then(state =>
    state.messages.some(message => message.from === 'user' && message.to === ${JSON.stringify(handoffTarget)} &&
      message.text.startsWith('[인계] ') && message.text.includes('이 답변을 검토해 주세요.') && message.text.includes('인용할 답변의 첫째 문장입니다.')))
  `) && await until(`!${handoffCard}`), String(handoffTarget))
  await chooseChatTheme(0, '앱 테마 따르기')

  // Codex's numbered model picker belongs in the terminal, including when older MCP output is still visible.
  await setChatDraft('/model')
  await js(`${sendButton}.click()`)
  check('Codex /model opens in the terminal with the chat return bar', await until(`
    !${cover(0)} && !!${pane(0)}?.querySelector('.agent-screen-return') &&
    ${pane(0)}?.querySelector('.xterm-rows')?.textContent.includes('Select Model and Effort')
  `, 8000))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check('Esc closes Codex /model and restores the chat composer', await waitFor(() => read(codexId + '-screen-closed') === 'x') &&
    await until(`!!${composer(0)} && document.activeElement === ${composer(0)} && !document.querySelector('.agent-screen-return')`, 8000))

  await js("window.dispatchEvent(new CustomEvent('ezshell:open-settings', { detail: { tab: 'claude-accounts' } }))")
  const profileInput = "document.getElementById('claude-profile-name')"
  if (!await until(`!!${profileInput}`, 5000)) throw new Error('Claude account settings did not open')
  for (const name of ['업무 테스트', '개인 테스트']) {
    await click(...await center(profileInput))
    await send('Input.insertText', { text: name })
    await js(`${profileInput}.form.requestSubmit()`)
    if (!await until(`!!document.querySelector(${JSON.stringify(`[aria-label="${name} 열기"]`)})`, 5000)) {
      throw new Error(`Claude account was not created: ${name}`)
    }
  }
  const profiles = await js('window.electronAPI.claudeProfilesList().then(result => result.profiles)')
  const workProfile = profiles.find(item => item.name === '업무 테스트')
  const personalProfile = profiles.find(item => item.name === '개인 테스트')
  const agentForProfile = item => js(`window.electronAPI.agentMessagesSnapshot().then(state =>
    state.agents.find(agent => agent.active && agent.claudeProfileId === ${JSON.stringify(item.id)}))`)
  const showProfileChat = async (agent) => {
    const element = `document.querySelector('[data-local-shell-id="${agent.shellId}"]')`
    if (!await until(`${element}?.querySelector('.xterm-helper-textarea')`, 5000)) throw new Error('Claude terminal did not open')
    await js(`${element}.querySelector('.xterm-helper-textarea').focus()`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 })
    if (!await until(`!!${element}?.querySelector('.agent-chat-profile')`, 5000)) throw new Error('Claude profile chat did not open')
    return `${element}.querySelector('.agent-chat-profile')`
  }
  const pickProfile = async (trigger, name, action = 'new') => {
    await click(...await center(trigger))
    const option = `[...document.querySelectorAll('.new-tab-menu [role="menuitem"][data-profile-action=${JSON.stringify(action)}]')]
      .find(item => item.dataset.profileName === ${JSON.stringify(name)})`
    if (!await until(`!!${option}`, 5000)) throw new Error(`Claude account menu option missing: ${name} (${action})`)
    await click(...await center(option))
  }
  await click(...await center('document.querySelector(\'[aria-label="업무 테스트 열기"]\')'))
  const workAgent = await waitFor(() => agentForProfile(workProfile))
  if (!workAgent) throw new Error('Work Claude profile failed to start')
  const workButton = await showProfileChat(workAgent)
  check('a chat shows the Claude account it started with', (await js(`${workButton}.textContent`)).includes(workProfile.name))
  await pickProfile(workButton, personalProfile.name)
  const personalAgent = await waitFor(() => agentForProfile(personalProfile))
  if (!personalAgent) throw new Error('Personal Claude profile failed to start')
  const privateButton = await showProfileChat(personalAgent)
  for (const [account, agent] of [[workProfile, workAgent], [personalProfile, personalAgent]]) {
    const root = path.join(profile, 'claude-profiles', account.id)
    const actual = await inAgent(agent.id, 'echo %CLAUDE_CONFIG_DIR%')
    check(`Claude launches with the selected config directory (${account.name})`, actual.stdout.trim() === root)
    const transcripts = path.join(root, 'projects', 'test')
    fs.mkdirSync(transcripts, { recursive: true })
    fs.writeFileSync(path.join(transcripts, `${SESSIONS[0]}.jsonl`), line({
      type: 'user', cwd: agent.cwd, message: { content: account.name + ' 대화' }
    }))
  }
  await pickProfile(privateButton, workProfile.name)
  check('switching back focuses the existing Claude chat', await until(`
    !!${workButton} && ${workButton}.closest('.local-terminal-tab') &&
    getComputedStyle(${workButton}.closest('.local-terminal-tab')).visibility !== 'hidden'
  `, 5000) && (await agentForProfile(workProfile)).shellId === workAgent.shellId)
  const resumeKey = `claude:${workProfile.id}:${SESSIONS[0]}`
  const history = await js(`window.electronAPI.agentHistoryList(${JSON.stringify(workAgent.shellId)})`)
  check('the history distinguishes both conversations with the same session UUID', history.sessions?.filter(session =>
    session.id === SESSIONS[0] && [workProfile.id, personalProfile.id].includes(session.claudeProfileId)).length === 2)
  const resumed = await js(`window.electronAPI.localShellOpen({
    cols: 80, rows: 24, resume: ${JSON.stringify(resumeKey)}, claudeProfileId: ${JSON.stringify(personalProfile.id)}
  })`)
  const resumedAgent = resumed.success && await waitFor(() => js(`window.electronAPI.agentMessagesSnapshot().then(state =>
    state.agents.find(agent => agent.active && agent.shellId === ${JSON.stringify(resumed.id)}))`))
  check('resume uses the transcript owner and passes the session ID to Claude', resumedAgent?.claudeProfileId === workProfile.id &&
    await waitFor(() => read(resumedAgent.id + '-argv').includes(SESSIONS[0])))
  if (resumed.success) await js(`window.electronAPI.localShellClose(${JSON.stringify(resumed.id)})`)

  // "이 대화를 이어서": the personal account's conversation goes on under the work account in the same pane
  const workRoot = path.join(profile, 'claude-profiles', workProfile.id)
  const personalRoot = path.join(profile, 'claude-profiles', personalProfile.id)
  fs.writeFileSync(path.join(profile, personalAgent.id + '-hook-session'), SESSIONS[0])
  fs.writeFileSync(path.join(profile, personalAgent.id + '-hooks'), JSON.stringify([{ event: 'SessionStart' }]))
  check('the personal Claude reports its session through the hooks', !!await waitFor(() => js(`window.electronAPI.agentMessagesSnapshot().then(state =>
    state.agents.find(agent => agent.id === ${JSON.stringify(personalAgent.id)} && agent.statusSource === 'hook'))`)))
  const tabsBefore = await js(`document.querySelectorAll('.terminal-tab').length`)
  await js(`window.__oldProfileTab = document.querySelector('[data-local-shell-id="${personalAgent.shellId}"]').closest('.local-terminal-tab')`)
  const personalTab = await js(`document.querySelector('[data-local-shell-id="${personalAgent.shellId}"]').dataset.localTabId`)
  await click(...await center(`document.querySelector(${JSON.stringify(`.terminal-tab[data-tab-id=${JSON.stringify(personalTab)}]`)})`))
  if (!await until(`getComputedStyle(window.__oldProfileTab).visibility !== 'hidden' && !!${privateButton}`, 5000)) {
    throw new Error('the personal Claude tab did not come to the front')
  }
  await pickProfile(privateButton, workProfile.name, 'continue')
  const continued = await waitFor(() => js(`window.electronAPI.agentMessagesSnapshot().then(state => state.agents.find(agent =>
    agent.active && agent.claudeProfileId === ${JSON.stringify(workProfile.id)} && agent.shellId !== ${JSON.stringify(workAgent.shellId)}))`))
  check('continuing under another account starts Claude with that account and the same session', !!continued &&
    await waitFor(() => read(continued.id + '-argv').includes(SESSIONS[0])) &&
    (await inAgent(continued.id, 'echo %CLAUDE_CONFIG_DIR%')).stdout.trim() === workRoot)
  check('the conversation is copied to the other account, keeping what was there', continued &&
    fs.readFileSync(path.join(workRoot, 'projects', 'test', `${SESSIONS[0]}.jsonl`), 'utf8').includes('개인 테스트 대화') &&
    fs.readdirSync(path.join(workRoot, 'projects', 'test')).some(name => name.startsWith(`${SESSIONS[0]}.jsonl.before-`)) &&
    fs.readFileSync(path.join(personalRoot, 'projects', 'test', `${SESSIONS[0]}.jsonl`), 'utf8').includes('개인 테스트 대화'))
  check('the new Claude takes the pane of the old one, which closes', continued && await until(`
    document.querySelector('[data-local-shell-id="${continued.shellId}"]')?.dataset.localTabId === ${JSON.stringify(personalTab)} &&
    !document.querySelector('[data-local-shell-id="${personalAgent.shellId}"]') &&
    document.querySelectorAll('.terminal-tab').length === ${tabsBefore}
  `, 8000) && !(await js(`window.electronAPI.agentMessagesSnapshot().then(state =>
    state.agents.some(agent => agent.active && agent.id === ${JSON.stringify(personalAgent.id)}))`)))
  check('the pane stays a chat, now on the work account', continued && await until(`
    (document.querySelector('[data-local-shell-id="${continued.shellId}"]')?.querySelector('.agent-chat-profile')?.textContent ?? '')
      .includes(${JSON.stringify(workProfile.name)})
  `, 10000))

  // Locking drops every conversation
  await js(`document.activeElement?.blur(); document.body.focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, modifiers: 2 })
  check('locking the app removes the chats', await until(`document.querySelectorAll('input[type=password]').length > 0 && !document.querySelector('.agent-chat-cover')`, 8000))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
