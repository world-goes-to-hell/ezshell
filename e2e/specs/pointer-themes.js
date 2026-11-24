// 설정 > 테마 > 포인터 모양 / 효과: choosing a pointer set puts blob: images in the :root cursor variables
// (no CSP refusal), every rewritten `cursor` rule follows them (app buttons, xterm's own rules), the
// size changes the image and its hotspot, and an effect brings the overlay canvas that goes away
// again when both effects are off. Run by e2e/run.js (fresh profile, no server needed).
const { sleep, createChecks, connect, selectThemeTab, unlock, pageProblems } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { send, js, until, shot, click, center, move } = driver
  // Effects run only while the window has the focus; the test window usually does not
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await unlock(driver)

  const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 }
  await js(`document.activeElement && document.activeElement.blur()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma })
  await selectThemeTab(driver, '포인터 모양')

  const rootVar = name => js(`document.documentElement.style.getPropertyValue('${name}')`)
  const card = selector => `document.querySelector('.pointer-settings ${selector}')`
  const pick = async selector => {
    await js(`${card(selector)}.scrollIntoView({ block: 'center' })`)
    await sleep(150)
    const at = await center(card(selector))
    await click(at[0], at[1])
    await sleep(200)
  }

  check('the system pointer is the default: no set and no cursor variables',
    await js(`!document.documentElement.dataset.cursorSet && !document.documentElement.style.getPropertyValue('--ez-cursor-default')`))
  check('no effect canvas while both effects are off', await js(`!document.querySelector('.pointer-effects-canvas')`))
  check('the shape tab shows all nine pointer sets in one grid without category badges', await js(`
    document.querySelectorAll('.pointer-settings [aria-label="포인터 모양"] [data-set]').length === 9 &&
    !/귀염|실용/.test(document.querySelector('.pointer-settings').textContent) &&
    !document.querySelector('.pointer-settings [data-effect]')
  `))
  const previews = `[...document.querySelectorAll('.pointer-settings [data-set] img')]`
  await js(`Promise.all(${previews}.map(img => img.decode().catch(() => null)))`)
  check('each set card previews three pointers from blob: images', await until(`
    ${previews}.length === 27 && ${previews}.every(img => img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0)
  `, 4000), await js(`${previews}.filter(img => !(img.complete && img.naturalWidth > 0)).map(img => img.closest('[data-set]').dataset.set + ':' + img.naturalWidth).slice(0, 6).join(' ')`))

  await pick('[data-set="paw"]')
  check('choosing a set marks it and sets the root', await until(`document.documentElement.dataset.cursorSet === 'paw' && ${card('[data-set="paw"]')}.getAttribute('aria-checked') === 'true'`))
  const states = ['default', 'pointer', 'text', 'wait', 'progress', 'not-allowed', 'grab', 'grabbing', 'col-resize', 'row-resize', 'crosshair']
  const values = await js(`(${JSON.stringify(states)}).map(state => document.documentElement.style.getPropertyValue('--ez-cursor-' + state))`)
  check('all eleven cursor variables are blob: images with the OS pointer as fallback',
    values.every((value, i) => /^url\("blob:[^"]+"\) \d+ \d+, /.test(value) && value.endsWith(', ' + states[i])), values[0])

  // The build rewrote the app's and xterm's `cursor` rules to read the variables
  const computed = await js(`(() => {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-500px;top:0'
    host.innerHTML = '<div class="xterm" id="pt-x"><div class="xterm-screen" id="pt-s"></div></div><div class="xterm enable-mouse-events" id="pt-m"></div><div class="xterm"><span class="xterm-cursor-pointer" id="pt-l"></span></div><input type="text" id="pt-i">'
    document.body.appendChild(host)
    const of = id => getComputedStyle(document.getElementById(id)).cursor
    const result = { xterm: of('pt-x'), screen: of('pt-s'), mouse: of('pt-m'), link: of('pt-l'), input: of('pt-i'),
      button: getComputedStyle(document.querySelector('.pointer-settings .pointer-card')).cursor,
      body: getComputedStyle(document.body).cursor }
    host.remove()
    return result
  })()`)
  const usesImage = (value, keyword) => typeof value === 'string' && value.includes('blob:') && value.trim().endsWith(keyword)
  check('a terminal shows the set\'s text pointer', usesImage(computed.xterm, 'text') && usesImage(computed.screen, 'text'), computed.xterm)
  check('a terminal in mouse-report mode shows the set\'s arrow', usesImage(computed.mouse, 'default'), computed.mouse)
  check('a link under the terminal pointer shows the set\'s hand', usesImage(computed.link, 'pointer'), computed.link)
  check('app buttons and text fields follow the set', usesImage(computed.button, 'pointer') && usesImage(computed.input, 'text'), JSON.stringify(computed.button))
  check('everything else inherits the set\'s arrow', usesImage(computed.body, 'default'), computed.body)

  const pickSize = label => js(`[...document.querySelectorAll('.pointer-settings [aria-label="포인터 크기"] button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  await pickSize('아주 크게')
  await sleep(200)
  const big = await rootVar('--ez-cursor-default')
  // Read through an image (the page's CSP refuses fetch of blob: URLs, which is fine: only images use them)
  const bigWidth = await js(`(() => { const img = new Image(); img.src = ${JSON.stringify(big.match(/blob:[^"]+/)?.[0] ?? '')}; return img.decode().then(() => img.naturalWidth, () => 0) })()`)
  check('the largest size draws a 64px image and scales the hotspot to the arrow tip', / 3 3, default$/.test(big) && bigWidth === 64, `${big} (${bigWidth}px)`)
  await shot('pointer-settings-sets')

  // Effects
  await selectThemeTab(driver, '포인터 효과')
  check('the effects tab shows all moving and press effects without category badges', await js(`
    !document.querySelector('.pointer-settings [data-set]') &&
    !/귀염|실용/.test(document.querySelector('.pointer-settings').textContent) &&
    document.querySelectorAll('.pointer-settings [aria-label="움직일 때 효과"] [data-effect]').length === 10 &&
    document.querySelectorAll('.pointer-settings [aria-label="누를 때 효과"] [data-effect]').length === 9
  `))
  check('the overlay is still absent before an effect is chosen', await js(`!document.querySelector('.pointer-effects-canvas')`))
  await pick('[aria-label="움직일 때 효과"] [data-effect="sparkle"]')
  check('a moving effect brings one overlay canvas that does not take the pointer', await until(`(() => {
    const canvases = document.querySelectorAll('.pointer-effects-canvas')
    return canvases.length === 1 && getComputedStyle(canvases[0]).pointerEvents === 'none'
  })()`, 3000))
  // Sweep over the settings (not a terminal) and look for drawn pixels
  await js(`window.__moves = 0; addEventListener('pointermove', () => window.__moves++, true)`)
  await js(`${card('[aria-label="움직일 때 효과"]')}.scrollIntoView({ block: 'center' })`)
  await sleep(200)
  const area = await center(card('[aria-label="움직일 때 효과"]'))
  for (let i = 0; i < 6; i++) await move(area[0] - 220 + i * 70, area[1] - 40 + (i % 2) * 50)
  // The canvas holds no pixels (0×0) while nothing is drawn
  const drawn = `(() => {
    const canvas = document.querySelector('.pointer-effects-canvas')
    if (!canvas || !canvas.width || !canvas.height) return false
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 3; i < data.length; i += 4 * 7) if (data[i] > 0) return true
    return false
  })()`
  check('moving the pointer draws particles on the overlay', await until(drawn, 3000), await js(`JSON.stringify({ focus: document.hasFocus(), hidden: document.hidden, w: document.querySelector('.pointer-effects-canvas')?.width, moves: window.__moves, at: ${JSON.stringify(area)} })`))
  await shot('pointer-settings-effects')
  check('the canvas gives its pixels back once the particles are gone', await until(`document.querySelector('.pointer-effects-canvas')?.width === 0`, 4000))

  // Over terminals: nothing starts on a bare terminal (moving effects are off there by default), but
  // whatever covers a terminal (a dialog, the chat view) still shows the effect
  const escape = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...escape })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...escape })
  await until(`!document.querySelector('.settings-modal')`, 4000)
  await js(`window.dispatchEvent(new CustomEvent('ezshell:open-local-terminal', { detail: {} }))`)
  const terminalBox = `(() => { const el = [...document.querySelectorAll('.xterm')].find(x => x.checkVisibility({ visibilityProperty: true })); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })()`
  check('a local terminal opens for the terminal checks', await until(`!!${terminalBox} && ${terminalBox}[2] > 300`, 15000))
  const [termLeft, termTop, termWidth, termHeight] = await js(terminalBox)
  const sweep = async (x, y) => { for (let i = 0; i < 6; i++) await move(x - 150 + i * 60, y - 30 + (i % 2) * 60) }
  // Getting there crosses the tab strip and sidebar (effects show there): let those particles end first
  await move(termLeft + termWidth / 2, termTop + termHeight / 2)
  await until(`(document.querySelector('.pointer-effects-canvas')?.width ?? 0) === 0`, 4000)
  await sweep(termLeft + termWidth / 2, termTop + termHeight / 2)
  await sleep(300)
  check('moving over a bare terminal starts nothing', await js(`${drawn} === false && document.querySelector('.pointer-effects-canvas').width === 0`))
  await js(`(() => {
    const cover = document.createElement('div')
    cover.id = 'pt-cover'
    cover.className = 'agent-chat-cover'
    cover.style.cssText = 'position:fixed;left:${termLeft}px;top:${termTop}px;width:${termWidth}px;height:${termHeight}px;z-index:50;background:transparent'
    document.body.appendChild(cover)
  })()`)
  await sweep(termLeft + termWidth / 2, termTop + termHeight / 2)
  check('a cover over the terminal (like the chat view) shows the effect', await until(drawn, 3000))
  await js(`document.getElementById('pt-cover').remove()`)
  await until(`document.querySelector('.pointer-effects-canvas')?.width === 0`, 4000)
  const savedPrefs = await js("localStorage.getItem('pointerPrefs')")
  const applyPrefs = raw => js(`
    localStorage.setItem('pointerPrefs', ${JSON.stringify(raw)})
    dispatchEvent(new StorageEvent('storage', { key: 'pointerPrefs' }))
  `)
  const ghostPrefs = { ...JSON.parse(savedPrefs), move: 'ghost', moveOnTerminal: true }
  await js(`(() => {
    const prototype = CanvasRenderingContext2D.prototype
    const original = prototype.drawImage
    window.ptGhostSamples = []
    prototype.drawImage = function(image, ...args) {
      if (this.canvas.matches('.pointer-effects-canvas')) {
        window.ptGhostSamples.push([image.src, image.naturalWidth, ...args])
      }
      return original.call(this, image, ...args)
    }
    window.ptRestoreDrawImage = () => { prototype.drawImage = original; delete window.ptGhostSamples; delete window.ptRestoreDrawImage }
  })()`)
  try {
    await applyPrefs(JSON.stringify(ghostPrefs))
    const [left, top] = await js(`(() => {
      const screen = [...document.querySelectorAll('.xterm-screen')].find(el => el.checkVisibility({ visibilityProperty: true }))
      const rect = screen.getBoundingClientRect()
      return [Math.round(rect.left + rect.width / 3), Math.round(rect.top + rect.height / 3)]
    })()`)
    const textCursor = await rootVar('--ez-cursor-text')
    const [_, image, hx, hy] = /url\("(blob:[^"]+)"\) (\d+) (\d+), text/.exec(textCursor)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: left, y: top })
    check('a terminal ghost uses the same themed I-beam image, size and hotspot as the cursor', await until(`
      window.ptGhostSamples.some(([src, size, x, y]) => src === ${JSON.stringify(image)}
        && size === 64 && x === ${left - Number(hx)} && y === ${top - Number(hy)})
    `, 3000))

    await applyPrefs(JSON.stringify({ ...ghostPrefs, set: 'system' }))
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: left + 45, y: top + 30 })
    check('the system pointer also leaves a centered text ghost over the terminal', await until(`
      window.ptGhostSamples.some(([, size, x, y]) => size === 32 && x === ${left + 45 - 16} && y === ${top + 30 - 16})
    `, 3000))
  } finally {
    await js('window.ptRestoreDrawImage()')
    await applyPrefs(savedPrefs)
  }
  await js(`document.activeElement && document.activeElement.blur()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma })
  check('reopening settings restores the last theme tab', await until(`!!${card('[data-effect]')}`, 8000))
  const overlap = await js(`(() => {
    const dialog = document.querySelector('.settings-modal').getBoundingClientRect()
    const left = Math.max(dialog.left, ${termLeft}) + 40, right = Math.min(dialog.right, ${termLeft + termWidth}) - 40
    const top = Math.max(dialog.top, ${termTop}) + 40, bottom = Math.min(dialog.bottom, ${termTop + termHeight}) - 40
    return right > left && bottom > top ? [(left + right) / 2, (top + bottom) / 2] : null
  })()`)
  check('the settings dialog lies over the terminal', Boolean(overlap))
  if (overlap) {
    await sweep(overlap[0], overlap[1])
    check('a dialog over the terminal shows the effect', await until(drawn, 3000))
  }
  await pick('[aria-label="누를 때 효과"] [data-effect="ripple"]')
  await pick('[aria-label="움직일 때 효과"] [data-effect="none"]')
  check('the canvas stays while the press effect is on', await js(`document.querySelectorAll('.pointer-effects-canvas').length === 1`))
  await pick('[aria-label="누를 때 효과"] [data-effect="none"]')
  check('turning both effects off removes the canvas', await until(`!document.querySelector('.pointer-effects-canvas')`, 3000))

  const stored = await js(`JSON.parse(localStorage.getItem('pointerPrefs') || '{}')`)
  check('the choice is stored under one key', stored.set === 'paw' && stored.size === 64 && stored.move === 'none' && stored.click === 'none', JSON.stringify(stored))

  await js(`[...document.querySelectorAll('.pointer-settings .pointer-actions button')].find(b => b.textContent.includes('기본값')).click()`)
  check('기본값으로 returns to the system pointer', await until(`!document.documentElement.dataset.cursorSet && !document.documentElement.style.getPropertyValue('--ez-cursor-pointer')`, 3000))
  await selectThemeTab(driver, '포인터 모양')
  check('with the system pointer the rules fall back to their own keywords', await js(`getComputedStyle(document.querySelector('.pointer-settings .pointer-card')).cursor === 'pointer'`))

  const wordCard = '[aria-label="누를 때 효과"] [data-effect="word"]'
  const appTheme = name => `[...document.querySelectorAll('.theme-card-main')].find(button =>
    button.querySelector('.theme-name').textContent === ${JSON.stringify(name)})`
  const sampleWords = selector => js(`(() => {
    const canvas = ${selector}
    const ctx = canvas.getContext('2d')
    const drawText = ctx.fillText.bind(ctx)
    ctx.fillText = (label, x, y) => {
      drawText(label, x, y)
      if (ctx.globalAlpha < 0.9) return
      const { a, d, e, f } = ctx.getTransform()
      const metrics = ctx.measureText(label)
      if (a < 1 || e - a * metrics.width / 2 < 0 || e + a * metrics.width / 2 > canvas.width) return
      if (f + d * (y - metrics.actualBoundingBoxAscent) < 0 || f + d * (y + metrics.actualBoundingBoxDescent) > canvas.height) return
      canvas.dataset.wordInk = ctx.fillStyle
    }
  })()`)
  const preview = `${card(wordCard)}.querySelector('canvas')`
  await selectThemeTab(driver, '앱 테마')
  await js(`${appTheme('흑백 만화')}.click()`)
  check('the monochrome comic app theme is active', await until(`document.documentElement.dataset.theme === 'monochrome-comic'`))
  await selectThemeTab(driver, '포인터 효과')
  await sampleWords(preview)
  await pick(wordCard)
  check('the word preview draws the whole label in white on the comic bubble', await until(`${preview}.dataset.wordInk === '#ffffff'`, 3500))
  await shot('pointer-word-comic-preview')

  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...escape })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...escape })
  await until(`!document.querySelector('.settings-modal')`, 4000)
  const overlay = `document.querySelector('.pointer-effects-canvas')`
  await sampleWords(overlay)
  await click(termLeft + termWidth * 0.55, termTop + termHeight * 0.35)
  check('a click in the comic terminal draws the word in white', await until(`${overlay}.dataset.wordInk === '#ffffff'`, 2500))
  await shot('pointer-word-comic-terminal')

  const problems = await pageProblems(driver)
  check('no console errors or CSP refusals', problems.length === 0, problems.join(' | '))
  driver.close()
  finish()
})().catch((error) => { console.error(error); process.exit(1) })
