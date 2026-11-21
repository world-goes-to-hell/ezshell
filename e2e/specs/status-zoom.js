const { connect, createChecks, unlock } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { center, click, js, move, send, until } = driver
  const query = selector => `document.querySelector(${JSON.stringify(selector)})`
  const trigger = label => query(`.status-range-trigger[aria-label^="${label} "]`)
  const panel = label => query(`.status-range-panel[aria-label="${label}"]`)
  const zoom = trigger('UI 배율')
  const zoomPanel = panel('UI 배율')
  const slider = `${zoomPanel}?.querySelector('input')`
  const opacity = trigger('창 투명도')
  const opacityPanel = panel('창 투명도')
  const factor = value => `Math.abs(window.electronAPI.getAppZoomFactor() - ${value}) < 0.001`
  const key = async (name, code) => {
    const event = { key: name, code: name, windowsVirtualKeyCode: code }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }

  await unlock(driver)
  await click(...await center(zoom))
  check('the 100% status button opens a focused zoom slider', await until(`
    ${zoom}?.getAttribute('aria-expanded') === 'true' && ${slider} === document.activeElement &&
    ${slider}?.getAttribute('aria-valuetext') === '100%'
  `))
  await key('ArrowRight', 39)
  check('the next slider step applies the native 110% zoom', await until(`
    ${factor(1.1)} && ${zoom}?.textContent.trim() === '110%' && !!${zoomPanel} && !${query('.zoom-hud')}
  `))
  await js(`${zoomPanel}.querySelector('button').click()`)
  check('reset restores 100% and leaves the control open', await until(`${factor(1)} && ${zoomPanel}?.querySelector('button').disabled`))

  const [start, end, y] = await js(`(() => {
    const rect = ${slider}.getBoundingClientRect()
    return [rect.x + rect.width / 2, rect.right - 2, rect.y + rect.height / 2]
  })()`)
  await move(start, y)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start, y, button: 'left', buttons: 1, clickCount: 1 })
  for (const part of [0.25, 0.5, 0.75, 1]) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start + (end - start) * part, y, button: 'left', buttons: 1 })
  }
  check('dragging previews the maximum without shifting the control', await until(`
    ${slider}?.getAttribute('aria-valuetext') === '200%' && ${factor(1)}
  `, 3000))
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end, y, button: 'left', buttons: 0, clickCount: 1 })
  check('releasing applies and stores the selected zoom', await until(`
    ${factor(2)} && JSON.parse(localStorage.getItem('ui-store')).state.appZoom === 2
  `, 5000))
  await key('Escape', 27)
  check('Escape closes the panel and returns focus to the indicator', await until(`!${zoomPanel} && ${zoom} === document.activeElement`))

  await send('Page.reload')
  await unlock(driver)
  check('the status bar restores the selected zoom after a reload', await until(`${factor(2)} && ${zoom}?.textContent.trim() === '200%'`))
  await js(`${zoom}.click()`)
  await until(`!!${zoomPanel}`)
  await js(`${zoomPanel}.querySelector('button').click()`)
  await until(factor(1))
  await click(...await center(opacity))
  check('opening opacity closes the zoom control', await until(`!${zoomPanel} && !!${opacityPanel}`))
  await key('ArrowLeft', 37)
  check('opacity still adjusts independently', await until(`${opacity}?.textContent.trim() === '95%' && ${factor(1)}`))
  await js(`${opacityPanel}.querySelector('button').click()`)
  await until(`${opacity}?.textContent.trim() === '100%'`)
  await click(...await center(zoom))
  await click(10, 80)
  check('clicking outside closes the zoom control', await until(`!${zoomPanel}`))
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 300, deltaX: 0, deltaY: -100, modifiers: 2 })
  check('Ctrl+wheel still updates the status and shows the shortcut feedback', await until(`
    ${factor(1.1)} && ${zoom}?.textContent.trim() === '110%' && ${query('.zoom-hud-value')}?.textContent === '110%'
  `, 5000))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
