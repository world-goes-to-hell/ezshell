// With more than ten local terminals, a window reload still restores a split tab on the same shells.
const { connect, createChecks, unlock, sleep } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, send, menuPick } = driver
  const tabs = `[...document.querySelectorAll('.terminal-tab')]`
  const panes = `[...document.querySelectorAll('.local-terminal-tab')].filter(t => getComputedStyle(t).visibility !== 'hidden').flatMap(t => [...t.querySelectorAll(':scope > .local-terminal-pane')])`
  const ready = count => until(`${panes}.length === ${count} && ${panes}.every(el => /PS [A-Z]:/.test(el.textContent))`, 90000)

  await unlock(driver)
  for (let count = 1; count <= 11; count++) {
    await js(`document.querySelector('.local-terms-btn[aria-label="새 로컬 터미널"]').click()`)
    if (!(await until(`${tabs}.length === ${count}`))) throw new Error(`The local tab at position ${count} did not open`)
  }
  check('the eleventh local terminal opens', await ready(1))
  const box = await js(`(() => { const r = ${panes}[0].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  await menuPick(box[0], box[1], '분할', '좌우 분할')
  check('the tab splits into two panes', await ready(2))
  const shells = await js(`window.electronAPI.localShellList().then(list => list.map(s => s.id).sort())`)
  check('main runs one shell per pane and one per unsplit tab', shells.length === 12, JSON.stringify(shells))
  const activeId = await js(`document.querySelector('.terminal-tab.active').dataset.tabId`)
  const lastTab = `${tabs}.find(tab => tab.dataset.tabId === ${JSON.stringify(activeId)})`
  const title = await js(`${lastTab}.textContent`)

  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('after the reload all eleven tabs return', await until(`${tabs}.length === 11`),
    String(await js(`${tabs}.map(t => t.textContent).join(' | ')`)))
  await js(`${lastTab}.click()`)
  check('the eleventh tab still has both panes', await ready(2), String(await js(`${panes}.length`)))
  check('on the same shells, not new ones', JSON.stringify(await js(`window.electronAPI.localShellList().then(list => list.map(s => s.id).sort())`)) === JSON.stringify(shells))
  check('the tab keeps its name', (await js(`${lastTab}?.textContent`)) === title, String(await js(`${lastTab}?.textContent`)))

  finish()
})().catch(error => { console.error(error); process.exit(1) })
