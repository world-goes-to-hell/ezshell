// Alt-drag merges or splits at the drawn line. Only a drop on the tab strip creates a tab.
const { createChecks, connect, unlock, connectSsh, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, send, until, center, menuPick, type, enter, move, shot } = driver
  const panes = `[...(${PANEL}?.querySelectorAll('.terminal-split-container > .terminal-container[data-pane]') || [])]`
  const pane = id => `${panes}.find(el => el.dataset.pane === ${JSON.stringify(id)})`
  const output = id => `(${pane(id)}?.querySelector('.xterm-rows')?.textContent || '')`
  const tabs = `[...document.querySelectorAll('.terminal-tab')]`
  const rect = id => js(`(() => { const r = ${pane(id)}.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`)
  const split = async (id, label) => {
    const [x, y] = await center(pane(id))
    const count = await js(`${panes}.length`)
    await menuPick(x, y, '분할', label)
    if (!(await until(`${panes}.length === ${count + 1} && ${panes}.every(p => p.textContent.includes('fake shell'))`, 30000))) throw new Error('split shell did not open')
    return js(`${panes}.at(-1).dataset.pane`)
  }
  const command = async (id, text, expected) => {
    await js(`${pane(id)}.querySelector('.xterm-helper-textarea').focus()`)
    await type(text)
    await enter()
    return until(`${output(id)}.includes(${JSON.stringify(expected)})`, 8000)
  }
  const waitForExplorer = async () => {
    const ready = await until(`(() => {
      const drawer = ${PANEL}?.querySelector('.file-explorer-drawer');
      const width = Number(drawer?.querySelector('.file-explorer-resize-handle')?.getAttribute('aria-valuenow'));
      return width > 0 && drawer.style.width === width + 'px' && drawer.getBoundingClientRect().width === width;
    })()`, 8000)
    if (!ready) throw new Error('the file explorer did not reach its final width')
  }
  const tab = async index => {
    await js(`${tabs}[${index}].click()`)
    if (!(await until(`${tabs}[${index}].classList.contains('active') && !!${pane('main')}?.querySelector('.xterm-helper-textarea')`, 8000))) {
      throw new Error('the requested terminal tab did not become active')
    }
    await waitForExplorer()
  }

  await unlock(driver)
  check('SSH connects', await connectSsh(driver))
  // The drawer opens after the shell and changes the pane rectangles while its spring settles.
  await waitForExplorer()
  const bottom = await split('main', '상하 분할')
  const right = await split('main', '좌우 분할')
  const last = await split(bottom, '상하 분할')
  check('the original main is in its home directory', await command('main', 'home', 'tester@fake:~$'))
  check('the right shell has a different current directory', await command(right, 'etc', 'tester@fake:/etc$'))
  await command(bottom, 'BOTTOM-SHELL', 'BOTTOM-SHELL')
  const lower = [await rect(bottom), await rect(last)]
  const before = await rect(right)
  const [x, y] = await center(pane(right))
  const [left, top] = await center(pane('main'))
  const altMouse = (kind, x, y) => send('Input.dispatchMouseEvent', {
    type: kind, x, y, modifiers: 1, button: kind === 'mouseMoved' ? 'none' : 'left',
    buttons: kind === 'mouseReleased' ? 0 : 1, clickCount: kind === 'mouseMoved' ? 0 : 1
  })
  const cancellation = `${PANEL}.querySelector('.pane-gesture-cancel-target.is-active') &&
    ${PANEL}.querySelector('.pane-gesture-cancel-label')?.textContent === '놓으면 취소' &&
    !${PANEL}.querySelector('.pane-merge-preview, .pane-gesture-divider')`
  const gestureCleared = `!${PANEL}.querySelector('.pane-gesture-cancel-target, .pane-merge-trail.is-active, .pane-merge-trail.is-fading')`

  await altMouse('mousePressed', x, y)
  check('the cancellation target stays hidden until a gesture has a preview',
    await js(`!${PANEL}.querySelector('.pane-gesture-cancel-target')`))
  await altMouse('mouseMoved', left, top)
  check('a gesture paints a visible trail and previews only the selected divider', await until(`(() => {
    const canvas = ${PANEL}.querySelector('.pane-merge-trail.is-active');
    if (!canvas || !${PANEL}.querySelector('.pane-merge-preview.is-area')) return false;
    const r = canvas.getBoundingClientRect();
    const px = Math.round((${(x + left) / 2} - r.left) * canvas.width / r.width);
    const py = Math.round((${(y + top) / 2} - r.top) * canvas.height / r.height);
    return canvas.getContext('2d').getImageData(px, py, 1, 1).data[3] > 0;
  })()`, 4000))
  check('a valid merge shows a cancellation circle at its starting point', await until(`(() => {
    const r = ${PANEL}.querySelector('.pane-gesture-cancel-target')?.getBoundingClientRect()
    return r && Math.abs(r.left + r.width / 2 - ${x}) < 2 && Math.abs(r.top + r.height / 2 - ${y}) < 2
  })()`, 4000))
  await altMouse('mouseMoved', x + 7, y - 6)
  check('returning inside the circle clears the merge preview', await until(cancellation, 4000))
  await altMouse('mouseReleased', x + 7, y - 6)
  check('releasing inside the circle keeps every SSH shell and the tab', await until(gestureCleared, 4000)
    && await js(`${tabs}.length === 1 && ${panes}.length === 4`)
    && await command('main', 'shell-count', 'OPEN-SHELLS 4'))
  await altMouse('mousePressed', x, y)
  await altMouse('mouseMoved', left, top)
  await until(`!!${PANEL}.querySelector('.pane-merge-preview.is-area')`, 4000)
  await shot('ssh-pane-merge-preview')
  await altMouse('mouseReleased', left, top)
  check('the gesture trail remains briefly after release', await js(`!!${PANEL}.querySelector('.pane-merge-trail.is-fading')`))
  check('the right shell occupies the merged area inside the same tab', await until(`${tabs}.length === 1 && ${panes}.length === 3 && ${output('main')}.includes('tester@fake:/etc$')`, 10000))
  check('the other two panes keep their positions', JSON.stringify([await rect(bottom), await rect(last)]) === JSON.stringify(lower))
  check('the surviving shell widens', (await rect('main'))[2] > before[2])
  check('the promoted shell still accepts input in its original directory', await command('main', 'PROMOTED-STILL-LIVE', 'PROMOTED-STILL-LIVEtester@fake:/etc$'))
  check('an unrelated shell keeps its output', await js(`${output(bottom)}.includes('BOTTOM-SHELL')`))
  check('the removed main shell channel is closed', await command('main', 'shell-count', 'OPEN-SHELLS 3'))

  // The main pane's regular grip works too, while the other shells stay in the original tab.
  const [px, py, width] = await rect('main')
  await move(px + width / 2, py + 8)
  const accepted = await js(`(() => {
    const grip = ${PANEL}.querySelector('.pane-grip.is-shown');
    if (!grip) return false;
    const dataTransfer = new DataTransfer();
    grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
    const strip = document.querySelector('.terminal-tabs');
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
    strip.dispatchEvent(over);
    strip.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    grip.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    return over.defaultPrevented;
  })()`)
  check('the first shell can still be dragged directly to the tab strip', accepted && await until(`${tabs}.length === 2 && ${output('main')}.includes('PROMOTED-STILL-LIVE')`, 10000))
  await tab(0)
  check('another shell becomes the original tab’s main shell', await until(`${output('main')}.includes('BOTTOM-SHELL')`, 8000))

  // Draw a vertical line in a single shell and a horizontal line in its left pane.
  await tab(1)
  const drawDivider = async (axis, fraction) => {
    const [x, y, w, h] = await rect('main')
    const start = axis === 'row' ? [x + w * fraction, y + h * 0.2] : [x + w * 0.12, y + h * fraction]
    const end = axis === 'row' ? [start[0], y + h * 0.8] : [x + w * 0.86, start[1]]
    const count = await js(`${panes}.length`)
    await altMouse('mousePressed', ...start)
    await altMouse('mouseMoved', ...end)
    check(`the drawn line previews a ${axis === 'row' ? 'side-by-side' : 'stacked'} division`, await until(`!!${PANEL}.querySelector('.pane-gesture-divider.is-${axis}')`, 4000))
    if (axis === 'row') {
      const nearStart = [start[0] + 5, start[1] + 6]
      await altMouse('mouseMoved', ...nearStart)
      check('returning to the start also clears a split preview', await until(cancellation, 4000))
      await altMouse('mouseReleased', ...nearStart)
      check('releasing there leaves the original split layout in place', await until(gestureCleared, 4000)
        && await js(`${panes}.length === ${count}`))
      await altMouse('mousePressed', ...start)
      await altMouse('mouseMoved', ...end)
      await altMouse('mouseMoved', ...nearStart)
      await altMouse('mouseMoved', ...end)
      check('moving out of the circle restores the preview without a new press',
        await until(`!!${PANEL}.querySelector('.pane-gesture-divider.is-row') && !${PANEL}.querySelector('.pane-gesture-cancel-target.is-active')`, 4000))
    }
    await altMouse('mouseReleased', ...end)
    if (!(await until(`${panes}.length === ${count + 1} && ${panes}.every(p => p.textContent.includes('fake shell'))`, 30000))) throw new Error('drawn split did not open')
    const after = await rect('main')
    const actual = axis === 'row' ? after[2] / w : after[3] / h
    check('the division is placed where the line was drawn', Math.abs(actual - fraction) < 0.025, `${actual} / ${fraction}`)
    return js(`${panes}.at(-1).dataset.pane`)
  }
  const tall = await drawDivider('row', 0.6)
  const lowerLeft = await drawDivider('col', 0.42)
  check('the first shell still has its previous output after drawing both divisions', await js(`${output('main')}.includes('PROMOTED-STILL-LIVE')`))
  await command(lowerLeft, 'LOWER-SHELL', 'LOWER-SHELL')
  const upper = await rect('main')
  const oldTall = await rect(tall)
  const lowerStart = await rect(lowerLeft)
  const origin = await center(pane(lowerLeft))
  const intoTall = [oldTall[0] + oldTall[2] / 2, origin[1]]
  await altMouse('mousePressed', ...origin)
  await altMouse('mouseMoved', ...intoTall)
  check('an unequal merge previews just the shared lower strip', await until(`(() => {
    const preview = ${PANEL}.querySelector('.pane-merge-preview.is-area')?.getBoundingClientRect();
    return preview && Math.abs(preview.top - ${lowerStart[1]}) < 4 && preview.width > ${lowerStart[2]};
  })()`, 4000))
  await altMouse('mouseReleased', ...intoTall)
  const vacant = `${PANEL}.querySelector('.pane-vacant')`
  check('the tall pane closes and leaves exactly one empty place, without adding a tab', await until(`${tabs}.length === 2 && ${panes}.length === 2 && !${pane(tall)} && !!${vacant}`, 10000))
  const lowerAfter = await rect(lowerLeft)
  const upperAfter = await rect('main')
  check('only the lower pane widens and the top-left one keeps its rectangle',
    lowerAfter[2] > lowerStart[2] && JSON.stringify(upperAfter) === JSON.stringify(upper),
    JSON.stringify({ upper, upperAfter, lowerStart, lowerAfter }))
  check('the top-right vacancy has the old pane merge buttons', await js(`(() => {
    const el = ${vacant};
    const rect = el.getBoundingClientRect();
    return Math.abs(rect.left - ${oldTall[0]}) < 4 && Math.abs(rect.top - ${oldTall[1]}) < 4 &&
      [...el.querySelectorAll('button')].map(b => b.textContent.trim()).join(',') === '가로로 병합,세로로 병합';
  })()`))
  await shot('ssh-pane-merge-unequal')
  check('the lower shell survives and the server closed the tall shell channel', await command(lowerLeft, 'shell-count', 'OPEN-SHELLS 4') && await js(`${output(lowerLeft)}.includes('LOWER-SHELL')`))
  await js(`${vacant}.querySelector('button').click()`)
  check('the horizontal merge button can fill the empty place', await until(`!${vacant}`, 4000))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
