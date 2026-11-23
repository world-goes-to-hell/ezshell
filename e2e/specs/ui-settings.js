// 설정 > 백업 > 화면 설정: a settings file is read, shown before anything changes, and applied without
// reloading the window. Only listed keys are written. Run by e2e/run.js (fresh profile, no server needed).
// Export is not driven here: it ends in the OS save dialog, which CDP cannot answer.
const { sleep, createChecks, connect, unlock } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { send, js, until, shot } = driver

  const selectTab = (list, label) => js(`
    [...document.querySelectorAll('${list} > [role=tab]')]
      .find(tab => tab.textContent.trim() === ${JSON.stringify(label)})
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  `)
  const openSettings = async () => {
    // Ctrl+, opens the settings
    const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 }
    await js(`document.activeElement && document.activeElement.blur()`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma })
    return until(`!!document.querySelector('.settings-tabs-list')`, 5000)
  }
  const openBackupTab = async () => {
    await selectTab('.settings-tabs-list', '백업')
    await until(`!!document.querySelector('.backup-tabs')`, 5000)
    await js(`[...document.querySelectorAll('.backup-tabs button')].find(b => b.textContent.includes('화면 설정')).click()`)
    return until(`!!document.querySelector('.session-backup input[type=file]')`, 5000)
  }
  const chooseFile = (name, content) => js(`(() => {
    const input = document.querySelector('.session-backup input[type=file]')
    const dt = new DataTransfer()
    dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: 'application/json' }))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  const pendingText = () => js(`document.querySelector('.ui-settings-pending')?.innerText || ''`)
  const theme = () => js(`document.documentElement.dataset.theme`)

  await unlock(driver)
  const startTheme = await theme()
  check('Ctrl+, opens settings', await openSettings())
  const chatTheme = `document.querySelector('.settings-modal button[aria-label^="채팅 테마"]')`
  await until(`!!${chatTheme}`)
  await driver.click(...await driver.center(chatTheme))
  const kakao = `[...document.querySelectorAll('[role=menuitemradio]')].find(item => item.textContent.trim() === '카톡 모드')`
  await until(`!!${kakao}`)
  await driver.click(...await driver.center(kakao))
  check('settings can select Kakao for chat without changing the app theme', await until(`
    ${chatTheme}?.textContent.trim() === '카톡 모드' && document.documentElement.dataset.theme === ${JSON.stringify(startTheme)}
  `))
  const topTabs = '.settings-tabs-list'
  const mcpTabs = '.settings-mcp-tabs-list'
  const labels = list => js(`[...document.querySelectorAll('${list} > [role=tab]')].map(tab => tab.textContent.trim())`)
  const topLabels = await labels(topTabs)
  check('MCP is a single top-level settings tab', topLabels.includes('MCP') && !topLabels.includes('SSH MCP') && !topLabels.includes('에이전트 메시지'), topLabels.join(' | '))
  await selectTab(topTabs, 'MCP')
  check('MCP contains two subtabs', (await labels(mcpTabs)).join(' | ') === 'SSH MCP | 에이전트 메시지')
  const activeMcpPanel = 'document.querySelector(".settings-mcp-tabs > [role=tabpanel][data-state=active]")'
  check('SSH settings open first', await until(`${activeMcpPanel}?.textContent.includes('ezshell-ssh-mcp')`))
  await js(`document.querySelector('${mcpTabs} [aria-selected=true]').focus()`)
  const right = { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...right })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...right })
  check('keyboard selection opens the agent registration settings', await until(`${activeMcpPanel}?.textContent.includes('ezshell-cli-mcp') &&
    ${activeMcpPanel}.textContent.includes('Codex에 등록') && ${activeMcpPanel}.textContent.includes('Claude Code에 등록')`))
  check('the top-level MCP tab stays selected', await js(`document.querySelector('${topTabs} [aria-selected=true]').textContent.trim() === 'MCP'`))
  await selectTab(mcpTabs, 'SSH MCP')
  check('selecting the SSH subtab returns to its settings', await until(`${activeMcpPanel}?.textContent.includes('ezshell-ssh-mcp')`))

  const clientPicker = 'document.querySelector("#mcp-setup-client")'
  const scopeButtons = `${activeMcpPanel}?.querySelector('.mcp-setup-actions')`
  check('SSH auto-setup starts with Claude Code and its project config', await until(`
    ${clientPicker}?.textContent.trim() === 'Claude Code' && ${scopeButtons}?.textContent.includes('(.mcp.json)')
  `))
  await js(`${clientPicker}.scrollIntoView({ block: 'center' })`)
  await driver.click(...await driver.center(clientPicker))
  check('SSH auto-setup offers Codex, Gemini CLI, OpenCode and Cursor', await until(`
    ['Claude Code', 'Codex', 'Gemini CLI', 'OpenCode', 'Cursor'].every(label =>
      [...document.querySelectorAll('[role=menuitemradio]')].some(item => item.textContent.trim() === label))
  `))
  const codex = `[...document.querySelectorAll('[role=menuitemradio]')].find(item => item.textContent.trim() === 'Codex')`
  await driver.click(...await driver.center(codex))
  check('choosing Codex switches both registration scopes to TOML', await until(`
    ${clientPicker}?.textContent.trim() === 'Codex' &&
    ${scopeButtons}?.textContent.includes('프로젝트에 설정 (.codex/config.toml)') &&
    ${scopeButtons}?.textContent.includes('모든 프로젝트에 설정 (~/.codex/config.toml)')
  `))
  await shot('ssh-mcp-client-setup')

  await selectTab(topTabs, '터미널')
  const scrollback = `document.querySelector('button[aria-label^="터미널 출력 보관 줄 수"]')`
  check('terminal scrollback defaults to 10,000 lines', await until(`${scrollback}?.textContent.trim() === '10,000줄 (기본)'`))
  await driver.click(...await driver.center(scrollback))
  const twoThousand = `[...document.querySelectorAll('[role=menuitemradio]')].find(item => item.textContent.trim() === '2,000줄')`
  await until(`!!${twoThousand}`)
  await driver.click(...await driver.center(twoThousand))
  check('choosing 2,000 lines persists the limit for new terminals', await until(`
    ${scrollback}?.textContent.trim() === '2,000줄' && localStorage.getItem('ezshell.terminalScrollback') === '2000'
  `))

  await selectTab(topTabs, '백업')
  await until(`!!document.querySelector('.backup-tabs')`, 5000)
  await js(`[...document.querySelectorAll('.backup-tabs button')].find(b => b.textContent.includes('다른 프로그램에서 가져오기')).click()`)
  await js(`document.querySelector('.session-backup .backup-section .backup-btn').click()`)
  const fileGuideToggle = `document.querySelector('.xi-file-guide-toggle')`
  const fileGuide = `document.querySelector('.xi-file-guide')`
  check('the import file picker has a compact guide control', await until(`
    ${fileGuideToggle}?.previousElementSibling?.matches('.xi-source.is-file') && ${fileGuide}.hidden
  `))
  await js(`${fileGuideToggle}.click()`)
  check('the guide lists the programs, formats, and how to show an extensionless config', await js(`(() => {
    const guide = ${fileGuide}
    const programs = [...guide.querySelectorAll('dt')].map(item => item.textContent)
    return ${fileGuideToggle}.getAttribute('aria-expanded') === 'true' && !guide.hidden
      && programs.join(',') === 'Xshell,Xftp,PuTTY,MobaXterm,Tabby,FileZilla,OpenSSH'
      && ['.xts', '.xsh', '.xfp', '.reg', '.mxtsessions', 'MobaXterm.ini', 'config.yaml', '.yml', 'sitemanager.xml', '~/.ssh/config', '모든 파일']
        .every(text => guide.textContent.includes(text))
  })()`))
  await js(`${fileGuideToggle}.click()`)
  check('the guide can be collapsed before importing', await js(`${fileGuide}.hidden && ${fileGuideToggle}.getAttribute('aria-expanded') === 'false'`))
  await js(`[...document.querySelectorAll('.xi-actions button')].find(button => button.textContent === '취소').click()`)
  await until(`!document.querySelector('.xi-dialog')`)

  check('the 화면 설정 tab is in 설정 > 백업', await openBackupTab(), String(await js(`[...document.querySelectorAll('.backup-tabs button')].map(b => b.textContent).join(' | ')`)))
  check('it lists what travels', await js(`document.querySelectorAll('.ui-settings-list li').length === 4`))

  // ---- A file that is not a settings file ----
  await chooseFile('sessions.json', JSON.stringify({ sessions: [], folders: [], version: '1.0' }))
  await sleep(600)
  check('another kind of file is refused', !(await pendingText()) && await until(`[...document.querySelectorAll('[class*="toast"]')].some(t => t.textContent.includes('화면 설정 파일을 읽을 수 없습니다'))`, 4000))

  // ---- A settings file: shown first, nothing changes yet ----
  const target = startTheme === 'macos-light' ? 'minimal-dark' : 'macos-light'
  const file = {
    format: 'ezshell-ui-settings',
    version: 1,
    settings: {
      'theme-store': JSON.stringify({ state: { currentThemeId: target, chatThemeId: 'chat-midnight', customThemes: [], surface: 'flat', windowOpacity: 1 } }),
      'ui-store': JSON.stringify({ state: { sidebarMode: 'compact' } }),
      customShortcuts: JSON.stringify({ 'command-palette': ['Ctrl', 'J'], 'no-such-shortcut': ['Ctrl', 'X'] }),
      sftpTransferQueueHeight: '222',
      terminalFileZone: 'maybe',
      'ssh-connection-history': JSON.stringify([{ host: '10.0.0.1' }]),
      recentCommands: JSON.stringify(['rm -rf /'])
    }
  }
  await chooseFile('my-settings.json', JSON.stringify(file))
  check('a settings file is shown before it is applied', await until(`!!document.querySelector('.ui-settings-pending')`, 4000))
  const shown = await pendingText()
  check('with the file name and what it holds', shown.includes('my-settings.json') && shown.includes('4개 항목') && shown.includes('테마') && shown.includes('키보드 단축키'), shown)
  check('and how many entries are left out (one bad value, two unlisted keys)', shown.includes('3개는 건너뜁니다'), shown)
  check('nothing changed yet', (await theme()) === startTheme && (await js(`localStorage.getItem('sftpTransferQueueHeight')`)) === null)
  await shot('ui-settings-1-pending')

  // ---- 취소 leaves everything as it was ----
  await js(`[...document.querySelectorAll('.ui-settings-pending .backup-btn')].find(b => b.textContent.includes('취소')).click()`)
  await sleep(400)
  check('취소 drops the file', !(await pendingText()) && (await theme()) === startTheme)

  // ---- 적용 ----
  await chooseFile('my-settings.json', JSON.stringify(file))
  await until(`!!document.querySelector('.ui-settings-pending')`, 4000)
  await js(`[...document.querySelectorAll('.ui-settings-pending .backup-btn')].find(b => b.textContent.includes('적용')).click()`)
  check('적용 changes the theme at once', await until(`document.documentElement.dataset.theme === ${JSON.stringify(target)}`, 4000), String(await theme()))
  check('the backup restores the independent chat theme', await until(`JSON.parse(localStorage.getItem('theme-store')).state.chatThemeId === 'chat-midnight'`))
  check('and folds the sidebar', await until(`!!document.querySelector('.sidebar.rail')`, 4000))
  check('the shortcut is replaced, the unknown one dropped', (await js(`localStorage.getItem('customShortcuts')`)) === '{"command-palette":["Ctrl","J"]}', String(await js(`localStorage.getItem('customShortcuts')`)))
  check('a plain value is stored for its panel', (await js(`localStorage.getItem('sftpTransferQueueHeight')`)) === '222')
  check('a bad value is not stored', (await js(`localStorage.getItem('terminalFileZone')`)) === null)
  check('keys that are not on the list are never written', (await js(`localStorage.getItem('ssh-connection-history')`)) === null && (await js(`localStorage.getItem('recentCommands')`)) === null)
  check('the window was not reloaded (the settings are still open)', await js(`!!document.querySelector('.settings-tab-trigger')`))
  await shot('ui-settings-2-applied')

  // ---- The imported shortcut works without a restart ----
  const esc = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...esc }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...esc })
  await until(`!document.querySelector('.settings-tab-trigger')`, 4000)
  await js(`document.activeElement && document.activeElement.blur()`)
  const ctrlJ = { key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, modifiers: 2 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ctrlJ }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...ctrlJ })
  check('the imported Ctrl+J opens the command palette', await until(`!!document.querySelector('.command-palette')`, 4000))

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
