const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { connect, createChecks, openLocalAgent, pages, sleep, unlock } = require('../support/driver')
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
  const openCapture = async comment => {
    fs.writeFileSync(file('capture-request'), '')
    const overlay = await connect(isOverlay)
    const { send, js, until, type } = overlay
    if (!(await until('document.hasFocus() && typeof window.chooseCaptureTarget === "function"'))) throw new Error('capture was not ready')
    const end = await js('[Math.floor(innerWidth / 2), Math.floor(innerHeight / 2)]')
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 100, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: end[0], y: end[1], button: 'left', buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end[0], y: end[1], button: 'left', buttons: 0, clickCount: 1 })
    if (!(await until('document.activeElement.id === "comment"', 3000))) {
      throw new Error('region was not selected: ' + await js(`JSON.stringify({
        focus: document.activeElement.id, screen: [innerWidth, innerHeight], state: { ...document.body.dataset },
        selection: document.querySelector('#selection').style.cssText
      })`))
    }
    await type(comment)
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

  const service = file('service')
  const tools = file('tools')
  fs.mkdirSync(service)
  fs.mkdirSync(tools)
  await unlock(main)
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
  await drag(overlay, [140, 140], [320, 260])
  await clickButton(overlay, '[data-tool="box"]')
  await drag(overlay, [160, 280], [300, 340])
  check('two marks can be undone and redone', await overlay.js('!document.querySelector("#undo").disabled'))
  await clickButton(overlay, '#undo')
  check('undo takes back the last mark', await overlay.js('!document.querySelector("#redo").disabled'))
  await clickButton(overlay, '#redo')
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

  const second = await openCapture('Claude에게 보낼 코멘트')
  await clickButton(second, '[data-tool="badge"]')
  await second.click(200, 200)
  check('a numbered badge adds its line to the comment', await second.until(`
    document.querySelector('#comment').value === ${JSON.stringify('Claude에게 보낼 코멘트' + String.fromCharCode(10) + '1. ')}
  `))
  await second.js(`document.querySelector('#comment').value = 'Claude에게 보낼 코멘트'`)
  await clickButton(second, 'button[data-tool="text"]')
  await second.click(240, 150)
  check('the text tool opens a field where it was clicked', await second.until('document.activeElement?.classList.contains("ink-text")', 3000))
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
    return fs.existsSync(image) && text === 'Claude에게 보낼 코멘트' && read('codex-1-chat-sent') === '1'
  }))
  second.close()
  main.close()
  finish()
})().catch(error => { console.error(error); process.exit(1) })
