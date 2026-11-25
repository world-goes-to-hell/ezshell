const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, openLocalAgent, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE
const pane = "document.querySelector('.local-terminal-pane[data-pane=main]')"
const cover = `${pane}?.querySelector('.agent-chat-cover')`
const rowOf = id => `${cover}?.querySelector('[data-chat-row="item:${id}"]')`
const timeOf = row => `${row}?.querySelector('.agent-chat-timestamp')`
const visible = row => `(${timeOf(row)} && getComputedStyle(${timeOf(row)}).visibility === 'visible')`
const shortAnswer = rowOf('time-short-answer:0')
const codeRow = rowOf('time-code:0')

function reportConversation() {
  const session = 'a0931449-779a-4ffc-9798-74ccf6be0760'
  const transcript = path.join(profile, 'claude-home', 'projects', 'test', `${session}.jsonl`)
  const timestamp = '2026-11-23T14:50:27Z'
  const prompt = (uuid, text) => ({ type: 'user', uuid, timestamp, message: { role: 'user', content: text } })
  const answer = (uuid, text) => ({ type: 'assistant', uuid, timestamp,
    message: { id: uuid, role: 'assistant', content: [{ type: 'text', text }] } })
  const entries = [
    prompt('time-short', '확인해 줘.'),
    answer('time-short-answer', '확인했습니다.'),
    prompt('time-long', '배포 전 점검과 검토가 필요한 항목을 순서대로 설명해 주세요. '.repeat(5).trim()),
    prompt('time-multiline', '첫째 줄은 변경 사항입니다.\n둘째 줄은 확인 순서입니다.\n셋째 줄은 결과입니다.'),
    answer('time-code', '확인 절차입니다.\n\n[배포 문서](https://example.com/notes "배포 문서")\n\n```js\nconst state = "ready"\nconsole.log(state)\n```'),
    answer('time-narrow', '마쳤습니다.')
  ]
  fs.writeFileSync(transcript, entries.map(entry => JSON.stringify(entry) + '\n').join(''))
  const input = path.join(profile, 'claude-time-status.json')
  fs.writeFileSync(input, JSON.stringify({ session_id: session }))
  fs.writeFileSync(path.join(profile, 'claude-1-command'), `"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_AGENT_USAGE_SCRIPT%" < "${input}"`)
}

