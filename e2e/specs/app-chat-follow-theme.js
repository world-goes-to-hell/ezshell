const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, openLocalAgent, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const pane = "document.querySelector('.local-terminal-pane[data-pane=main]')"
const cover = `${pane}?.querySelector('.agent-chat-cover')`
const choice = 'JSON.parse(localStorage.getItem("theme-store") ?? "{}").state?.chatThemeId ?? "app"'

function reportSample(profile) {
  const session = 'a0931449-779a-4ffc-9798-74ccf6be0760'
  const transcript = path.join(profile, 'claude-home', 'projects', 'test', `${session}.jsonl`)
  const entries = [
    { type: 'user', uuid: 'theme-question', timestamp: '2026-11-24T05:00:00Z',
      message: { role: 'user', content: '배포 전 확인할 항목을 정리해 줘.' } },
    { type: 'assistant', uuid: 'theme-answer', timestamp: '2026-11-24T05:00:05Z',
      message: { id: 'theme-answer', role: 'assistant', content: [{ type: 'text', text: '배포 전 확인할 항목입니다.\n\n- 테스트 결과를 확인합니다.\n- 변경 사항과 복구 절차를 검토합니다.' }] } }
  ]
  fs.writeFileSync(transcript, entries.map(entry => JSON.stringify(entry) + '\n').join(''))
  const input = path.join(profile, 'claude-theme-status.json')
  fs.writeFileSync(input, JSON.stringify({ session_id: session }))
  fs.writeFileSync(path.join(profile, 'claude-1-command'), `"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_AGENT_USAGE_SCRIPT%" < "${input}"`)
}

async function run() {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  const { js, until, send, click, center, shot } = driver
  let pin
  const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    const event = { key, code, windowsVirtualKeyCode, modifiers }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }
  async function setAppTheme(name, id) {
    await js(`document.querySelector('.title-bar-btn[title="설정"]').click()`)
    const card = `[...document.querySelectorAll('.theme-card-main')].find(card =>
      card.querySelector('.theme-name').textContent === ${JSON.stringify(name)})`
    if (!await until(`!!${card}`)) throw new Error(`App theme ${name} was not listed`)
    await js(`${card}.click()`)
    if (!await until(`document.documentElement.dataset.theme === '${id}'`)) throw new Error(`App theme ${name} did not apply`)
    await js(`document.querySelector('.settings-modal .modal-close-btn').click()`)
    if (!await until("!document.querySelector('.settings-modal')")) throw new Error('Settings did not close')
  }
  async function chatOption(label) {
    await click(...await center(`${cover}?.querySelector('.agent-chat-theme-trigger')`))
    const option = `[...document.querySelectorAll('.select-menu-content [role=menuitemradio]')].find(item =>
      item.textContent.trim() === ${JSON.stringify(label)})`
    if (!await until(`!!${option}`)) throw new Error(`Chat theme ${label} was not listed`)
    return option
  }
  async function chooseChat(label) {
    const option = await chatOption(label)
    await js(`${option}.scrollIntoView({ block: 'nearest' })`)
    await click(...await center(option))
  }
  const applies = (id, canvas) => `(${cover}?.dataset.chatTheme === '${id}' && ${cover}.hasAttribute('data-chat-bubbles') &&
    getComputedStyle(${cover}).getPropertyValue('--terminal-bg').trim() === '${canvas}')`

  try {
    await unlock(driver)
    await send('Page.bringToFront')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await openLocalAgent(driver, 'claude', process.env.E2E_PROFILE)
    if (!await until(`document.body.textContent.includes('fixture ready: claude-1') && !!${pane}?.dataset.agentWork`, 30000)) {
      throw new Error('The fake Claude did not bind')
    }
    await js(`${pane}.querySelector('.xterm-helper-textarea').focus()`)
    await press('F11', 'F11', 122, 10)
    if (!await until(`!!${cover}`)) throw new Error('The chat view did not open')
    reportSample(process.env.E2E_PROFILE)
    if (!await until(`${cover}?.querySelector('.agent-chat-md')?.textContent.includes('복구 절차')`)) throw new Error('The fixture conversation did not load')
    check('following an unpaired theme inherits the app palette', await js(`!${cover}.hasAttribute('data-chat-theme') &&
      !${cover}.hasAttribute('data-chat-bubbles') && (${choice}) === 'app'`))

    await setAppTheme('카톡 모드', 'kakao-mode')
    check('following Kakao applies the chat canvas, bubbles, time and pane motion', await until(`${applies('chat-kakao', '#dce8f4')} &&
      !!${cover}.querySelector('.agent-chat-sent-time') && getComputedStyle(${pane}).getPropertyValue('--chat-trace').trim() === '#a86f00' &&
      (${choice}) === 'app'`))
    await shot('app-chat-follow-kakao')
    const followingKakao = await chatOption('앱 테마 따르기 · 카톡 모드')
    check('the chat theme menu names the followed palette and keeps follow selected', await js(`${followingKakao}.getAttribute('aria-checked') === 'true'`))
    await shot('app-chat-follow-menu')
    await press('Escape', 'Escape', 27)

    await js(`${cover}.querySelector('.agent-chat-pin').click()`)
    pin = await connect(page => page.url.includes('pinnedReplyMode=true'))
    const pinCanvas = "document.querySelector('.pinned-reply') && getComputedStyle(document.querySelector('.pinned-reply')).getPropertyValue('--terminal-bg').trim()"
    check('a pinned answer follows the companion palette', await pin.until(`${pinCanvas} === '#dce8f4'`))
    await setAppTheme('미드나잇', 'midnight')
    check('changing the app redraws the chat with the next companion and preserves follow',
      await until(`${applies('chat-midnight', '#131625')} && (${choice}) === 'app'`))
    check('the pinned answer follows the app change as well', await pin.until(`${pinCanvas} === '#131625'`))

    await chooseChat('종이 노트')
    await setAppTheme('카톡 모드', 'kakao-mode')
    check('an explicit chat preset stays selected and visible across app changes',
      await until(`${applies('chat-paper', '#f3ecdb')} && (${choice}) === 'chat-paper'`))
    await chooseChat('앱 테마 따르기 · 카톡 모드')
    check('choosing follow again restores the companion', await until(`${applies('chat-kakao', '#dce8f4')} && (${choice}) === 'app'`))
    await setAppTheme('Minimal Light', 'minimal-light')
    check('switching to an unpaired app theme clears the companion styling', await until(`!${cover}.hasAttribute('data-chat-theme') &&
      !${cover}.hasAttribute('data-chat-bubbles') && ${pane}.style.getPropertyValue('--chat-trace') === '' && (${choice}) === 'app'`))
    const followingLight = await chatOption('앱 테마 따르기 · Minimal Light')
    check('the menu names the inherited app palette when no companion exists', await js(`${followingLight}.getAttribute('aria-checked') === 'true'`))
  } finally {
    pin?.close()
    driver.close()
  }
}

run().then(finish).catch(error => { console.error(error); process.exit(1) })
