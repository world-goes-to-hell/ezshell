const { createChecks, connect, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const folderName = 'Sidebar folder'
const menu = '.sidebar-lists .context-menu'
const modal = '.modal-content:has(.folder-picker-trigger)'
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`

;(async () => {
  const driver = await connect()
  const { js, until, center, click, send, type, enter } = driver
  await unlock(driver)

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
    const item = `[...document.querySelectorAll('${menu} .context-menu-item')].find(item => item.textContent.trim() === ${JSON.stringify(label)})`
    const point = await center(item)
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
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  check('Escape dismisses the sidebar menu', await until(`!${q(menu)}`))
  driver.close()
  finish()
})().catch((error) => { console.error(error); process.exit(1) })
