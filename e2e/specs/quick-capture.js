const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { connect, createChecks, openLocalAgent, pages, pickTabGroup, sleep, unlock } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  if (process.platform !== 'win32' || process.env.E2E_APP) {
    console.log('SKIP quick-capture fixture needs the Windows development build')
    return
  }

  const main = await connect()
  const profile = process.env.E2E_PROFILE
  const file = name => path.join(profile, name)
  const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : ''
  const isOverlay = page => page.title === 'ezShell 영역 캡처'
  const waitFor = async (test, attempts = 100, interval = 100) => {
    for (let i = 0; i < attempts; i++) {
      if (await test()) return true
      await sleep(interval)
    }
    return false
  }
  const closeWithEscape = async overlay => {
    const started = performance.now()
    // The window can close before CDP acknowledges the key.
    void overlay.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
    const closed = await waitFor(async () => !(await pages()).some(isOverlay), 32, 25)
    return { closed, ms: Math.round(performance.now() - started) }
  }
  const openOverlay = async () => {
    fs.writeFileSync(file('capture-request'), '')
    const overlay = await connect(isOverlay)
    if (!(await overlay.until('document.hasFocus() && typeof window.chooseCaptureTarget === "function"'))) throw new Error('capture was not ready')
    return overlay
  }
  const setViewport = async (overlay, width, height, deviceScaleFactor) => {
    const result = await overlay.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false })
    if (result.error || !await overlay.until(`innerWidth === ${width} && innerHeight === ${height} && devicePixelRatio === ${deviceScaleFactor}`, 3000)) {
      throw new Error(`capture viewport did not become ${width}x${height} at ${deviceScaleFactor}`)
    }
  }
  const selectRegion = async (overlay, from, to) => {
    // The pointer events of the drag, shown when the region was not taken
    await overlay.js(`(() => {
      window.__dragEvents = []
      if (window.__dragWatch) return
      window.__dragWatch = true
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture', 'resize', 'blur', 'visibilitychange']) {
        (type === 'resize' || type === 'blur' ? window : document).addEventListener(type, () => window.__dragEvents.push(type + '@' + Math.round(performance.now())), true)
      }
    })()`)
    await drag(overlay, from, to)
    if (!(await overlay.until('document.activeElement.id === "comment"', 3000))) {
      throw new Error('region was not selected: ' + await overlay.js(`JSON.stringify({
        focus: document.activeElement.id, screen: [innerWidth, innerHeight], state: { ...document.body.dataset },
        selection: document.querySelector('#selection').style.cssText, events: window.__dragEvents,
        shots: window.captureEditor.shots(), review: document.querySelector('#review').hidden
      })`))
    }
  }
  const openCapture = async comment => {
    const overlay = await openOverlay()
    // The fixture bitmap is fixed. Draw marks at the same scale on every test monitor.
    await setViewport(overlay, 1280, 880, 1.25)
    await selectRegion(overlay, [100, 100], [640, 440])
    await overlay.type(comment)
    return overlay
  }
  // A drag on the overlay (the marks are drawn with the pointer)
  const drag = async (overlay, from, to) => {
    await overlay.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', buttons: 1, clickCount: 1 })
    await overlay.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (from[0] + to[0]) / 2, y: (from[1] + to[1]) / 2, button: 'left', buttons: 1 })
    await overlay.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to[0], y: to[1], button: 'left', buttons: 1 })
    await overlay.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', buttons: 0, clickCount: 1 })
  }
  // Pixels of the default mark color (#ff3b30) in an 8-bit RGB(A) PNG, as Electron writes it
  const redPixels = file => {
    const png = fs.readFileSync(file)
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    const channels = png[25] === 6 ? 4 : 3
    const parts = []
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at)
      if (png.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length))
      at += length + 12
    }
    const raw = zlib.inflateSync(Buffer.concat(parts))
    const stride = width * channels
    let previous = Buffer.alloc(stride)
    let count = 0
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]
      const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? line[i - channels] : 0
        const up = previous[i]
        const corner = i >= channels ? previous[i - channels] : 0
        const paeth = () => {
          const p = left + up - corner
          const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)]
          return a <= b && a <= c ? left : b <= c ? up : corner
        }
        const add = [0, left, up, (left + up) >> 1, paeth()][filter]
        line[i] = (line[i] + add) & 255
      }
      for (let x = 0; x < width; x++) {
        const [r, g, b] = line.subarray(x * channels, x * channels + 3)
        if (r > 200 && r - g > 120 && r - b > 120) count++
      }
      previous = line
    }
    return count
  }
  const clickButton = async (overlay, selector) => overlay.click(...await overlay.center(`document.querySelector(${JSON.stringify(selector)})`))
  const chooseTheme = async (name, id) => {
    await main.send('Page.bringToFront')
    await main.js(`document.querySelector('.title-bar-btn[title="설정"]').click()`)
    if (!await main.until('!!document.querySelector(".settings-tab-trigger")')) throw new Error('settings did not open')
    await main.js(`[...document.querySelectorAll('.settings-tab-trigger')].find(tab => tab.textContent.trim() === '테마')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
    if (!await main.until('!!document.querySelector(".theme-grid")')) throw new Error('theme settings did not open')
    await main.js(`[...document.querySelectorAll('.theme-card-main')].find(card =>
      card.querySelector('.theme-name').textContent === ${JSON.stringify(name)}).click()`)
    if (!await main.until(`document.documentElement.dataset.theme === ${JSON.stringify(id)}`)) throw new Error('app theme did not change')
    const escape = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }
    await main.send('Input.dispatchKeyEvent', { type: 'keyDown', ...escape })
    await main.send('Input.dispatchKeyEvent', { type: 'keyUp', ...escape })
    if (!await main.until('!document.querySelector(".settings-modal")')) throw new Error('theme settings did not close')
  }
  const reviewContrast = `(() => {
    const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
    const luminance = color => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).reduce((sum, channel, index) => {
        const srgb = channel / 255
        const linear = srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4
        return sum + linear * [.2126, .7152, .0722][index]
      }, 0)
    }
    const contrast = (a, b) => {
      const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y)
      return (light + .05) / (dark + .05)
    }
    const style = selector => getComputedStyle(document.querySelector(selector))
    const panel = style('#review'), input = style('#comment'), work = style('#work'), active = style('[data-tool="arrow"]')
    const placeholder = getComputedStyle(document.querySelector('#comment'), '::placeholder')
    return {
      surface: panel.backgroundColor, accent: work.backgroundColor, scheme: panel.colorScheme,
      text: Math.min(contrast(panel.color, panel.backgroundColor), contrast(input.color, input.backgroundColor),
        contrast(placeholder.color, input.backgroundColor), contrast(style('#work-description').color, panel.backgroundColor),
        contrast(work.color, work.backgroundColor), contrast(active.color, active.backgroundColor)),
      outline: input.outlineStyle,
      edge: Math.min(contrast(input.borderColor, input.backgroundColor), contrast(input.borderColor, panel.backgroundColor),
        contrast(input.outlineColor, panel.backgroundColor), contrast(work.backgroundColor, panel.backgroundColor))
    }
  })()`
  const chooseProject = (overlay, folder) => overlay.js(`(() => {
    const select = document.querySelector('#project')
    select.value = ${JSON.stringify(folder)}
    select.dispatchEvent(new Event('change'))
  })()`)
  const openChat = async (project, agent) => {
    await main.send('Page.bringToFront')
    await pickTabGroup(main, project)
    const pane = `document.querySelector('[aria-label="${agent} 메시지함"]')?.closest('[data-local-shell-id]')`
    await main.js(`${pane}?.querySelector('.xterm-helper-textarea')?.focus()`)
    const key = { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, modifiers: 10 }
    await main.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
    await main.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    const cover = `${pane}?.querySelector('.agent-chat-cover')`
    if (!await main.until(`!!${cover}`)) throw new Error('The agent chat did not open: ' + agent)
    return cover
  }
  const thumbnailIn = (cover, text) => `(() => {
    const row = ${cover}.querySelector('.agent-chat-user')
    const image = row?.querySelector('.agent-chat-sent-images img')
    return row?.querySelector('.agent-chat-bubble')?.textContent === ${JSON.stringify(text)} &&
      image?.naturalWidth > 0 && image.naturalWidth <= 280
  })()`

  const service = file('service')
  const tools = file('tools')
  fs.mkdirSync(service)
  fs.mkdirSync(tools)
  await unlock(main)

  const key = async (type, key, code, windowsVirtualKeyCode, modifiers = 0) => {
    await main.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers })
  }
  const escape = async () => {
    await key('rawKeyDown', 'Escape', 'Escape', 27)
    await key('keyUp', 'Escape', 'Escape', 27)
  }
  const captureRows = `[...document.querySelectorAll('.shortcut-item')].filter(row => row.querySelector('.shortcut-description')?.textContent === '영역 캡처')`
  const openShortcuts = async () => {
    await main.send('Page.bringToFront')
    await main.js(`document.querySelector('.title-bar-btn[title="설정"]').click()`)
    if (!await main.until(`!!document.querySelector('.settings-tab-trigger')`)) throw new Error('settings did not open')
    await main.js(`[...document.querySelectorAll('.settings-tab-trigger')].find(tab => tab.textContent.includes('단축키'))
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
    if (!await main.until(`${captureRows}.length === 2`)) throw new Error('capture shortcut rows are missing')
  }
  const record = async index => {
    await main.js(`${captureRows}[${index}].querySelector('.shortcut-change-btn').click()`)
    if (!await main.until(`!!${captureRows}[${index}].querySelector('.is-recording')`)) throw new Error('recording did not start')
  }
  const disable = index => main.js(`[...${captureRows}[${index}].querySelectorAll('button')].find(button => button.textContent === '사용 안 함').click()`)
  const reset = index => main.js(`${captureRows}[${index}].querySelector('.shortcut-reset-btn').click()`)
  const bindings = expected => waitFor(() => fs.existsSync(file('capture-bindings')) && read('capture-bindings') === expected)
  const closeSettings = async () => {
    await escape()
    if (!await main.until(`!document.querySelector('.settings-modal')`)) throw new Error('settings did not close')
  }
  await openShortcuts()
  check('capture settings start with both default bindings', await bindings('13 0\n7 0'))
  await record(0)
  await key('rawKeyDown', 'Control', 'ControlLeft', 17, 2)
  await key('rawKeyDown', 'Meta', 'MetaLeft', 91, 6)
  await key('rawKeyDown', 'Alt', 'AltLeft', 18, 7)
  await key('keyUp', 'Alt', 'AltLeft', 18, 6)
  await key('keyUp', 'Meta', 'MetaLeft', 91, 2)
  await key('keyUp', 'Control', 'ControlLeft', 17)
  check('a duplicate capture gesture is refused on the edited row', await main.until(`!!${captureRows}[0].querySelector('.shortcut-problem')`))
  await key('rawKeyDown', 'Alt', 'AltLeft', 18, 1)
  await key('rawKeyDown', 'Meta', 'MetaLeft', 91, 5)
  await key('rawKeyDown', 'Shift', 'ShiftLeft', 16, 13)
  await key('keyUp', 'Shift', 'ShiftLeft', 16, 5)
  await key('keyUp', 'Meta', 'MetaLeft', 91, 1)
  check('a modifier-only capture remains in recording until the final release', await main.js(`!!${captureRows}[0].querySelector('.is-recording')`))
  await key('keyUp', 'Alt', 'AltLeft', 18)
  check('the new modifier-only gesture including Win reaches the helper', await bindings('14 0\n7 0'))
  await reset(0)
  check('resetting the first gesture restores only that default', await bindings('13 0\n7 0'))
  await disable(1)
  check('the second gesture can be disabled independently', await bindings('13 0'))
  await record(0)
  await key('rawKeyDown', ' ', 'Space', 32, 3)
  await key('keyUp', ' ', 'Space', 32)
  check('the work overview binding reports a conflict in capture settings',
    await main.until(`${captureRows}[0].querySelector('.shortcut-problem')?.textContent.includes('로컬 작업 현황')`))
  await key('rawKeyDown', 'F9', 'F9', 120, 10)
  await key('keyUp', 'F9', 'F9', 120)
  check('the new keyed gesture is saved and sent as numeric parts', await bindings('9 120') &&
    await main.js(`localStorage.getItem('customShortcuts') === '{"quick-capture-win":[],"quick-capture":["Ctrl","Shift","F9"]}'`))
  const overviewRow = `[...document.querySelectorAll('.shortcut-item')].find(row => row.querySelector('.shortcut-description')?.textContent === '로컬 작업 현황 열기')`
  await main.js(`${overviewRow}.querySelector('.shortcut-change-btn').click()`)
  if (!await main.until(`!!${overviewRow}.querySelector('.is-recording')`)) throw new Error('overview recording did not start')
  await key('rawKeyDown', 'F8', 'F8', 119, 3)
  await key('keyUp', 'F8', 'F8', 119)
  await record(1)
  await key('rawKeyDown', ' ', 'Space', 32, 3)
  await key('keyUp', ' ', 'Space', 32)
  check('an unused former overview shortcut is available to a capture row', await bindings('9 120\n5 32'))
  await main.js(`${overviewRow}.querySelector('.shortcut-reset-btn').click()`)
  check('resetting the overview reports the active capture conflict',
    await main.until(`${overviewRow}.querySelector('.shortcut-problem')?.textContent.includes('영역 캡처')`) && await bindings('9 120\n5 32'))
  await disable(1)
  await main.js(`${overviewRow}.querySelector('.shortcut-reset-btn').click()`)
  if (!await bindings('9 120')) throw new Error('could not restore the overview shortcut')
  await closeSettings()
  fs.writeFileSync(file('capture-hold'), '')
  fs.writeFileSync(file('capture-request'), '9 120')
  if (!await waitFor(() => fs.existsSync(file('capture-opening')))) throw new Error('the keyed capture did not begin on key press')
  fs.unlinkSync(file('capture-hold'))
  await sleep(250)
  check('a keyed capture does not raise its overlay before releasing the modifiers', !(await pages()).some(isOverlay))
  fs.writeFileSync(file('capture-release'), '')
  const rebound = await connect(isOverlay)
  check('releasing the modifiers opens the rebound capture overlay', await rebound.until('document.hasFocus()'))
  check('the rebound overlay closes with Escape', (await closeWithEscape(rebound)).closed)
  rebound.close()
  fs.unlinkSync(file('capture-opening'))

  await openShortcuts()
  await disable(0)
  check('turning off both shortcut rows clears both native bindings', await bindings(''))
  fs.writeFileSync(file('capture-request'), '9 120')
  await waitFor(() => !fs.existsSync(file('capture-request')))
  check('a disabled capture binding does not open the overlay', !(await pages()).some(isOverlay))
  await closeSettings()
  await key('rawKeyDown', 'p', 'KeyP', 80, 2)
  await key('keyUp', 'p', 'KeyP', 80)
  if (!await main.until(`!!document.querySelector('.command-palette input')`)) throw new Error('capture command palette did not open')
  await main.type('영역 캡처')
  const captureCommand = `[...document.querySelectorAll('.command-item')].find(item => item.textContent.includes('영역 캡처'))`
  if (!await main.until(`!!${captureCommand}`)) throw new Error('capture command is missing')
  await main.js(`${captureCommand}.click()`)
  const manual = await connect(isOverlay)
  check('the command palette still opens capture with both shortcuts disabled', await manual.until('document.hasFocus()'))
  await closeWithEscape(manual)
  manual.close()
  await openShortcuts()
  await reset(0)
  await reset(1)
  check('both shortcuts can be reset from their disabled state', await bindings('13 0\n7 0'))
  await closeSettings()

  const effectCanvas = 'document.querySelector(".pointer-effects-canvas")'
  const canvasDisplay = `(${effectCanvas} ? getComputedStyle(${effectCanvas}).display : 'absent')`
  await main.js(`localStorage.setItem('pointerPrefs', JSON.stringify({ move: 'spot', click: 'ripple' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'pointerPrefs' }))`)
  if (!await main.until(`${canvasDisplay} === 'block'`)) throw new Error('The pointer effect canvas did not appear')
  fs.writeFileSync(file('capture-hold'), '')
  fs.writeFileSync(file('capture-request'), '13 0')
  if (!(await waitFor(() => fs.existsSync(file('capture-opening'))))) throw new Error('Capture did not begin loading')
  check('Ctrl+Win+Alt hides the pointer effects before asking for the desktop image', await main.js(`${canvasDisplay} === 'none'`))
  fs.writeFileSync(file('capture-cancel'), '')
  if (!(await waitFor(() => !fs.existsSync(file('capture-cancel'))))) throw new Error('Cancel signal was not read')
  fs.unlinkSync(file('capture-hold'))
  await sleep(300)
  check('Esc reported while the display is loading prevents the overlay from appearing', !(await pages()).some(isOverlay))
  check('cancelling while reading the desktop restores the pointer effects', await main.until(`${canvasDisplay} === 'block'`))

  const initialSurface = await main.js("getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim()")
  fs.writeFileSync(file('capture-request'), '')
  const beforeSelection = await connect(isOverlay)
  if (!(await beforeSelection.until('document.hasFocus() && !document.body.hasAttribute("data-review")'))) {
    throw new Error('New capture overlay did not receive focus')
  }
  check('the capture takes its initial palette from the main window', await beforeSelection.js(`
    typeof window.electronAPI === 'undefined' &&
      getComputedStyle(document.documentElement).getPropertyValue('--capture-surface').trim() === ${JSON.stringify(initialSurface)}
  `))
  check('the pointer effects stay hidden while the capture editor is open', await main.js(`${canvasDisplay} === 'none'`)
    && await beforeSelection.js(`!${effectCanvas}`))
  const firstCancel = await closeWithEscape(beforeSelection)
  check('Escape promptly closes a new capture before any click or selection', firstCancel.closed, `${firstCancel.ms}ms`)
  beforeSelection.close()
  check('cancelling a new capture leaves the clipboard alone', !fs.existsSync(file('capture-copied')))
  check('closing the editor restores the chosen pointer effects', await main.until(`${canvasDisplay} === 'block'`))
  await main.js(`localStorage.removeItem('pointerPrefs'); window.dispatchEvent(new StorageEvent('storage', { key: 'pointerPrefs' }))`)

  await openLocalAgent(main, 'codex', service)
  await openLocalAgent(main, 'claude', tools)
  if (!(await waitFor(() => read('codex-1-tools') && read('claude-2-tools')))) throw new Error('fake agents did not start')
  const claudeRole = '리뷰어' + 'W'.repeat(17)
  const assigned = await main.js(`window.electronAPI.agentMessageSetRole('claude-2', ${JSON.stringify(claudeRole)})`)
  if (!assigned?.success) throw new Error('Could not assign the test role: ' + assigned?.error)

  const holdProjects = file('capture-projects-hold')
  const loading = await openCapture('')
  fs.writeFileSync(holdProjects, '')
  try {
    await clickButton(loading, '#work')
    if (!await waitFor(() => fs.existsSync(file('capture-projects-opening')))) throw new Error('Projects did not start loading')
    const cancelled = await closeWithEscape(loading)
    check('Escape promptly closes the capture while the project lookup is still held', cancelled.closed, `${cancelled.ms}ms`)
    if (!cancelled.closed) throw new Error('Escape did not close a capture with a pending project lookup')
    const fresh = await openOverlay()
    const nextCancel = await closeWithEscape(fresh)
    check('the hotkey can open another capture before the old project lookup finishes', nextCancel.closed)
    fresh.close()
  } finally {
    fs.unlinkSync(holdProjects)
    loading.close()
  }

  const placement = await openOverlay()
  const cases = [
    { name: 'below at 125%', viewport: [1280, 880, 1.25], from: [140, 100], to: [800, 260], side: 'below' },
    { name: 'above at 150%', viewport: [1100, 820, 1.5], from: [180, 490], to: [950, 760], side: 'above' },
    { name: 'on the right at 150%', viewport: [1100, 720, 1.5], from: [40, 160], to: [390, 580], side: 'right', shot: 'quick-capture-toolbar-side-150' },
    { name: 'on the left at 125%', viewport: [1100, 720, 1.25], from: [710, 160], to: [1040, 580], side: 'left' },
    { name: 'below on a narrow display at 150%', viewport: [400, 820, 1.5], from: [24, 50], to: [360, 140], side: 'below', wrapped: true },
    { name: 'in a scrollable strip at 150%', viewport: [720, 530, 1.5], from: [124, 195], to: [596, 345], side: 'above', clipped: true, shot: 'quick-capture-toolbar-narrow-150' }
  ]
  for (const scenario of cases) {
    await setViewport(placement, ...scenario.viewport)
    await selectRegion(placement, scenario.from, scenario.to)
    const position = await placement.js(`(() => {
      const selection = document.querySelector('#selection').getBoundingClientRect()
      const review = document.querySelector('#review')
      const panel = review.getBoundingClientRect()
      const side = panel.top >= selection.bottom + 11 ? 'below' : panel.bottom <= selection.top - 11 ? 'above'
        : panel.left >= selection.right + 11 ? 'right' : panel.right <= selection.left - 11 ? 'left' : 'overlap'
      return { side, inView: panel.left >= 11 && panel.top >= 11 && panel.right <= innerWidth - 11 && panel.bottom <= innerHeight - 11,
        width: panel.width, height: panel.height, clipped: review.scrollHeight > review.clientHeight,
        wrapped: new Set([...document.querySelectorAll('[data-tool]')].map(button => button.getBoundingClientRect().top)).size > 1 }
    })()`)
    check(`the toolbar fits outside the selection ${scenario.name}`, position.side === scenario.side && position.inView
      && position.clipped === Boolean(scenario.clipped) && (!scenario.wrapped || position.wrapped), JSON.stringify(position))
    if (scenario.shot) await placement.shot(scenario.shot)
    await placement.js('document.querySelector("#reselect").scrollIntoView({ block: "nearest" })')
    await clickButton(placement, '#reselect')
    if (!await placement.until('document.querySelector("#review").hidden')) throw new Error('the selection did not reset')
  }
  void placement.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
  if (!(await waitFor(async () => !(await pages()).some(isOverlay)))) throw new Error('placement fixture did not close')
  placement.close()

  for (const theme of [
    { name: 'Minimal Dark', id: 'minimal-dark', scheme: 'dark', surface: 'rgb(23, 24, 27)', accent: 'rgb(47, 111, 237)' },
    { name: '카톡 모드', id: 'kakao-mode', scheme: 'light', surface: 'rgb(248, 251, 255)', accent: 'rgb(128, 88, 0)' }
  ]) {
    await chooseTheme(theme.name, theme.id)
    const themed = await openCapture('이 영역을 확인해 주세요.')
    const colors = await themed.js(reviewContrast)
    check(`${theme.name} colors reach the capture toolbar after a theme change`,
      colors.surface === theme.surface && colors.accent === theme.accent && colors.scheme === theme.scheme, JSON.stringify(colors))
    check(`${theme.name} capture text, button, input border and focus meet contrast targets`,
      colors.text >= 4.5 && colors.edge >= 3 && colors.outline === 'solid', JSON.stringify(colors))
    await themed.shot('quick-capture-theme-' + theme.id)
    void themed.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
    if (!await waitFor(async () => !(await pages()).some(isOverlay))) throw new Error('the themed capture did not close')
    themed.close()
  }

  const comment = '선택한 화면을 확인해 주세요'
  const overlay = await openCapture(comment)
  // 2026-11-23 user request: mark the problem on the capture before sending it
  check('the region opens ready to draw an arrow', await overlay.js(`
    !document.querySelector('#ink').hidden && document.querySelector('[data-tool="arrow"]').getAttribute('aria-pressed') === 'true'
    && document.querySelector('#undo').disabled
  `), await overlay.js(`JSON.stringify({ ink: document.querySelector('#ink').hidden, arrow: document.querySelector('[data-tool="arrow"]').getAttribute('aria-pressed'), undo: document.querySelector('#undo').disabled })`))
  check('the toolbar shows the names and shortcuts of all six tools', await overlay.js(`(() => {
    const tools = [...document.querySelectorAll('[data-tool]')]
    return tools.map(button => button.querySelector('kbd').textContent).join('') === 'ARPTNM' && tools.every(button => {
      const label = button.getAttribute('aria-label')
      const key = button.getAttribute('aria-keyshortcuts')
      return button.innerText.includes(label) && button.title.includes(label + ' (' + key + ')')
    }) && document.querySelector('#work').getAttribute('aria-describedby') === 'work-description'
  })()`))
  await overlay.js('document.querySelector("#comment").blur()')
  await overlay.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 })
  await overlay.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77 })
  check('the mosaic shortcut changes the pressed tool', await overlay.js(`document.querySelector('[data-tool="mosaic"]').getAttribute('aria-pressed') === 'true'`))
  await clickButton(overlay, '[data-color="#0a84ff"]')
  check('the selected color is checked and used in all three stroke previews', await overlay.js(`
    document.querySelector('[data-color="#0a84ff"]').getAttribute('aria-pressed') === 'true' &&
    getComputedStyle(document.querySelector('[data-color="#0a84ff"] .swatch-dot .icon')).visibility === 'visible' &&
    [...document.querySelectorAll('.stroke')].every(stroke => getComputedStyle(stroke).backgroundColor === 'rgb(10, 132, 255)')
  `))
  await clickButton(overlay, '[data-color="#ff3b30"]')
  await clickButton(overlay, '[data-tool="arrow"]')
  await drag(overlay, [140, 140], [320, 260])
  await clickButton(overlay, '[data-tool="box"]')
  await drag(overlay, [160, 280], [300, 340])
  check('two marks can be undone and redone', await overlay.js('!document.querySelector("#undo").disabled'))
  await clickButton(overlay, '#undo')
  check('undo takes back the last mark', await overlay.js('!document.querySelector("#redo").disabled'))
  await clickButton(overlay, '#redo')
  await overlay.shot('quick-capture-toolbar')
  await overlay.shot('quick-capture-marks')
  await clickButton(overlay, '#work')
  check('quick work lists two projects without submitting a capture', await overlay.until(`
    Array.from(document.querySelector('#project').options).map(option => option.text).join('|') === ${JSON.stringify(`프로젝트를 선택하세요|${path.basename(profile)} / service|${path.basename(profile)} / tools`)} &&
    !document.querySelector('.agent')
  `) && !read('codex-1-chat-sent') && !read('claude-2-chat-sent'), await overlay.js(`Array.from(document.querySelector('#project').options).map(option => option.text).join('|') + ' agents=' + document.querySelectorAll('.agent').length`))
  await chooseProject(overlay, tools)
  const claudeTarget = `Claude Code · ${claudeRole} · claude-2`
  check('the chosen project shows its agent with the role in the title and accessible name', await overlay.until(`
    document.querySelectorAll('.agent').length === 1 &&
    document.querySelector('.agent-title').textContent === ${JSON.stringify(claudeRole + ' · claude-2')} &&
    document.querySelector('.agent-icon[data-kind="claude"]')?.textContent === 'Claude Code' &&
    /^.+에 전송$/.test(document.querySelector('.agent').getAttribute('aria-label')) &&
    document.querySelector('.agent').getAttribute('aria-label').startsWith(${JSON.stringify(claudeTarget)})
  `))
  check('the longest role wraps and leaves room for Send in a narrow list', await overlay.js(`(() => {
    const review = document.querySelector('#review')
    const width = review.style.width
    review.style.width = '272px'
    try {
      const list = document.querySelector('#agents')
      const button = list.querySelector('.agent')
      const title = button.querySelector('.agent-title')
      const send = button.querySelector('.agent-send')
      const text = document.createRange()
      text.selectNodeContents(title)
      return text.getClientRects().length > 1 && title.scrollWidth <= title.clientWidth &&
        list.scrollWidth <= list.clientWidth && send.getBoundingClientRect().right < button.getBoundingClientRect().right
    } finally {
      review.style.width = width
    }
  })()`))
  await clickButton(overlay, '#back')
  check('back preserves the region and comment', await overlay.js(`
    !document.querySelector('#selection').hidden && document.querySelector('#comment').value === ${JSON.stringify(comment)}
  `))
  await clickButton(overlay, '#work')
  await overlay.until('!document.querySelector("#picker").hidden')
  await chooseProject(overlay, service)
  check('an agent without a role keeps its usual label', await overlay.until(`
    document.querySelector('.agent-title')?.textContent === 'codex-1' &&
    !!document.querySelector('.agent-icon[data-kind="codex"]') &&
    /^Codex · codex-1( · [^·]+)?에 전송$/.test(document.querySelector('.agent')?.getAttribute('aria-label') ?? '')
  `))
  await overlay.shot('quick-capture-agent')
  await clickButton(overlay, '.agent')
  check('choosing Codex submits the exact comment and cropped PNG to that session', await waitFor(() => {
    if (read('codex-1-chat-sent') !== '1') return false
    const [image] = JSON.parse(read('codex-1-chat-images'))
    const png = fs.readFileSync(image)
    return read('codex-1-chat-text') === comment && png.readUInt32BE(16) < 800 && png.readUInt32BE(20) < 600
      && !read('claude-2-chat-sent') && !fs.existsSync(file('capture-copied'))
  }))
  const sentImage = JSON.parse(read('codex-1-chat-images') || '[]')[0]
  const red = sentImage ? redPixels(sentImage) : -1
  check('the sent image has the marks drawn in it', red > 200, String(red))
  check('the capture closes after submission', await waitFor(async () => !(await pages()).some(isOverlay)))
  overlay.close()

  const codexCover = await openChat('service', 'codex-1')
  check('opening the receiving chat later shows the annotated capture above the comment', await main.until(thumbnailIn(codexCover, comment)))

  const claudeCover = await openChat('tools', 'claude-2')
  const sessionId = '5a6f0d9e-1b2c-4d3e-8f90-0a1b2c3d4e5f'
  const transcript = file(path.join('claude-home', 'projects', 'test', sessionId + '.jsonl'))
  const append = (entry) => fs.appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n')
  append({ type: 'assistant', uuid: 'before-capture', message: { id: 'before-capture', role: 'assistant', content: [{ type: 'text', text: '캡처 전 답변' }] } })
  const report = file('claude-status.json')
  fs.writeFileSync(report, JSON.stringify({ session_id: sessionId, model: { id: 'claude-opus-5-5' } }))
  fs.writeFileSync(file('claude-2-command'), `"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_AGENT_USAGE_SCRIPT%" < "${report}"`)
  if (!await main.until(`${claudeCover}.textContent.includes('캡처 전 답변')`)) throw new Error('Claude did not attach to its test transcript')
  const claudeComment = 'Claude에게 보낼 코멘트'
  const second = await openCapture(claudeComment)
  await clickButton(second, '[data-tool="badge"]')
  await second.click(200, 200)
  check('a numbered badge adds its line to the comment', await second.until(`
    document.querySelector('#comment').value === ${JSON.stringify('Claude에게 보낼 코멘트' + String.fromCharCode(10) + '1. ')}
  `))
  await second.js(`document.querySelector('#comment').value = ${JSON.stringify(claudeComment)}`)
  await second.js(`(() => {
    const comment = document.querySelector('#comment')
    comment.focus()
    comment.setSelectionRange(comment.value.length, comment.value.length)
  })()`)
  const composing = await second.send('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 })
  if (composing.error) throw new Error('Could not start the test IME composition')
  const composingEscape = await Promise.race([
    second.js(`(() => {
      const comment = document.querySelector('#comment')
      if (!comment.value.endsWith('ㅎ')) return false
      comment.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))
      return document.activeElement === comment
    })()`),
    sleep(3000).then(() => false)
  ])
  const keptComposing = composingEscape && (await pages()).some(isOverlay)
  check('an Escape during Korean IME composition keeps the capture open', keptComposing)
  if (!keptComposing) throw new Error('Capture closed during IME composition')
  await second.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await second.js(`document.querySelector('#comment').value = ${JSON.stringify(claudeComment)}`)

  const existingMarks = await second.js("document.querySelector('#ink').toDataURL()")
  await clickButton(second, 'button[data-tool="text"]')
  await second.click(240, 150)
  check('the text tool opens a field where it was clicked', await second.until('document.activeElement?.classList.contains("ink-text")', 3000))
  await second.type('버릴 글자')
  void second.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
  const keptCapture = await Promise.race([
    second.until(`
      !document.querySelector('.ink-text') && document.querySelector('#ink').toDataURL() === ${JSON.stringify(existingMarks)} &&
      document.querySelector('#comment').value === ${JSON.stringify(claudeComment)}
    `, 3000),
    sleep(3500).then(() => false)
  ])
  check('Escape in the text tool drops only the draft text and preserves the capture', keptCapture)
  if (!keptCapture) throw new Error('Text Escape did not preserve the capture')
  await second.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await second.click(240, 150)
  await second.until('document.activeElement?.classList.contains("ink-text")')
  await second.type('여기 확인')
  await second.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await second.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await clickButton(second, 'button[data-tool="mosaic"]')
  await drag(second, [150, 260], [330, 330])
  check('text and mosaic become marks of the image', await second.until(`
    !document.querySelector('.ink-text') && !document.querySelector('#undo').disabled && window.captureEditor.hasMarks()
  `, 3000))
  await second.shot('quick-capture-text-mosaic')
  await clickButton(second, '#work')
  await second.until('!document.querySelector("#picker").hidden')
  await chooseProject(second, tools)
  await clickButton(second, '.agent')
  check('choosing Claude submits the capture through its composer', await waitFor(() => {
    if (read('claude-2-chat-sent') !== '1') return false
    const [image, , text] = read('claude-2-chat-text').split('\n')
    return fs.existsSync(image) && text === claudeComment && read('codex-1-chat-sent') === '1'
  }))
  second.close()
  const [image] = read('claude-2-chat-text').split('\n')
  append({ type: 'user', uuid: 'capture-sent', message: { role: 'user', content: [
    { type: 'text', text: '[Image #1]' + claudeComment },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(image, 'base64') } }
  ] } })
  check('Claude recording the capture keeps the thumbnail and the exact comment on one bubble', await main.until(`
    !!${claudeCover}.querySelector('[data-chat-row="item:user:capture-sent"]') &&
    ${claudeCover}.querySelectorAll('.agent-chat-user').length === 1 &&
    ${thumbnailIn(claudeCover, claudeComment)}
  `))
  await main.shot('quick-capture-chat-thumbnail')
  // 2026-11-24 user request: 추가 캡처 takes another capture; the run is edited, copied and sent together
  const isChip = page => page.title === 'ezShell 캡처 보관'
  // A click that closes its window: the release is not acknowledged once the window is gone, so it is not awaited
  const clickClosing = async (page, selector) => {
    const [x, y] = await page.center(`document.querySelector(${JSON.stringify(selector)})`)
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    void page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }
  const pressEscape = page => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    .then(() => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }))
  const keepMore = async overlay => {
    await clickClosing(overlay, '#more')
    if (!await waitFor(async () => !(await pages()).some(isOverlay))) throw new Error('추가 캡처 did not close the overlay')
    overlay.close()
    const chip = await connect(isChip, { focus: false })
    if (!await chip.until(`document.querySelector('#count').textContent.length > 0`)) throw new Error('the strip did not show its count')
    return chip
  }
  const runComment = '두 화면을 비교해 주세요'
  const firstShot = await openCapture(runComment)
  check('a single capture offers 추가 캡처 without a list of captures', await firstShot.js(`
    !document.querySelector('#more').disabled && document.querySelector('#shots').hidden
  `))
  await firstShot.js('document.querySelector("#comment").blur()')
  await drag(firstShot, [140, 140], [320, 260])
  const strip = await keepMore(firstShot)
  check('the strip counts the kept capture without taking the keyboard', await strip.js(`
    document.querySelector('#count').textContent === '캡처 1장 보관 중' && !document.hasFocus()
  `))
  await strip.shot('quick-capture-run-strip')
  await clickClosing(strip, '#capture')
  const choosing = await connect(isOverlay)
  check('지금 캡처 hides the strip and freezes the screen again', await choosing.until(`
    document.querySelector('#hint').textContent.includes('Esc 캡처 목록으로') && document.querySelector('#review').hidden
  `) && !(await pages()).some(isChip))
  strip.close()
  await pressEscape(choosing)
  check('Esc while choosing the next region goes back to the earlier capture with its marks and comment', await choosing.until(`
    !document.querySelector('#review').hidden && document.querySelector('#shots').hidden &&
    !document.querySelector('#undo').disabled && document.querySelector('#reselect').disabled &&
    document.querySelector('#comment').value === ${JSON.stringify(runComment)}
  `))
  const strip2 = await keepMore(choosing)
  strip2.close()
  // The hotkey goes on with the run as well
  fs.writeFileSync(file('capture-request'), '')
  const secondShot = await connect(isOverlay)
  if (!await secondShot.until('document.hasFocus() && document.querySelector("#review").hidden')) throw new Error('the second capture did not open')
  await setViewport(secondShot, 1280, 880, 1.25)
  await selectRegion(secondShot, [700, 120], [1000, 360])
  check('the second capture shows both captures in the list, the new one selected', await secondShot.until(`(() => {
    const picks = [...document.querySelectorAll('.shot-pick')]
    return !document.querySelector('#shots').hidden && picks.length === 2 && picks[1].getAttribute('aria-pressed') === 'true' &&
      picks.every(pick => pick.querySelector('canvas').width > 0) && !document.querySelector('#reselect').disabled
  })()`))
  await clickButton(secondShot, '.shot-pick')
  check('choosing the first thumbnail edits it again, its marks still undoable', await secondShot.until(`
    document.querySelector('.shot-pick').getAttribute('aria-pressed') === 'true' && window.captureEditor.active() === 0 &&
    !document.querySelector('#undo').disabled && document.querySelector('#reselect').disabled
  `))
  await secondShot.shot('quick-capture-run-first')
  await clickButton(secondShot, '[data-tool="badge"]')
  const firstBox = await secondShot.js(`(() => { const r = document.querySelector('#ink').getBoundingClientRect(); return [r.left + 30, r.top + 30] })()`)
  await secondShot.click(...firstBox)
  await clickButton(secondShot, '.shot:nth-child(2) .shot-pick')
  const secondBox = await secondShot.js(`(() => { const r = document.querySelector('#ink').getBoundingClientRect(); return [r.left + 30, r.top + 30] })()`)
  await secondShot.click(...secondBox)
  const nl = String.fromCharCode(10)
  check('badge numbers go on across the captures of the run', await secondShot.until(`
    document.querySelector('#comment').value === ${JSON.stringify(runComment + nl + '1.' + nl + '2. ')}
  `), await secondShot.js(`JSON.stringify(document.querySelector('#comment').value)`))
  await secondShot.js('document.querySelector("#comment").blur()')
  await pressEscape(secondShot)
  check('one Esc on two captures only warns', await secondShot.until(`
    document.querySelector('#status').textContent.includes('한 번 더') && document.querySelector('#status').hasAttribute('data-error')
  `) && (await pages()).some(isOverlay))
  const sizes = await secondShot.js(`window.captureEditor.shots().map(shot => [shot.width, shot.height])`)
  if (fs.existsSync(file('capture-copied'))) fs.unlinkSync(file('capture-copied'))
  await clickClosing(secondShot, '#copy')
  const copied = await waitFor(() => {
    if (!fs.existsSync(file('capture-copied'))) return false
    const png = fs.readFileSync(file('capture-copied'))
    return png.length > 24 && png.readUInt32BE(16) === Math.max(sizes[0][0], sizes[1][0]) &&
      png.readUInt32BE(20) === sizes[0][1] + sizes[1][1] + 32 + 16 + 32
  })
  check('copying the run puts both captures stacked in one picture', copied, JSON.stringify({ sizes, error: read('capture-error'),
    titles: (await pages()).map(page => page.title),
    page: (await pages()).some(isOverlay) ? await secondShot.js(`JSON.stringify({ status: document.querySelector('#status').textContent, copy: document.querySelector('#copy').getBoundingClientRect(), review: document.querySelector('#review').getBoundingClientRect() })`) : null }))
  if (!copied) throw new Error('the run was not copied')
  check('the run ends with the copy: no strip is left', await waitFor(async () => !(await pages()).some(page => isOverlay(page) || isChip(page))))
  secondShot.close()

  // Sent to an agent: every capture of the run, in order, in one message
  const sendFirst = await openCapture('')
  await sendFirst.js('document.querySelector("#comment").blur()')
  await drag(sendFirst, [140, 140], [320, 260])
  const strip3 = await keepMore(sendFirst)
  strip3.close()
  fs.writeFileSync(file('capture-request'), '')
  const sendSecond = await connect(isOverlay)
  if (!await sendSecond.until('document.hasFocus() && document.querySelector("#review").hidden')) throw new Error('the next capture did not open')
  await setViewport(sendSecond, 1280, 880, 1.25)
  await selectRegion(sendSecond, [700, 120], [1000, 360])
  await clickButton(sendSecond, '#work')
  await sendSecond.until('!document.querySelector("#picker").hidden')
  await chooseProject(sendSecond, service)
  await clickClosing(sendSecond, '.agent')
  check('바로작업 sends both captures to Codex in one message, the marked one first', await waitFor(() => {
    if (read('codex-1-chat-sent') !== '2') return false
    const images = JSON.parse(read('codex-1-chat-images') || '[]')
    return images.length === 2 && images.every(image => fs.existsSync(image)) && redPixels(images[0]) > 200 && redPixels(images[1]) === 0
  }), read('codex-1-chat-images'))
  sendSecond.close()

  await main.js(`window.electronAPI.agentMessagesSnapshot().then(({ agents }) => {
    for (const agent of agents.filter(agent => agent.active)) window.electronAPI.localShellClose(agent.shellId)
  })`)
  await main.until(`window.electronAPI.agentMessagesSnapshot().then(({ agents }) => !agents.some(agent => agent.active))`)
  const requestFolder = file('new-capture-project')
  fs.mkdirSync(requestFolder)
  fs.writeFileSync(file('test-agent-request-folder'), requestFolder)
  const newCapture = await openCapture('새 세션에서 이 화면을 확인해 주세요.')
  await clickButton(newCapture, '#work')
  check('capture offers a new session even with no existing projects or agents', await newCapture.until(`
    !document.querySelector('#picker').hidden && document.querySelector('#project-fields').hidden &&
    document.querySelector('#new-capture-session summary').textContent === '새 세션에 요청'
  `))
  await clickButton(newCapture, '#new-capture-session summary')
  check('capture offers both agents for a new session', await newCapture.js(`
    [...document.querySelectorAll('.new-capture-providers button')].map(button => button.dataset.kind).join(',') === 'claude,codex'
  `))
  await clickClosing(newCapture, '.new-capture-providers [data-kind="claude"]')
  check('the capture overlay closes and the new Claude tab opens in the chosen folder',
    await waitFor(async () => !(await pages()).some(isOverlay)) && await main.until(`
      window.electronAPI.agentMessagesSnapshot().then(({ agents }) => agents.some(agent =>
        agent.mcpConnected && agent.kind === 'claude' && agent.cwd === ${JSON.stringify(requestFolder)} &&
        document.querySelector('.terminal-tab[data-tab-id="' + agent.shellId + '"]')))
    `))
  const captureRequest = await main.js(`window.electronAPI.agentMessagesSnapshot().then(({ agents, messages }) => {
    const agent = agents.find(agent => agent.cwd === ${JSON.stringify(requestFolder)})
    return messages.find(message => message.to === agent?.id)
  })`)
  const captureImage = captureRequest?.text.split('\n').find(line => path.isAbsolute(line) && line.endsWith('.png'))
  check('the new Claude inbox has the capture comment and a readable screenshot',
    captureRequest?.text.includes('새 세션에서 이 화면을 확인해 주세요.') && captureImage && fs.existsSync(captureImage))
  newCapture.close()

  // Closing a capture with Esc is not an error either (it used to report "Render frame was disposed")
  check('no capture reported an error, closed ones included', read('capture-error') === '', read('capture-error'))
  main.close()
  finish()
})().catch(error => { console.error(error); process.exit(1) })