async function run() {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  const { js, until, send, click, center, move, shot } = driver
  async function chooseTheme(label, id) {
    await click(...await center(`${cover}?.querySelector('.agent-chat-theme-trigger')`))
    const option = `[...document.querySelectorAll('.select-menu-content [role=menuitemradio]')].find(item =>
      item.textContent.trim() === ${JSON.stringify(label)})`
    if (!await until(`!!${option}`)) throw new Error(`Missing theme: ${label}`)
    await js(`${option}.click()`)
    if (!await until(`${cover}?.dataset.chatTheme === ${JSON.stringify(id)}`)) throw new Error(`Theme did not apply: ${label}`)
  }
  async function hoverTime(name, row, outgoing, target) {
    const bubble = `${row}?.querySelector('${outgoing ? '.agent-chat-bubble' : '.agent-chat-assistant > .agent-chat-md'}')`
    if (!await until(`!!${bubble}`)) throw new Error(`Missing bubble: ${name}`)
    await js(`${bubble}.scrollIntoView({ block: 'nearest' })`)
    await move(...await center(target ?? bubble))
    check(`${name} shows its timestamp at the bubble edge`, await until(`(() => {
      const bubble = ${bubble}
      const time = ${timeOf(row)}
      if (!bubble || !time || !${row}.matches(':hover') || !${visible(row)}) return false
      const rect = bubble.getBoundingClientRect()
      const label = time.getBoundingClientRect()
      const atEdge = ${outgoing}
        ? Math.abs(rect.left - label.right - 6) <= 1 && Math.abs(rect.bottom - label.bottom - 2) <= 1
        : Math.abs(rect.left - label.left) <= 1 && Math.abs(label.top - rect.bottom - 3) <= 1
      return atEdge &&
        !${row}.querySelector('.agent-chat-user[title], .agent-chat-assistant[title]') &&
        time.dateTime === '2026-11-23T14:50:27.000Z' && /년.*:\\d{2}:27/.test(time.title || time.dataset.heldTitle || '')
    })()`, 3000))
    if (!outgoing) {
      // Above the bubble, not beside it: a column beside every answer kept ~200px empty (2026-11-25)
      check(`${name} floats both answer buttons above the bubble`, await until(`(() => {
        const rect = ${bubble}.getBoundingClientRect()
        const buttons = [...${row}.querySelectorAll('.agent-chat-answer-actions button')]
        return buttons.length >= 2 && buttons.every(button => {
          const bounds = button.getBoundingClientRect()
          return getComputedStyle(button).opacity === '1' && bounds.bottom <= rect.top - 3
        })
      })()`, 3000))
    }
    await shot('local-agent-chat-time-' + name)
  }
  try {
    await unlock(driver)
    await send('Page.bringToFront')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([profile]))})`)
    await openLocalAgent(driver, 'claude', profile)
    if (!await until(`!!${pane}`, 3000) && await js(`window.electronAPI.agentMessagesSnapshot().then(state =>
      !state.agents.some(agent => agent.kind === 'claude' && agent.active))`)) {
      await openLocalAgent(driver, 'claude', profile)
    }
    if (!await until(`document.body.textContent.includes('fixture ready: claude-1') && !!${pane}?.dataset.agentWork`, 30000)) {
      const output = await js(`[...document.querySelectorAll('.xterm-rows, .local-project-error, .toast')].map(el => el.textContent).join('\\n')`)
      throw new Error(`The fake Claude did not open: ${output}`)
    }
    await js(`${pane}.querySelector('.xterm-helper-textarea').focus()`)
    const toggle = { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...toggle })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...toggle })
    if (!await until(`!!${cover}`)) throw new Error('The chat view did not open')
    reportConversation()
    if (!await until(`!!${codeRow}`)) throw new Error('The fixture conversation did not load')

    const header = `${cover}?.querySelector('.agent-chat-head')`
    const shortOutgoing = rowOf('user:time-short')
    const longOutgoing = rowOf('user:time-long')
    const multilineOutgoing = rowOf('user:time-multiline')
    await move(...await center(header))
    check('the default theme hides the time away from the row', await until(`!!${timeOf(shortOutgoing)} && !${visible(shortOutgoing)}`))
    await hoverTime('short-outgoing', shortOutgoing, true)

    await chooseTheme('카톡 모드', 'chat-kakao')
    check('Kakao keeps the time visible on the last outgoing message in a same-minute run', await until(`
      ${visible(multilineOutgoing)} && !${visible(longOutgoing)}
    `))
    await hoverTime('kakao-short-answer', shortAnswer, false)
    let showedExactDate = false
    for (let attempt = 0; attempt < 2 && !showedExactDate; attempt++) {
      await move(...await center(`${shortAnswer}?.querySelector('.agent-chat-md')`))
      await move(...await center(timeOf(shortAnswer)))
      showedExactDate = await until(`
        ${timeOf(shortAnswer)}?.matches(':hover') &&
        /년.*:\\d{2}:27/.test(document.querySelector('.app-tooltip.is-visible')?.textContent ?? '')
      `, 2200)
    }
    check('only the label opens the exact date and seconds', showedExactDate)
    await move(...await center(header))
    check('the answer time hides when the pointer leaves', await until(`!${visible(shortAnswer)}`))
    // A mouse click leaves the focus on the button: the time must still go when the pointer leaves
    await move(...await center(`${shortAnswer}?.querySelector('.agent-chat-md')`))
    // 띄워 두기 keeps the focus on itself (the pinned window opens beside, the page keeps emulated focus)
    await click(...await center(`${shortAnswer}?.querySelector('.agent-chat-pin')`))
    await move(...await center(header))
    check('a clicked answer button does not keep the time on screen', await until(`
      ${shortAnswer}?.contains(document.activeElement) && !${shortAnswer}?.matches(':hover') && !${visible(shortAnswer)}
    `), await js(`(document.activeElement?.className || '') + ' / focus in row: ' + !!${shortAnswer}?.contains(document.activeElement) + ' / hover: ' + !!${shortAnswer}?.matches(':hover')`))
    // Keyboard: a key press first so Chromium treats the next focus as keyboard focus
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 })
    await js(`${shortAnswer}.querySelector('.agent-chat-pin').focus()`)
    check('keyboard focus on an answer action reveals the time', await until(visible(shortAnswer)))
    await js(`${cover}.querySelector('.agent-chat-input').focus()`)

    await chooseTheme('미드나잇', 'chat-midnight')
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await hoverTime('midnight-long-outgoing', longOutgoing, true)
    await hoverTime('midnight-multiline-outgoing', multilineOutgoing, true)
    await hoverTime('midnight-code-answer', codeRow, false, `${codeRow}?.querySelector('.agent-chat-md pre')`)
    const link = `${codeRow}?.querySelector('.agent-chat-md a')`
    await move(...await center(link))
    check('a titled link keeps the timestamp visible with reduced motion', await until(`
      ${link}.matches(':hover') && !!(${link}.title || ${link}.dataset.heldTitle) &&
      ${visible(codeRow)} && matchMedia('(prefers-reduced-motion: reduce)').matches &&
      parseFloat(getComputedStyle(${timeOf(codeRow)}).transitionDuration) < 0.001
    `))

    await chooseTheme('카톡 모드', 'chat-kakao')
    await js(`${cover}?.style.setProperty('inline-size', '244px')`)
    const narrowAnswer = rowOf('time-narrow:0')
    const narrowActions = `${narrowAnswer}?.querySelector('.agent-chat-answer-actions')`
    if (!await until(`${narrowActions} && getComputedStyle(${narrowActions}).position === 'absolute'`)) {
      throw new Error('The narrow answer did not render its floating buttons')
    }
    const log = `${cover}?.querySelector('.agent-chat-log')`
    await js(`${log}?.scrollTo({ top: ${log}.scrollHeight, behavior: 'instant' })`)
    await hoverTime('kakao-narrow-answer', narrowAnswer, false)
  } finally {
    driver.close()
  }
}

run().then(finish).catch(error => {
  console.error(error)
  process.exitCode = 1
})
