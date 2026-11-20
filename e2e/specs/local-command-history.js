// Exercise the shared local history through real terminal input and the platform shell.
const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const command = 'echo EZSHELL-HISTORY-LOCAL'
const activePane = `[...document.querySelectorAll('.local-terminal-pane')].find(pane => getComputedStyle(pane).visibility === 'visible')`
const rows = `[...(${activePane})?.querySelectorAll('.xterm-rows > div') ?? []].map(row => row.textContent.replaceAll('\u00a0', ' ').trimEnd())`
const popup = `document.querySelector('.history-popup')`
const panel = `document.querySelector('.command-history-panel')`

;(async () => {
  const driver = await connect()
  const { js, until, type, enter, send } = driver
  const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    const event = { key, code, windowsVirtualKeyCode, modifiers }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }
  const openShell = async (count) => {
    await js(`document.querySelector('.local-terms-btn[aria-label="새 로컬 터미널"]').click()`)
    return until(`document.querySelectorAll('.local-terminal-tab').length === ${count} && ${rows}.some(row => /[#$%>❯]$/.test(row))`, 30000)
  }
  const focusTerminal = () => js(`(${activePane}).querySelector('.xterm-helper-textarea').focus()`)
  const historyShortcut = () => press('H', 'KeyH', 72, 10)
  const item = selector => `([...document.querySelectorAll(${JSON.stringify(selector)})].some(item => item.textContent === ${JSON.stringify(command)}))`

  await unlock(driver)
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  check('a local shell opens', await openShell(1))
  await focusTerminal()
  await type(command)
  await enter()
  check('the shell runs the typed command', await until(`${rows}.includes('EZSHELL-HISTORY-LOCAL')`))
  await historyShortcut()
  check('Ctrl+Shift+H shows the recorded local command', await until(`(${popup})?.querySelector('.history-command')?.textContent === ${JSON.stringify(command)}`))
  await press('Escape', 'Escape', 27)

  check('a second local shell opens', await openShell(2))
  await focusTerminal()
  await type('echo unwanted draft   ')
  await until(`${rows}.some(line => line.endsWith('echo unwanted draft'))`)
  await press('ArrowLeft', 'ArrowLeft', 37)
  await historyShortcut()
  check('other local shells share the list', await until(`(${popup})?.querySelector('.history-command')?.textContent === ${JSON.stringify(command)}`))
  await enter()
  check('picking history replaces the draft without running it', await until(`
    ${rows}.some(line => line.endsWith(${JSON.stringify(command)})) &&
    !${rows}.some(line => line.includes('unwanted draft') || line === 'EZSHELL-HISTORY-LOCAL') && !${popup}
  `), JSON.stringify(await js(rows)))
  await enter()
  check('the recalled command runs when Enter is pressed in the shell', await until(`${rows}.includes('EZSHELL-HISTORY-LOCAL')`))

  await type('echo EZSHELL')
  check('local history suggests commands while typing', await until(item('.command-suggest-item'), 5000))
  await press('ArrowDown', 'ArrowDown', 40)
  check('the arrow key selects the local suggestion', await until(item('.command-suggest-item[aria-selected="true"]'), 3000))
  await enter()
  check('accepting autocomplete fills the input with no second execution', await until(`
    ${rows}.filter(line => line.endsWith(${JSON.stringify(command)})).length === 2 &&
    ${rows}.filter(line => line === 'EZSHELL-HISTORY-LOCAL').length === 1
  `), JSON.stringify(await js(rows)))

  const historyFile = path.join(process.env.E2E_PROFILE, 'command-history.json')
  const saved = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf8') : ''
  check('the shared history file encrypts local commands', !!saved && !!JSON.parse(saved).encrypted && !saved.includes(command))

  const point = await driver.center(`(${activePane}).querySelector('.local-terminal-host')`)
  await driver.click(...point, 'right')
  await driver.pick('명령어 기록')
  check('the local context menu opens the history panel', await until(item('.command-history-panel .history-command')),
    JSON.stringify(await js(`([...document.querySelectorAll('.command-history-panel .history-command')].map(item => item.textContent))`)))
  await js(`(${panel}).querySelector(${JSON.stringify(`button[aria-label="삭제: ${command}"]`)})?.click()`)
  check('deleting a command removes it from the local list', await until(`!!${panel} && !${item('.command-history-panel .history-command')}`))
  driver.close()
  finish()
})().catch((error) => { console.error(error); process.exit(1) })
