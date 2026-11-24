// 바이트 데몬 (상태 줄의 미니 게임): the icon sits at the end of the status bar, opens a popover with
// the three games and the producers, a click on the daemon gives bytes and buys the first producer,
// each game starts and plays (catch a bug, type a command, deploy one step), Esc closes and gives
// focus back, the command palette hides and shows the icon, and the popover follows a light theme.
// Run by e2e/run.js (fresh profile, no server needed).
const { sleep, createChecks, connect, unlock, pageProblems, SET } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { send, js, until, shot, click, center } = driver
  await unlock(driver)

  const key = async (name, code, vk, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk, modifiers })
  }
  const press = async selector => {
    const at = await center(selector)
    if (!at) throw new Error('nothing at ' + selector)
    await click(at[0], at[1])
    await sleep(150)
  }
  const TRIGGER = `document.querySelector('.app-footer .bd-trigger')`
  const PANEL = `document.querySelector('.bd-panel')`
  const button = text => `[...document.querySelectorAll('.bd-panel button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}))`

  check('the daemon sits at the very end of the status bar', await until(`(() => {
    const right = document.querySelector('.app-footer .footer-right')
    return right && right.lastElementChild && right.lastElementChild.querySelector('.bd-trigger') !== null
  })()`, 8000))
  check('closed, nothing of the game is drawn but the icon', await js(`!${PANEL} && !!${TRIGGER}.querySelector('.bd-icon-asleep')`))

  await press(TRIGGER)
  check('the icon opens the popover with three games and the first producer', await until(`!!${PANEL} &&
    document.querySelectorAll('.bd-game').length === 3 && document.querySelectorAll('.bd-prod:not(.is-locked)').length === 1`))
  check('the popover takes the focus', await js(`${PANEL}.contains(document.activeElement)`))

  for (let i = 0; i < 9; i++) await press(`document.querySelector('.bd-avatar')`)
  const buy = `document.querySelector('.bd-prod:not(.is-locked) .bd-buy')`
  check('a handful of clicks on the daemon pays for the first producer', await until(`!${buy}.disabled`, 3000), await js(`document.querySelector('.bd-bytes').textContent`))
  await press(buy)
  check('buying adds it and logs that it joined', await until(`document.querySelector('.bd-count')?.textContent === '×1' &&
    [...document.querySelectorAll('.bd-log-line')].some(l => l.textContent.includes('합류'))`, 3000))
  await shot('byte-daemon-home')

  // Catch the bug
  await press(`[...document.querySelectorAll('.bd-play')][0]`)
  check('catch the bug: log lines arrive and a bug crawls in', await until(`document.querySelectorAll('.bd-logrow').length >= 3 && !!document.querySelector('.bd-critter')`, 10000))
  let caught = false
  for (let i = 0; i < 20 && !caught; i++) {
    const at = await center(`[...document.querySelectorAll('.bd-critter:not(.is-caught)')].find(c => { const r = c.getBoundingClientRect(); const b = document.querySelector('.bd-logbox').getBoundingClientRect(); return r.left > b.left + 10 && r.right < b.right - 10 })`)
    if (at) {
      // The bug crawls left while the pointer travels (about 150 ms): aim a little ahead of it
      await driver.move(at[0] + 30, at[1])
      const near = await center(`[...document.querySelectorAll('.bd-critter:not(.is-caught)')].sort((a, b) => Math.abs(a.getBoundingClientRect().left - ${at[0]}) - Math.abs(b.getBoundingClientRect().left - ${at[0]}))[0]`)
      if (!near) continue
      await click(near[0] - 8, near[1])
      caught = await until(`document.querySelectorAll('.bd-hud b')[1].textContent !== '0'`, 600)
    } else await sleep(300)
  }
  check('clicking a bug scores', caught, await js(`document.querySelectorAll('.bd-hud b')[1].textContent`))
  await shot('byte-daemon-bugs')
  await press(button('← 나가기'))

  // Command typing
  await press(`[...document.querySelectorAll('.bd-play')][1]`)
  check('typing: the input takes the focus', await until(`document.activeElement?.closest('.bd-type-target') !== null`, 3000))
  const command = await js(`document.querySelector('.bd-type-target input').getAttribute('aria-label').replace('입력할 명령: ', '')`)
  for (const ch of command.slice(0, 4)) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    await sleep(30)
  }
  check('typed characters turn done', await until(`document.querySelector('.bd-type-done').textContent === ${JSON.stringify(command.slice(0, 4))}`, 2000),
    await js(`document.querySelector('.bd-type-done').textContent`))
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '#', text: '#' })
  check('a wrong character resets the combo and flags the cursor', await until(`!!document.querySelector('.bd-type-cur.is-miss')`, 2000))
  await shot('byte-daemon-typing')
  await press(button('← 나가기'))

  // Friday deploy: needs a stake, so pet the daemon a bit more
  for (let i = 0; i < 10; i++) await press(`document.querySelector('.bd-avatar')`)
  await press(`[...document.querySelectorAll('.bd-play')][2]`)
  check('deploy: the ladder shows four steps', await until(`document.querySelectorAll('.bd-rung').length === 4`, 3000))
  await press(button('판돈'))
  check('starting takes the stake and offers the first step', await until(`!!${button('빌드 도전')}`, 3000))
  await press(button('빌드 도전'))
  check('a step either passes or rolls back', await until(`!!document.querySelector('.bd-rung.is-current') || !!document.querySelector('.bd-result')`, 3000))
  await shot('byte-daemon-deploy')

  // Esc closes and gives the focus back
  await key('Escape', 'Escape', 27)
  check('Esc closes the popover', await until(`!${PANEL}`, 2000))
  check('the focus goes back to the icon it was opened from', await js(`document.activeElement === ${TRIGGER}`))

  // Command palette: hide and show the icon
  const palette = async () => {
    await js(`document.activeElement && document.activeElement.blur()`)
    await key('p', 'KeyP', 80, 2)
    await until(`!!document.querySelector('.command-palette input')`, 3000)
    await js(`(() => { const set = ${SET}; set(document.querySelector('.command-palette input'), '미니 게임 아이콘') })()`)
    await until(`document.querySelector('.command-palette')?.textContent.includes('미니 게임 아이콘')`, 3000)
    await driver.enter()
    await sleep(300)
  }
  await palette()
  check('the palette hides the icon', await until(`!${TRIGGER}`, 3000))
  await palette()
  check('and brings it back', await until(`!!${TRIGGER}`, 3000))

  // A light theme with round corners: the popover follows the theme's colours
  await js(`(() => {
    const raw = JSON.parse(localStorage.getItem('theme-store') || '{"state":{},"version":0}')
    raw.state = { ...raw.state, currentThemeId: 'macos-light' }
    localStorage.setItem('theme-store', JSON.stringify(raw))
    location.reload()
  })()`)
  await sleep(1500)
  await unlock(driver)
  await press(TRIGGER)
  await until(`!!${PANEL}`, 3000)
  check('the popover takes its background and corners from the theme', await js(`(() => {
    const panel = getComputedStyle(${PANEL})
    const root = getComputedStyle(document.documentElement)
    const probe = document.createElement('div')
    probe.style.background = root.getPropertyValue('--bg-secondary')
    document.body.appendChild(probe)
    const expected = getComputedStyle(probe).backgroundColor
    probe.remove()
    return panel.backgroundColor === expected && parseFloat(panel.borderTopLeftRadius) > 0
  })()`), await js(`getComputedStyle(${PANEL}).backgroundColor + ' / ' + getComputedStyle(${PANEL}).borderTopLeftRadius`))
  check('the progress was kept across the reload', await js(`document.querySelector('.bd-count')?.textContent === '×1'`))
  await shot('byte-daemon-light')

  check('no console errors or CSP refusals', (await pageProblems(driver)).length === 0, (await pageProblems(driver)).join(' | '))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
