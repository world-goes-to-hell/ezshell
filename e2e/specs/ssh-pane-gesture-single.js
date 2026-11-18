// Alt+drag on a tab that still has one shell, with the file explorer open beside it: the trail and the
// preview must cover the terminal area only. The split container was not a positioned box until the
// tab was split, so these overlays took a box further out that also holds the explorer and the header.
// Run by e2e/run.js with the test server.
const { sleep, createChecks, connect, unlock, connectSsh, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, send, until, shot } = driver
  const box = (expr) => js(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })()`)
  const CONTAINER = `${PANEL}?.querySelector('.terminal-split-container')`
  const altMouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, modifiers: 1, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 })

  await unlock(driver)
  check('an SSH tab connects to the test server', await connectSsh(driver))
  // The tab opens its file explorer by itself half a second after connecting (TerminalPanel)
  check('the file explorer is open beside the terminal', await until(`!!${PANEL}?.querySelector('.file-explorer-drawer')`, 8000))
  await sleep(900)

  const area = await box(CONTAINER)
  const explorer = await box(`${PANEL}.querySelector('.file-explorer-drawer')`)
  check('the terminal area starts right of the explorer', !!area && !!explorer && area[0] >= explorer[0] + explorer[2] - 1, `${JSON.stringify(area)} ${JSON.stringify(explorer)}`)

  // Alt+drag inside the one shell: press, move a little, look, then Escape
  await send('Page.bringToFront')
  const x = area[0] + Math.round(area[2] / 2)
  const y = area[1] + Math.round(area[3] / 2)
  await altMouse('mousePressed', x, y)
  for (let i = 1; i <= 6; i++) { await altMouse('mouseMoved', x + i * 15, y + i * 4); await sleep(30) }
  check('the drag is taken as a pane gesture', await until(`!!${PANEL}?.querySelector('.pane-merge-trail.is-active')`, 3000))
  const trail = await box(`${PANEL}.querySelector('.pane-merge-trail')`)
  const source = await box(`${PANEL}.querySelector('.pane-merge-preview.is-source')`)
  check('the trail covers the terminal area, not the explorer', JSON.stringify(trail) === JSON.stringify(area), `trail ${JSON.stringify(trail)} area ${JSON.stringify(area)}`)
  const inside = (r) => !!r && r[0] >= area[0] - 1 && r[1] >= area[1] - 1 && r[0] + r[2] <= area[0] + area[2] + 1 && r[1] + r[3] <= area[1] + area[3] + 1
  check('the outline of the shell is drawn on the shell', inside(source), `source ${JSON.stringify(source)} area ${JSON.stringify(area)}`)
  // The drawn line is where the pointer is: its pixels are inside the terminal area at the pointer
  const drawn = await js(`(() => {
    const canvas = ${PANEL}.querySelector('.pane-merge-trail')
    const r = canvas.getBoundingClientRect()
    const scale = canvas.width / r.width
    const data = canvas.getContext('2d').getImageData(Math.round((${x + 45} - r.left) * scale) - 3, Math.round((${y + 12} - r.top) * scale) - 3, 7, 7).data
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
    return false
  })()`)
  check('the trail is drawn under the pointer', drawn)
  await shot('ssh-pane-gesture-single-1-drag')
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await altMouse('mouseReleased', x + 90, y + 24)
  check('Escape cancels without splitting', await until(`!${PANEL}?.querySelector('.pane-merge-trail.is-active') && ${PANEL}.querySelectorAll('.terminal-split-container > .terminal-container[data-pane]').length === 1`, 3000))

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
