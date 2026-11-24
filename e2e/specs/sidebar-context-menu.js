const { createChecks, connect, selectThemeTab, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const folderName = 'Sidebar folder'
const menu = '.session-context-menu'
const modal = '.modal-content:has(.folder-picker-trigger)'
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`

;(async () => {
  const driver = await connect()
  const { js, until, center, click, move, send, type, enter } = driver
  await unlock(driver)

  const press = async key => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  }
  const escape = () => press({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  const menuItem = label => `[...document.querySelectorAll('${menu} .context-menu-item')].find(item => item.textContent.trim() === ${JSON.stringify(label)})`
  const rightClickBackground = async (selector) => {
    const point = await js(`(() => {
      const rect = ${q(selector)}.getBoundingClientRect()
      return [rect.left + 12, Math.floor(rect.bottom) - 8]
    })()`)
    await click(...point, 'right')
    check('the list background offers folder and session creation', await until(`
      Array.from(document.querySelectorAll('${menu} .context-menu-item'), item => item.textContent.trim()).join(',') === '폴더 추가,세션 추가'
    `, 3000))
    check('both actions fit inside the window', await js(`(() => {
      const rect = ${q(menu)}?.getBoundingClientRect()
      return !!rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
    })()`))
  }

  const choose = async (label) => {
    const point = await center(menuItem(label))
    if (!point) throw new Error('No sidebar menu item: ' + label)
    await click(...point)
  }

  const folderIsSelected = (label) => until(`${q(`${modal} .folder-picker-label`)}?.textContent === ${JSON.stringify(label)}`)
  const cancel = async () => {
    await js(`${q(`${modal} .modal-close-btn`)}.click()`)
    if (!(await until(`!${q(modal)}`))) throw new Error('The connection dialog did not close')
  }

  await rightClickBackground('.session-list-empty')
  await choose('세션 추가')
  check('the empty list opens a new session at the top level', await folderIsSelected('폴더 없음 (최상위)'))
  await cancel()

  await rightClickBackground('.session-list-empty')
  await choose('폴더 추가')
  check('folder creation focuses the name field', await until(`document.activeElement === ${q('.sidebar .folder-input')}`))
  await type(folderName)
  await enter()
  const folderRow = `.session-list > .session-folder > .folder-header[aria-label="폴더: ${folderName}"]`
  check('the new folder appears at the top level', await until(`!!${q(folderRow)}`))
  check('the folder is saved without a parent', await until(`window.electronAPI.loadFolders().then(r => r.folders?.some(f => f.name === ${JSON.stringify(folderName)} && !f.parentId))`))

  await click(...await center(q(folderRow)), 'right')
  check('a folder row still offers to add a subfolder', await until(`${q(menu)}?.textContent.includes('하위 폴더 추가')`))
  await choose('세션 추가')
  check('adding a session from a folder selects that folder', await folderIsSelected(folderName))
  await cancel()

  await rightClickBackground('.session-list')
  await choose('세션 추가')
  check('blank space below the folder opens a session at the top level', await folderIsSelected('폴더 없음 (최상위)'))
  await cancel()

  await rightClickBackground('.session-list')
  await escape()
  check('Escape dismisses the sidebar menu', await until(`!${q(menu)}`))

  const saved = await js(`window.electronAPI.saveSessions([{
    id: 'glass-session', name: 'Glass session', host: 'example.test', port: 22, username: 'tester', authType: 'password', password: 'x'
  }])`)
  if (!saved?.success) throw new Error('The fixture session did not save')
  await send('Page.reload')
  await sleep(1000)
  await unlock(driver)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] })
  await press({ key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: process.platform === 'darwin' ? 4 : 2 })
  await selectThemeTab(driver, '창 효과')
  await js(`[...document.querySelectorAll('.appearance-segment button')].find(button => button.textContent.trim() === 'Glass').click()`)
  if (!await until(`document.documentElement.dataset.surface === 'glass'`)) throw new Error('Glass mode did not apply')
  await escape()
  await until(`!${q('.settings-modal')}`)
  await click(...await center(q('.sidebar-toggle')))
  await until(`!!${q('.sidebar.rail:not(.peek-open)')}`)
  await move(...await center(q('[data-peek-target="sessions"]')))
  if (!await until(`(() => {
    const panel = ${q('.sidebar.rail.peek-open .sidebar-panel')}
    return panel && getComputedStyle(panel).backdropFilter !== 'none' && !panel.getAnimations().some(a => a.playState === 'running')
  })()`)) throw new Error('The folded Glass sidebar did not open')

  const rightClickRowEdge = async selector => {
    const point = await js(`(() => {
      const row = ${q(selector)}.getBoundingClientRect()
      return [row.right - 12, row.top + row.height / 2]
    })()`)
    await click(...point, 'right')
  }
  const clickableBeyondSidebar = selector => until(`(() => {
    const element = ${selector}
    if (!element) return false
    const item = element.getBoundingClientRect()
    const panel = ${q('.sidebar-panel')}.getBoundingClientRect()
    const x = item.right - 7, y = item.top + item.height / 2
    return x > panel.right && element.contains(document.elementFromPoint(x, y))
  })()`, 3000)

  await rightClickRowEdge(folderRow)
  check('a Glass folder menu can be clicked beyond the sidebar width', await clickableBeyondSidebar(menuItem('색상 변경')))
  await choose('색상 변경')
  const colorPicker = '.context-menu:has(.color-selector)'
  check('the color picker is centered in the window when opened from the Glass menu', await until(`(() => {
    const picker = ${q(colorPicker)}
    if (!picker) return false
    const { left, top, width, height } = picker.getBoundingClientRect()
    return Math.abs(left + width / 2 - innerWidth / 2) < 2 && Math.abs(top + height / 2 - innerHeight / 2) < 2
      && picker.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2))
  })()`))
  await click(...await center(q(`${colorPicker} .context-menu-item`)))

  const sessionRow = '.session-item[data-session-id="glass-session"]'
  await move(...await center(q('[data-peek-target="sessions"]')))
  await until(`!!${q('.sidebar.rail.peek-open')} && !${q('.sidebar-panel')}.getAnimations().some(a => a.playState === 'running')`)
  await rightClickRowEdge(sessionRow)
  check('the entire Glass session menu can be clicked outside the folded sidebar', await clickableBeyondSidebar(menuItem('삭제')))
  const folderTrigger = await center(menuItem('폴더로 이동'))
  await move(...folderTrigger)
  const folderChoice = `[...document.querySelectorAll('.folder-move-panel .folder-tree-item')].find(item => item.textContent.trim() === ${JSON.stringify(folderName)})`
  check('the move-to-folder submenu is shown and interactive to the side of the Glass session menu', await clickableBeyondSidebar(folderChoice))
  const folderPoint = await center(folderChoice)
  await move(folderPoint[0], folderTrigger[1])
  await click(...folderPoint)
  const confirmMove = `[...document.querySelectorAll('.confirm-dialog button')].find(button => button.textContent.trim() === '이동')`
  if (!await until(`!!${confirmMove}`, 5000)) throw new Error('The folder choice did not open the move confirmation')
  await click(...await center(confirmMove))
  check('picking the folder from the Glass submenu moves the selected session', await until(`
    !${q(menu)} && window.electronAPI.loadSessions().then(result => result.sessions?.some(session =>
      session.id === 'glass-session' && session.folderId === ${q(folderRow)}.dataset.folderId
    ))
  `))
  driver.close()
  finish()
})().catch((error) => { console.error(error); process.exit(1) })
