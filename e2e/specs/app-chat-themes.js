const { connect, createChecks, openLocalAgent, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const categories = [
  { label: '라이트', names: ['카톡 모드', '종이 노트', '복숭아 소다', '흑백 만화'] },
  { label: '다크', names: ['미드나잇', '디스코드풍'] },
  { label: '특수', names: ['레트로 아케이드', '네온 시티', '앰버 CRT'] }
]

async function run() {
  const driver = await connect()
  const { js, until, send, click, center, shot } = driver
  const press = async key => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }
  const button = (selector, name) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.textContent.trim() === ${JSON.stringify(name)})`
  const card = name => `[...document.querySelectorAll('.theme-card-main')].find(item => item.querySelector('.theme-name').textContent === ${JSON.stringify(name)})`
  const themeSetting = 'JSON.parse(localStorage.getItem("theme-store")).state.chatThemeId'
  const themeNames = () => js(`[...document.querySelectorAll('.theme-grid .theme-name')].map(name => name.textContent)`)
  const pairedNames = categories.flatMap(category => category.names)
  const selectFilter = label => js(`${button('.theme-toolbar .theme-filter-tab', label)}.click()`)
  const selectAppTheme = (name, id, scheme) => js(`${card(name)}.click()`).then(() => until(`
    document.documentElement.dataset.theme === ${JSON.stringify(id)} &&
    document.documentElement.dataset.scheme === ${JSON.stringify(scheme)} &&
    !document.documentElement.hasAttribute('data-chrome') &&
    ${card(name)}?.getAttribute('aria-pressed') === 'true'`))
  async function showLastCards(names) {
    await js(`(() => {
      const panel = document.querySelector('.settings-tab-content[data-state="active"] .settings-content')
      const grid = panel.querySelector('.theme-grid')
      panel.scrollTop += grid.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom + 4
    })()`)
    if (!await until(`(() => {
      const panel = document.querySelector('.settings-tab-content[data-state="active"] .settings-content')
      const top = panel.querySelector('.theme-toolbar').getBoundingClientRect().bottom
      const bottom = panel.getBoundingClientRect().bottom
      return ${JSON.stringify(names)}.every(name => {
        const label = [...panel.querySelectorAll('.theme-name')].find(label => label.textContent === name)
        const bounds = label?.getBoundingClientRect()
        return bounds && bounds.top >= top && bounds.bottom <= bottom
      })
    })()`)) throw new Error(`Paired theme cards were outside the screenshot (${names.join(', ')})`)
  }

  try {
    await unlock(driver)
    await send('Page.bringToFront')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const windowId = (await send('Browser.getWindowForTarget')).result?.windowId
    if (windowId !== undefined) {
      await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await send('Browser.setWindowBounds', { windowId, bounds: { width: 1360, height: 900 } })
    }

    await openLocalAgent(driver)
    const pane = "document.querySelector('.local-terminal-pane[data-local-shell-id]')"
    if (!await until(`!!${pane}`)) throw new Error('The local terminal did not open')
    if (process.platform === 'win32') {
      if (!await until(`/PS [A-Z]:/.test(${pane}.querySelector('.xterm-rows')?.textContent ?? '')`)) throw new Error('PowerShell did not start')
      const demonstration = [
        "function prompt { 'PS demo> ' }", 'Clear-Host',
        "Write-Host 'Local workspace'", "Write-Host '  Build    ready' -ForegroundColor DarkGreen",
        "Write-Host '  Tests    passed' -ForegroundColor DarkCyan", "Write-Host '  Branch   main' -ForegroundColor DarkBlue",
        "Write-Host '  Queue    review pending' -ForegroundColor DarkYellow"
      ].join('; ')
      await js(`window.electronAPI.localShellWrite(${pane}.dataset.localShellId, ${JSON.stringify(demonstration + '\r')})`)
      if (!await until(`${pane}.querySelector('.xterm-rows')?.textContent.trimEnd().endsWith('PS demo>')`)) throw new Error('The terminal sample did not print')
    }

    await js('document.activeElement?.blur()')
    await press({ key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 })
    if (!await until("!!document.querySelector('.theme-grid')")) throw new Error('Settings > Theme did not open')
    const initialNames = await themeNames()
    check('all nine paired app themes appear in the full list', pairedNames.every(name => initialNames.includes(name)))

    const chat = `document.querySelector('.settings-modal button[aria-label^="채팅 테마"]')`
    await click(...await center(chat))
    const paper = button('[role=menuitemradio]', '종이 노트')
    check('the chat picker distinguishes a paired app theme from its chat palette',
      await until(`!!${paper} && !!${button('[role=menuitemradio]', '종이 노트 (앱 테마)')}`))
    await click(...await center(paper))
    if (!await until(`${themeSetting} === 'chat-paper'`)) throw new Error('The chat palette was not saved')

    for (const { label, names } of categories) {
      await selectFilter(label)
      const list = await themeNames()
      check(`${label} contains its paired app themes`, pairedNames.filter(name => list.includes(name)).join('|') === names.join('|'))
    }
    await selectFilter('커스텀')
    check('paired app themes stay out of the custom list', (await themeNames()).every(name => !pairedNames.includes(name)))

    await selectFilter('다크')
    check('Midnight applies as a dark app theme', await selectAppTheme('미드나잇', 'midnight', 'dark'))
    await showLastCards(categories[1].names)
    await sleep(250)
    await shot('app-chat-themes-dark')
    await selectFilter('특수')
    check('Neon City applies as a special dark app theme', await selectAppTheme('네온 시티', 'neon-city', 'dark'))
    await showLastCards(categories[2].names)
    await sleep(250)
    await shot('app-chat-themes-special')
    await selectFilter('라이트')
    check('Kakao applies as a light app theme and leaves the selected chat palette alone',
      await selectAppTheme('카톡 모드', 'kakao-mode', 'light') && await js(`${themeSetting} === 'chat-paper'`))
    check('Kakao uses its sky surface and warm accent throughout the app', await js(`(() => {
      const style = getComputedStyle(document.documentElement)
      return style.getPropertyValue('--bg-tertiary').trim() === '#dce8f4' &&
        style.getPropertyValue('--accent').trim() === '#805800' &&
        style.getPropertyValue('--terminal-background').trim() === '#f8fbff'
    })()`))
    await showLastCards(categories[0].names)
    await sleep(250)
    await shot('app-chat-themes-light')

    await js(`document.querySelector('.settings-modal .modal-close-btn').click()`)
    if (!await until("!document.querySelector('.settings-modal')")) throw new Error('Settings did not close')
    await shot('app-chat-themes-kakao')
  } finally {
    driver.close()
  }
}

run().then(finish).catch(error => { console.error(error); process.exit(1) })
