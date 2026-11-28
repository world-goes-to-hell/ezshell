// Closing a tab with the wheel button (lib/middleClickClose.ts): in the tab strip and in a screen's strip after a
// split, a middle click closes the tab under it; a left click only selects it. Closing the tab in front shows the
// tab seen just before it (lib/tabRecency.ts).
const { connect, createChecks, pageProblems, unlock, sleep } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, center, click } = driver
  try {
    await unlock(driver)
    const stripTabs = `[...document.querySelectorAll('.terminal-tabs .terminal-tab')]`
    const openLocal = () => js(`document.querySelector('.local-terms-btn[aria-label="새 로컬 터미널"]').click()`)
    for (let count = 1; count <= 5; count++) {
      await openLocal()
      await until(`${stripTabs}.length === ${count}`, 15000)
      await sleep(400)
    }
    const ids = () => js(`${stripTabs}.map(tab => tab.dataset.tabId)`)
    const before = await ids()

    await click(...await center(`${stripTabs}[1]`))
    check('a left click selects the tab and keeps it', await until(`${stripTabs}.length === 5 && ${stripTabs}[1].classList.contains('active')`, 3000))

    await click(...await center(`${stripTabs}[0]`), 'middle')
    check('a middle click closes the tab under the pointer', await until(`(() => {
      const left = ${stripTabs}.map(tab => tab.dataset.tabId)
      return left.length === 4 && !left.includes(${JSON.stringify(before[0])})
    })()`, 5000), JSON.stringify(await ids()))
    check('the selected tab stays selected', await js(`document.querySelector('.terminal-tabs .terminal-tab.active')?.dataset.tabId === ${JSON.stringify(before[1])}`))

    // Seen: before[1], then the last tab; closing the last tab goes back to before[1], not to its neighbour
    await click(...await center(`${stripTabs}[3]`))
    await until(`${stripTabs}[3].classList.contains('active')`, 3000)
    await click(...await center(`document.querySelector('.terminal-tabs .terminal-tab.active .tab-close')`))
    check('closing the tab in front shows the tab seen just before it', await until(`${stripTabs}.length === 3 &&
      document.querySelector('.terminal-tabs .terminal-tab.active')?.dataset.tabId === ${JSON.stringify(before[1])}`, 5000),
      await js(`document.querySelector('.terminal-tabs .terminal-tab.active')?.dataset.tabId`))

    // Split: a tab dragged to the right edge makes a second screen with its own strip (as local-screen-split)
    await js(`(() => {
      const tab = ${stripTabs}[2]
      window.__dt = new DataTransfer()
      window.__dragged = tab
      tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
    })()`)
    await sleep(200)
    const at = await js(`(() => { const r = document.querySelector('.terminal-area').getBoundingClientRect(); return [r.right - 15, r.top + r.height / 2] })()`)
    for (const x of [at[0] - 200, at[0]]) {
      await js(`document.elementFromPoint(${x}, ${at[1]}).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: ${x}, clientY: ${at[1]} }))`)
      await sleep(250)
    }
    await js(`(() => {
      document.elementFromPoint(${at[0]}, ${at[1]}).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: ${at[0]}, clientY: ${at[1]} }))
      window.__dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
    })()`)
    const screenTabs = `[...document.querySelectorAll('.split-pane-tab-item')]`
    if (!await until(`document.querySelectorAll('.split-pane[data-screen]').length === 2 && ${screenTabs}.length === 3`, 5000)) throw new Error('the screen did not split')
    const target = await js(`${screenTabs}[0].dataset.tabId`)
    await click(...await center(`${screenTabs}[0]`), 'middle')
    check('a middle click closes a tab in a screen’s strip', await until(`${screenTabs}.length === 2 && !${screenTabs}.some(tab => tab.dataset.tabId === ${JSON.stringify(target)})`, 5000),
      JSON.stringify(await js(`${screenTabs}.map(tab => tab.dataset.tabId)`)))

    const problems = await pageProblems(driver)
    check('no page errors', !problems.length, JSON.stringify(problems))
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
