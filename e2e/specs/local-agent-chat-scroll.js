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
  const driver = await connect()
  const { js, send, until, center, click } = driver
  try {
    await unlock(driver)
    await send('Page.bringToFront')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await openLocalAgent(driver, 'claude', profile)
    if (!await until("document.body.textContent.includes('fixture ready: claude-1')")) throw new Error('The Claude fixture did not open')

    const sessionId = '5a6f0d9e-1b2c-4d3e-8f90-0a1b2c3d4e5f'
    const transcript = path.join(profile, 'claude-home', 'projects', 'test', sessionId + '.jsonl')
    const entry = (type, uuid, content) => JSON.stringify({
      type, uuid, timestamp: new Date().toISOString(), message: { id: uuid, role: type, content }
    }) + '\n'
    const answer = (id, text) => entry('assistant', id, [{ type: 'text', text }])
    const longReply = (length, lastLine) => [
      '## 마지막 답변', '| 항목 | 값 |\n| --- | --- |\n| 상태 | 정상 |',
      ['```yaml', ...Array.from({ length }, (_, index) => `  row-${index}: ${'value '.repeat(18)}`), '```'].join('\n'),
      lastLine
    ].join('\n\n')
    const end = '긴 코드 블록 뒤에 있는 마지막 줄'
    fs.writeFileSync(transcript, Array.from({ length: 100 }, (_, index) =>
      entry('user', 'question-' + index, '질문 ' + index) + answer('answer-' + index, '답변 ' + index)
    ).join('') + entry('user', 'latest-question', '긴 답변을 보여 주세요') + answer('latest-answer', longReply(85, end)))
    const statusReport = path.join(profile, 'claude-status.json')
    fs.writeFileSync(statusReport, JSON.stringify({ session_id: sessionId, model: { id: 'claude-opus-5-5' } }))
    fs.writeFileSync(path.join(profile, 'claude-1-command'), `"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_AGENT_USAGE_SCRIPT%" < "${statusReport}"`)
    await js("document.querySelector('.local-terminal-pane .xterm-helper-textarea').focus()")
    const toggle = { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...toggle })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...toggle })

    const log = "document.querySelector('.agent-chat-cover .agent-chat-log')"
    const previous = "document.querySelector('.agent-chat-jump-question')"
    const bottom = "document.querySelector('.agent-chat-jump-bottom')"
    const atEnd = lastLine => `(() => {
      const log = ${log}
      const marker = [...(log?.querySelectorAll('.agent-chat-md p') ?? [])].find(p => p.textContent === ${JSON.stringify(lastLine)})
      if (!marker) return false
      const line = marker.getBoundingClientRect(), viewport = log.getBoundingClientRect()
      return line.top >= viewport.top && line.bottom <= viewport.bottom + 1
        && log.scrollHeight - log.clientHeight - log.scrollTop <= 2 && !${bottom}
    })()`
    const wheelAt = async (target, deltaY) => {
      const [x, y] = await center(target)
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
    }
    check('opening the chat shows the final paragraph of a tall Markdown answer', await until(atEnd(end)))
    for (const target of [log, previous]) {
      await wheelAt(target, 180)
      await sleep(250)
      check('a downward wheel at the end does not move back up', await js(atEnd(end)))
    }
    for (const [target, label] of [[previous, 'previous-question bar'], [bottom, 'jump-to-bottom button']]) {
      await wheelAt(log, -420)
      if (!await until(`!!${bottom} && !${atEnd(end)}`, 3000)) throw new Error('Wheeling up did not leave the end')
      await wheelAt(target, 650)
      check(`wheeling over the ${label} returns to the end without clicking`, await until(atEnd(end), 3000))
      // Isolate the next gesture if the previous assertion failed.
      if (await js(`!!${bottom}`)) await js(`${bottom}.click()`)
      await until(atEnd(end), 3000)
    }
    await wheelAt(log, -680)
    if (!await until(`!!${bottom} && !${atEnd(end)}`, 3000)) throw new Error('The jump button is missing')
    await click(...await center(bottom))
    await wheelAt(log, 200)
    check('wheeling down while returning to the end keeps the final paragraph visible', await until(atEnd(end), 3000))

    const expandedEnd = '답변이 길어진 뒤의 마지막 줄'
    fs.appendFileSync(transcript, answer('latest-answer', longReply(125, expandedEnd)))
    await wheelAt(log, 200)
    check('a growing final answer still follows to its last paragraph', await until(atEnd(expandedEnd), 5000))

    const height = await js(`${log}.clientHeight`)
    const composer = "document.querySelector('.agent-chat-input')"
    const growDraft = async () => {
      await js(`${composer}.focus({ preventScroll: true })`)
      await send('Input.insertText', { text: Array.from({ length: 7 }, (_, index) => '초안 ' + index).join('\n') })
    }
    const clearDraft = () => js(`(() => {
      const input = ${composer}
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await growDraft()
    check('the end stays visible when the composer grows and makes the viewport shorter', await until(`
      ${log}.clientHeight < ${height} - 60 && ${atEnd(expandedEnd)}
    `, 3000))
    await clearDraft()
    await until(`${log}.clientHeight === ${height}`)
    await wheelAt(log, -550)
    await until(`!!${bottom}`)
    const scrollTop = await js(`${log}.scrollTop`)
    await growDraft()
    check('a reader stays in place when the composer grows away from the end', await until(`
      ${log}.clientHeight < ${height} - 60 && Math.abs(${log}.scrollTop - ${scrollTop}) <= 2
    `, 3000))
    await js(`(() => {
      const log = ${log}
      const distance = 160 + Math.floor((${height} - log.clientHeight) / 2)
      log.scrollTop = log.scrollHeight - log.clientHeight - distance
    })()`)
    await until(`!!${bottom}`)
    await clearDraft()
    check('the jump button reflects the remaining distance even when only the viewport changes', await until(`
      ${log}.clientHeight === ${height} && !${bottom} && ${log}.scrollHeight - ${log}.clientHeight - ${log}.scrollTop > 2
    `, 3000))
  } finally { driver.close() }
}

run().then(finish).catch(error => { console.error(error); process.exit(1) })
