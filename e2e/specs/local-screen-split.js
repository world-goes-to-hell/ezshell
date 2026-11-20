// The screen split grows to four screens (docs/plan/2026-11-19-screen-split-up-to-four.md): tabs dragged
// to the right edge make a second, third and fourth screen; a fifth is refused with the reason; a divider
// changes only its two neighbours, a double click evens them; closing a screen's last tab removes it.
const { connect, createChecks, unlock, sleep } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, until, send, center } = driver
  try {
    await unlock(driver)
    const stripTabs = `[...document.querySelectorAll('.terminal-tabs .terminal-tab')]`
    const screens = `[...document.querySelectorAll('.split-pane[data-screen]')]`
    // The sidebar's button, as local-split does (the welcome screen's button plays a flight first)
    const openLocal = () => js(`document.querySelector('.local-terms-btn[aria-label="새 로컬 터미널"]').click()`)
    for (let count = 1; count <= 5; count++) {
      await openLocal()
      await until(`${stripTabs}.length === ${count}`, 15000)
      await sleep(400)
    }
    check('five local terminal tabs are open', await js(`${stripTabs}.length === 5`))

    // CDP pointer input does not start an HTML5 drag: the events are sent directly
    const startDrag = async (tabSelector) => {
      await js(`(() => {
        const tab = ${tabSelector}
        window.__dt = new DataTransfer()
        window.__dragged = tab
        tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
      })()`)
      await sleep(200)
    }
    const finishDrag = async ([x, y]) => {
      await js(`(() => {
        const target = document.elementFromPoint(${x}, ${y}) || document.body
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: ${x}, clientY: ${y} }))
        window.__dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
      })()`)
      await sleep(500)
    }
    const dragToRightEdge = async (tabSelector) => {
      await startDrag(tabSelector)
      const at = await js(`(() => { const r = document.querySelector('.terminal-area').getBoundingClientRect(); return [r.right - 15, r.top + r.height / 2] })()`)
      for (const x of [at[0] - 200, at[0]]) {
        await js(`(() => {
          const target = document.elementFromPoint(${x}, ${at[1]}) || document.body
          target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: ${x}, clientY: ${at[1]} }))
        })()`)
        await sleep(250)
      }
      const zoneShown = await js(`!!document.querySelector('.drop-zone-right.active')`)
      await finishDrag(at)
      return zoneShown
    }
    const screenTab = (screen) => `document.querySelector('.split-pane[data-screen="${screen}"] .split-pane-tab-item:last-of-type')`
    const screenTabs = screen => `[...document.querySelectorAll('.split-pane[data-screen="${screen}"] .split-pane-tab-item')]`
    const tabIds = screen => js(`${screenTabs(screen)}.map(tab => tab.dataset.tabId)`)
    const dropBefore = async (from, target) => {
      await startDrag(from)
      const point = await js(`(() => { const r = ${target}.getBoundingClientRect(); return [r.left + r.width * .2, r.top + r.height / 2] })()`)
      await js(`(() => {
        const [x, y] = ${JSON.stringify(point)}
        document.elementFromPoint(x, y).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: x, clientY: y }))
      })()`)
      const marked = await until(`!!document.querySelector('.tab-order-marker') && !document.querySelector('.tab-merge-marker')`, 3000)
      await finishDrag(point)
      return marked
    }
    const widths = () => js(`${screens}.map(s => Math.round(s.getBoundingClientRect().width))`)

    check('dragging a tab to the right edge shows the drop zone', await dragToRightEdge(`${stripTabs}[4]`))
    check('it makes two screens', await until(`${screens}.length === 2`, 5000))
    const primaryOrder = await tabIds(0)
    const secondaryOrder = await tabIds(1)
    const moving = primaryOrder.at(-1)
    check('dragging within a split strip changes its order', await dropBefore(screenTab(0), `${screenTabs(0)}[0]`) &&
      (await tabIds(0)).join(',') === [moving, ...primaryOrder.slice(0, -1)].join(','))
    check('dragging to another split strip inserts the tab at the indicated edge',
      await dropBefore(`${screenTabs(0)}[0]`, `${screenTabs(1)}[0]`) &&
      (await tabIds(0)).join(',') === primaryOrder.slice(0, -1).join(',') &&
      (await tabIds(1)).join(',') === [moving, ...secondaryOrder].join(','))
    await dropBefore(`${screenTabs(1)}[0]`, `${screenTabs(0)}[0]`)
    check('from a screen\'s tab strip the right edge makes a third screen', await dragToRightEdge(screenTab(0)) && await until(`${screens}.length === 3`, 5000))
    const three = await widths()
    check('three screens share the width evenly', Math.max(...three) - Math.min(...three) <= 3, JSON.stringify(three))
    await dragToRightEdge(screenTab(0))
    check('and a fourth', await until(`${screens}.length === 4`, 5000))
    const shownAtFour = await dragToRightEdge(screenTab(0))
    check('a fifth is refused with the reason, no drop zone, still four screens',
      !shownAtFour && await until(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('4개까지'))`, 5000) && await js(`${screens}.length === 4`))

    // The first divider: only the first two screens change
    const before = await widths()
    const divider = await center(`document.querySelector('.split-divider[data-divider="0"]')`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: divider[0], y: divider[1], button: 'left', buttons: 1, clickCount: 1 })
    for (const step of [30, 60, 90]) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: divider[0] + step, y: divider[1], buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: divider[0] + 90, y: divider[1], button: 'left', clickCount: 1 })
    await sleep(400)
    const after = await widths()
    check('dragging a divider changes only its two neighbours', after[0] > before[0] + 60 && after[1] < before[1] - 60 && Math.abs(after[2] - before[2]) <= 2 && Math.abs(after[3] - before[3]) <= 2, JSON.stringify({ before, after }))
    await js(`document.querySelector('.split-divider[data-divider="0"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    await sleep(400)
    const even = await widths()
    check('a double click evens every screen', Math.max(...even) - Math.min(...even) <= 3, JSON.stringify(even))

    // Closing the only tab of the last screen removes that screen
    await js(`document.querySelector('.split-pane[data-screen="3"] .split-pane-tab-item .split-pane-tab-close, .split-pane[data-screen="3"] [aria-label*="닫기"]')?.click()`)
    check('closing a screen\'s last tab leaves three screens', await until(`${screens}.length === 3`, 8000), String(await js(`${screens}.length`)))
    await driver.shot('local-screen-split')
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
