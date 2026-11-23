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
  const waitFor = async test => {
    for (let i = 0; i < 100; i++) {
      if (await test()) return true
      await sleep(100)
    }
    return false
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
    await drag(overlay, from, to)
    if (!(await overlay.until('document.activeElement.id === "comment"', 3000))) {
      throw new Error('region was not selected: ' + await overlay.js(`JSON.stringify({
        focus: document.activeElement.id, screen: [innerWidth, innerHeight], state: { ...document.body.dataset },
        selection: document.querySelector('#selection').style.cssText
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
  fs.writeFileSync(file('capture-hold'), '')
  fs.writeFileSync(file('capture-request'), '')
  if (!(await waitFor(() => fs.existsSync(file('capture-opening'))))) throw new Error('Capture did not begin loading')
  fs.writeFileSync(file('capture-cancel'), '')
  if (!(await waitFor(() => !fs.existsSync(file('capture-cancel'))))) throw new Error('Cancel signal was not read')
  fs.unlinkSync(file('capture-hold'))
  await sleep(300)
  check('Esc reported while the display is loading prevents the overlay from appearing', !(await pages()).some(isOverlay))

  fs.writeFileSync(file('capture-request'), '')
  const beforeSelection = await connect(isOverlay)
  if (!(await beforeSelection.until('document.hasFocus() && !document.body.hasAttribute("data-review")'))) {
    throw new Error('New capture overlay did not receive focus')
  }
  // The window can close before CDP acknowledges the Escape key.
  void beforeSelection.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {})
  check('Escape closes a new capture before any click or selection', await waitFor(async () => !(await pages()).some(isOverlay)))
  beforeSelection.close()
  check('cancelling a new capture leaves the clipboard alone', !fs.existsSync(file('capture-copied')))

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

  await openLocalAgent(main, 'codex', service)
  await openLocalAgent(main, 'claude', tools)
  if (!(await waitFor(() => read('codex-1-tools') && read('claude-2-tools')))) throw new Error('fake agents did not start')

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
    Array.from(document.querySelector('#project').options).map(option => option.text).join('|') === '프로젝트를 선택하세요|service|tools' &&
    !document.querySelector('.agent')
  `) && !read('codex-1-chat-sent') && !read('claude-2-chat-sent'), await overlay.js(`Array.from(document.querySelector('#project').options).map(option => option.text).join('|') + ' agents=' + document.querySelectorAll('.agent').length`))
  await chooseProject(overlay, tools)
  check('the chosen project shows only its agent', await overlay.until(`
    document.querySelectorAll('.agent').length === 1 && document.querySelector('.agent').textContent.includes('claude-2')
  `))
  await clickButton(overlay, '#back')
  check('back preserves the region and comment', await overlay.js(`
    !document.querySelector('#selection').hidden && document.querySelector('#comment').value === ${JSON.stringify(comment)}
  `))
  await clickButton(overlay, '#work')
  await overlay.until('!document.querySelector("#picker").hidden')
  await chooseProject(overlay, service)
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
  main.close()
  finish()
})().catch(error => { console.error(error); process.exit(1) })
