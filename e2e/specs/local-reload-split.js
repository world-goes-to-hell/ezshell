// A window reload with a split local tab: the tab comes back as one tab with its panes, each pane on its
// own running shell (not one tab per shell). Reported 2026-11-20: split shells came back as tabs.
const { connect, createChecks, unlock, sleep } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, send, menuPick } = driver
  const tabs = `[...document.querySelectorAll('.terminal-tab')]`
  const panes = `[...document.querySelectorAll('.local-terminal-tab')].filter(t => getComputedStyle(t).visibility !== 'hidden').flatMap(t => [...t.querySelectorAll(':scope > .local-terminal-pane')])`
  const ready = count => until(`${panes}.length === ${count} && ${panes}.every(el => /PS [A-Z]:/.test(el.textContent))`, 90000)

  await unlock(driver)
  await js(`document.querySelector('.local-terms-btn[aria-label="새 로컬 터미널"]').click()`)
  check('a local terminal tab opens', await ready(1))
  const box = await js(`(() => { const r = ${panes}[0].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  await menuPick(box[0], box[1], '분할', '좌우 분할')
  check('the tab splits into two panes', await ready(2))
  const shells = await js(`window.electronAPI.localShellList().then(list => list.map(s => s.id).sort())`)
  check('main runs one shell per pane', shells.length === 2, JSON.stringify(shells))
  const title = await js(`${tabs}[0].textContent`)

  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('after the reload the split tab comes back as one tab', await until(`${tabs}.length >= 1`, 10000) && (await sleep(1500), (await js(`${tabs}.length`)) === 1),
    String(await js(`${tabs}.map(t => t.textContent).join(' | ')`)))
  check('with both panes', await ready(2), String(await js(`${panes}.length`)))
  check('on the same shells, not new ones', JSON.stringify(await js(`window.electronAPI.localShellList().then(list => list.map(s => s.id).sort())`)) === JSON.stringify(shells))
  check('the tab keeps its name', (await js(`${tabs}[0]?.textContent`)) === title, String(await js(`${tabs}[0]?.textContent`)))

  finish()
})().catch(error => { console.error(error); process.exit(1) })
