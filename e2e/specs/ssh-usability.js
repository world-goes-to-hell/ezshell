// Saved session discovery and keyboard navigation, renaming, transfer retry and close-time tab state.
const fs = require('node:fs')
const path = require('node:path')
const { connect, connectSsh, createChecks, unlock, sleep, SET, PANEL } = require('../support/driver')
const { decrypt } = require('../../src/crypto')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, send, enter, center, click, menuPick } = driver
  const selector = (value) => `document.querySelector(${JSON.stringify(value)})`
  const clickElement = (value) => js(`${selector(value)}.click()`)
  const setInput = (value, text) => js(`(${SET})(${selector(value)}, ${JSON.stringify(text)})`)
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    const args = { key, code, windowsVirtualKeyCode, modifiers }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...args })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...args })
  }

  await unlock(driver)
  const folders = [{ id: 'production', name: 'Production' }, { id: 'staging', name: 'Staging' }]
  const sessions = folders.map(({ id }) => ({
    id: `server-${id}`, folderId: id, name: 'Shared endpoint', host: '127.0.0.1',
    port: Number(process.env.E2E_SSH_PORT), username: 'tester', authType: 'password', password: 'x'
  }))
  await js(`window.electronAPI.saveFolders(${JSON.stringify({ folders, expandedFolders: [] })})`)
  await js(`window.electronAPI.saveSessions(${JSON.stringify(sessions)})`)
  await send('Page.reload')
  await sleep(1200)
  await unlock(driver)

  check('with saved sessions the welcome screen shows only the app mark and name', await until(`
    !!${selector('.sidebar-search')} && !!${selector('.welcome-icon svg')} &&
    ${selector('.welcome-screen')}?.textContent.trim() === 'ezShell' &&
    !${selector('.welcome-screen button')}
  `))

  // The sidebar's search box marks the matches in the tree and hides nothing
  const search = '.sidebar-search input'
  const folderOpen = (id) => `${selector(`[data-folder-id="${id}"]`)}?.getAttribute('aria-expanded') === 'true'`
  const marked = `[...document.querySelectorAll('.session-item.is-search-match')].map(row => row.dataset.sessionId).join()`
  const current = `${selector('.session-item.is-search-current')}?.dataset.sessionId`
  check('the sidebar has a search box instead of the picker button', await js(`!!${selector(search)} && !${selector('.sidebar-session-search')}`))
  await js(`${selector(search)}.focus()`)
  await setInput(search, 'staging')
  check('a match is marked and its closed folder is shown open', await until(`${marked} === 'server-staging' && ${folderOpen('staging')} && ${current} === 'server-staging'`), await js(marked))
  check('the folder that does not match stays in the list', await js(`!!${selector('[data-folder-id="production"]')} && !(${folderOpen('production')})`))
  check('the count says which match is current', (await js(`${selector('.sidebar-search-count')}?.textContent`)) === '1/1')
  await setInput(search, 'shared')
  check('both sessions match and the first one is current', await until(`${marked} === 'server-production,server-staging' && ${current} === 'server-production'`), await js(marked))
  await key('ArrowDown', 'ArrowDown', 40)
  check('down arrow makes the next match current, typing stays in the box', await until(`${current} === 'server-staging'`) && await js(`document.activeElement === ${selector(search)}`))
  await key('Escape', 'Escape', 27)
  check('Esc clears the search and the folders close again', await until(`${selector(search)}.value === '' && ${marked} === '' && !(${folderOpen('staging')}) && !(${folderOpen('production')})`))
  await js('document.activeElement.blur()')
  await key('p', 'KeyP', 80, process.platform === 'darwin' ? 4 : 2)
  check('the command palette names both folders', await until(`
    ['Production', 'Staging'].every(folder =>
      Array.from(document.querySelectorAll('.command-item')).some(el => el.textContent.includes('Shared endpoint') && el.textContent.includes(folder)))
  `))
  await key('Escape', 'Escape', 27)
  await until(`!${selector('.command-palette')}`)
  check('connected once to trust the fixture server', await connectSsh(driver))

  await click(...await center(selector('.terminal-tabs .new-tab-btn')))
  const pickSession = `[...document.querySelectorAll('.new-tab-menu-item')].find(item => item.textContent.includes('기존 세션 선택'))`
  check('the tab strip still opens the saved session picker', await until(`!!${pickSession}`, 4000))
  await click(...await center(pickSession))
  await until(`!!${selector('.session-picker-search input')}`)
  await setInput('.session-picker-search input', 'Staging')
  check('folder search distinguishes two sessions with the same connection information', await until(
    `document.querySelectorAll('.session-picker-item').length === 1 && ${selector('.session-picker-item')}?.textContent.includes('Staging')`
  ))
  await key('Escape', 'Escape', 27)
  await until(`!${selector('.session-picker-modal')}`)

  const prod = selector('[data-folder-id="production"]')
  const sessionRow = selector('[data-session-id="server-production"]')
  await js(`${prod}.focus()`)
  await key('ArrowRight', 'ArrowRight', 39)
  check('right arrow opens a focused folder', await until(`${prod}.getAttribute('aria-expanded') === 'true'`))
  await key('ArrowDown', 'ArrowDown', 40)
  check('down arrow focuses the visible session', await until(`document.activeElement === ${sessionRow}`))
  await key('ArrowLeft', 'ArrowLeft', 37)
  check('left arrow moves back to its parent', await until(`document.activeElement === ${prod}`))
  await key('ArrowDown', 'ArrowDown', 40)
  await enter()
  check('Enter opens the focused saved session', await until(`${selector('.terminal-tab.active [data-tab-label]')}?.textContent === 'Shared endpoint'`))

  const activeTab = selector('.terminal-tab.active')
  await click(...await center(activeTab), 'right')
  const rename = `[...document.querySelectorAll('.tab-context-menu .menu-item')].find(button => button.textContent === '탭 이름 변경')`
  await until(`!!${rename}`)
  await js(`${rename}.click()`)
  const nameInput = selector('#terminal-tab-name')
  check('rename focuses and selects the current tab name', await until(
    `document.activeElement === ${nameInput} && ${nameInput}?.selectionEnd === 'Shared endpoint'.length`
  ))
  await setInput('#terminal-tab-name', '   ')
  check('the rename form prevents a blank name', await js(`${selector('.tab-rename-dialog button[type=submit]')}.disabled`))
  await setInput('#terminal-tab-name', ' Deployment ')
  await enter()
  check('the saved rename is trimmed and visible on the same tab', await until(`${activeTab}.querySelector('[data-tab-label]').textContent === 'Deployment'`))

  const term = await center(`(${PANEL})?.querySelector('.xterm-screen')`)
  await menuPick(term[0], term[1] - 60, '편의', 'SFTP 를 현재 폴더로')
  check('SFTP panel opens', await until(`!!${selector('.transfer-queue-toggle')}`))
  const sessionId = await js(`${activeTab}.dataset.tabId`)
  const fixture = path.join(process.env.E2E_PROFILE, 'retry-fixture')
  fs.mkdirSync(fixture)
  const target = path.join(fixture, 'target.txt')
  fs.mkdirSync(target)
  const download = async (file) => js(`window.electronAPI.sftpQueueDownload(${JSON.stringify(sessionId)}, '/var/old.txt', ${JSON.stringify(file)})`)
  const failed = await download(target)
  await download(path.join(fixture, 'ok.txt'))
  check('one failed and one successful transfer are visible', await until(
    `!!${selector('.transfer-item.error')} && !!${selector('.transfer-item.completed')}`
  ))
  await clickElement('.transfer-clear-btn[title="완료된 항목 삭제"]')
  check('clearing completed transfers keeps the error', await until(`!!${selector('.transfer-item.error')} && !${selector('.transfer-item.completed')}`))

  fs.rmdirSync(target)
  fs.writeFileSync(target, 'keep until confirmed')
  await clickElement('.transfer-item.error button[title="다시 시도"]')
  check('retry asks before overwriting a destination file', await until(`!!${selector('.confirm-dialog')}`))
  await clickElement('.confirm-dialog .btn-secondary')
  await until(`!${selector('.confirm-dialog')}`)
  check('cancelling leaves the failed row and existing file intact', await js(`!!${selector('.transfer-item.error')}`) && fs.readFileSync(target, 'utf8') === 'keep until confirmed')
  await clickElement('.transfer-item.error button[title="다시 시도"]')
  await until(`!!${selector('.confirm-dialog .btn-danger')}`)
  await clickElement('.confirm-dialog .btn-danger')
  check('confirmed retry completes the same transfer', await until(`window.electronAPI.sftpGetQueue(${JSON.stringify(sessionId)})
    .then(({ queue }) => queue.some(transfer => transfer.id === ${JSON.stringify(failed.transferId)} && transfer.status === 'completed'))`))
  check('the retried download contains the source data', fs.readFileSync(target, 'utf8') === 'old\n')

  // Enter in the sidebar search connects to the current match
  const tabCount = await js(`document.querySelectorAll('.terminal-tab').length`)
  await js(`${selector(search)}.focus()`)
  await setInput(search, 'staging')
  await until(`${current} === 'server-staging'`)
  await enter()
  check('Enter in the search box opens the current match', await until(
    `document.querySelectorAll('.terminal-tab').length === ${tabCount + 1} && ${selector('[data-session-id="server-staging"]')}?.classList.contains('active')`, 15000))

  const savedFile = path.join(process.env.E2E_PROFILE, 'restore-tabs.json')
  void clickElement('.title-bar-close').catch(() => {})
  for (let i = 0; i < 50 && !fs.existsSync(savedFile); i++) await sleep(100)
  const envelope = JSON.parse(fs.readFileSync(savedFile, 'utf8'))
  const snapshot = JSON.parse(decrypt(envelope.data, 'test-pass-1234'))
  check('a normal close saves the renamed tab and SFTP location', envelope.source === 'close'
    && snapshot.tabs.some(tab => tab.savedSessionId === 'server-production' && tab.title === 'Deployment' && tab.sftpPath === '/var'))
  finish()
})().catch((error) => { console.error(error); process.exit(1) })
