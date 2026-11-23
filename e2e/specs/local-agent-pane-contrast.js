// Capture the real pane edges. E2E_PANE_CAPTURE names an optional set of screenshots and geometry.
const fs = require('fs')
const path = require('path')
const { connect, createChecks, openLocalAgent, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const capture = process.env.E2E_PANE_CAPTURE
const output = process.env.E2E_OUT
const profile = process.env.E2E_PROFILE
const pane = "document.querySelector('.local-terminal-pane[data-pane=\"main\"]')"
const cover = pane + "?.querySelector('.agent-chat-cover')"
const composer = cover + "?.querySelector('.agent-chat-input')"
const terminal = pane + "?.querySelector('.xterm-helper-textarea')"
const phase = [630, 1530, 2430, 3330]
const edges = ['right', 'bottom', 'left', 'top']
const trace = "document.getAnimations().find(animation => animation.animationName === 'local-agent-trace' && animation.effect.target === " + pane + ")"

function contrast([first, second]) {
  const luminance = color => color.reduce((sum, channel, index) => {
    const srgb = channel / 255
    const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
    return sum + linear * [0.2126, 0.7152, 0.0722][index]
  }, 0)
  const [dark, light] = [luminance(first), luminance(second)].sort((a, b) => a - b)
  return (light + 0.05) / (dark + 0.05)
}

function edgePoints({ rect, dpr }, edge, depths) {
  const scale = css => Math.round(css * dpr)
  const x = scale((rect.left + rect.right) / 2)
  const y = scale((rect.top + rect.bottom) / 2)
  return depths.map(depth => {
    const offset = scale(depth)
    if (edge === 'right') return [scale(rect.right) - 1 - offset, y]
    if (edge === 'bottom') return [x, scale(rect.bottom) - 1 - offset]
    if (edge === 'left') return [scale(rect.left) + offset, y]
    return [x, scale(rect.top) + offset]
  })
}

;(async () => {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  const { center, click, js, send, until } = driver
  const frames = {}
  async function screenshotData() {
    const data = (await send('Page.captureScreenshot', { format: 'png' })).result?.data
    if (!data) throw new Error('the pane screenshot was empty')
    return data
  }
  const pixelsOf = (screenshot, points) => js("(async () => { const png = Uint8Array.from(atob(" + JSON.stringify(screenshot) + "), c => c.charCodeAt(0)); " +
    "const image = await createImageBitmap(new Blob([png], { type: 'image/png' })); " +
    "const canvas = new OffscreenCanvas(image.width, image.height); " +
    "const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0); image.close(); " +
    "return " + JSON.stringify(points) + ".map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3)); })()")
  async function requireState(condition, label, ms = 5000) {
    if (!await until(condition, ms)) throw new Error(label)
  }
  const press = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    const params = { key, code, windowsVirtualKeyCode, modifiers }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  async function showChat(on) {
    if (!on && await js("!!" + cover)) await js(composer + '.focus()')
    if (on && !await js("!!" + cover)) await js(terminal + '.focus()')
    if (Boolean(await js("!!" + cover)) !== on) {
      await press('F11', 'F11', 122, 10)
      await requireState((on ? '!!' : '!') + cover, 'the chat view did not toggle')
    }
  }
  async function setAppTheme(name, id) {
    await js(`document.querySelector('.title-bar-btn[title="설정"]').click()`)
    await requireState("!!document.querySelector('.theme-grid')", 'the theme settings did not open')
    await js("[...document.querySelectorAll('.theme-card-main')].find(button => " +
      "button.querySelector('.theme-name').textContent === " + JSON.stringify(name) + ").click()")
    await requireState("document.documentElement.dataset.theme === " + JSON.stringify(id), 'the app theme did not change')
    await press('Escape', 'Escape', 27)
    await requireState("!document.querySelector('.settings-modal')", 'the theme settings did not close')
  }
  async function setWorking(active) {
    fs.writeFileSync(path.join(profile, 'claude-1-program-status'), 'state=' + (active ? 'working' : 'idle') + ':app=claude')
    await requireState(pane + "?.dataset.agentWork === " + JSON.stringify(active ? 'working' : 'idle'), 'the fixture status did not reach the pane')
    await sleep(210)
  }
  async function snapshot(name, sample, edge = 'right') {
    const info = await js("(() => { const pane = " + pane + "; " +
      "const focus = getComputedStyle(pane, '::before'); const work = getComputedStyle(pane, '::after'); " +
      "return { rect: pane.getBoundingClientRect().toJSON(), dpr: devicePixelRatio, focused: pane.matches(':focus-within'), " +
      "focus: { content: focus.content, color: focus.borderTopColor, width: focus.borderTopWidth, shadow: focus.boxShadow }, " +
      "trace: { color: work.color, width: work.paddingTop, border: work.borderTopWidth, inset: work.top, opacity: work.opacity, angle: work.getPropertyValue('--local-agent-trace-angle'), background: work.backgroundImage, name: work.animationName } }; })()")
    if (capture || sample && capture !== 'before') {
      const screenshot = await screenshotData()
      if (capture) {
        frames[name] = info
        fs.writeFileSync(path.join(output, 'pane-contrast-' + capture + '-' + name + '.png'), Buffer.from(screenshot, 'base64'))
      }
      if (sample && capture !== 'before') {
        const inset = parseFloat(info.trace.inset)
        const depths = sample === 'focus' ? [-1, 0, 2, 3] : [inset - 1, inset + 1, inset + 1, inset + 3]
        const points = edgePoints(info, edge, depths)
        const pixels = await pixelsOf(screenshot, points)
        info.contrast = [contrast(pixels.slice(0, 2)), contrast(pixels.slice(2))]
      }
    }
    return info
  }
  async function inspect(name, isChat) {
    await setWorking(false)
    const input = isChat ? composer : terminal
    await js(input + '.blur()')
    if (capture) await snapshot(name + '-idle')
    await js(input + '.focus()')
    await requireState(pane + ".matches(':focus-within')", 'the pane input did not receive focus')
    const focused = await snapshot(name + '-focus', 'focus')
    if (capture !== 'before') check(name + ' has two contrasting focus strokes', focused.focus.width === '2px' &&
      focused.focus.shadow !== 'none' && Math.min(...focused.contrast) >= 3, JSON.stringify(focused.contrast))
    await setWorking(true)
    await requireState('!!' + trace, 'the working trace has no animation')
    let workingColor
    for (const [index, time] of phase.entries()) {
      await js("(() => { const trace = " + trace + "; trace.pause(); trace.currentTime = " + time + " })()")
      await sleep(40)
      const working = await snapshot(name + '-working-' + (index + 1), 'trace', edges[index])
      workingColor ??= working.trace.color
      if (capture !== 'before') check(name + ' paints contrasting working frame ' + (index + 1), working.trace.opacity === '1' &&
        parseFloat(working.trace.width) >= 3 && Math.min(...working.contrast) >= 3, JSON.stringify(working.contrast))
    }
    await js(input + '.blur()')
    await js(trace + '.currentTime = ' + phase[0])
    await sleep(210)
    const unfocused = await snapshot(name + '-working-unfocused', 'trace')
    if (capture !== 'before') check(name + ' works with focus elsewhere', !unfocused.focused && unfocused.trace.opacity === '1' &&
      unfocused.trace.color === workingColor && Math.min(...unfocused.contrast) >= 3, JSON.stringify(unfocused.contrast))
    await setWorking(false)
    await js(trace + '?.play()')
  }

  try {
    await unlock(driver)
    await send('Page.bringToFront')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await openLocalAgent(driver, 'claude', profile)
    await requireState("document.body.textContent.includes('fixture ready: claude-1') && " + pane + "?.dataset.agentWork", 'the fake Claude did not bind', 30000)
    await showChat(true)
    const themeButton = cover + ".querySelector('.agent-chat-theme-trigger')"
    await click(...await center(themeButton))
    const kakao = "[...document.querySelectorAll('.select-menu-content [role=\"menuitemradio\"]')].find(item => item.textContent.trim() === '카톡 모드')"
    await requireState('!!' + kakao, 'the Kakao preset was not offered')
    await click(...await center(kakao))
    await requireState(cover + "?.dataset.chatTheme === 'chat-kakao'", 'the Kakao preset did not apply')

    const appThemes = [['Minimal Dark', 'minimal-dark'], ['Minimal Light', 'minimal-light']]
    for (const layout of ['single', 'split']) {
      if (layout === 'split') {
        await showChat(false)
        await driver.menuPick(...await center(pane), '분할', '좌우 분할')
        await requireState("document.querySelectorAll('.local-terminal-pane').length === 2", 'the terminal did not split', 30000)
      }
      for (const [name, id] of appThemes) {
        await setAppTheme(name, id)
        await showChat(true)
        await inspect(id + '-' + layout + '-chat', true)
        await showChat(false)
        await inspect(id + '-' + layout + '-terminal', false)
      }
    }
    if (capture !== 'before') {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await js(terminal + '.focus()')
      // A CUP position past the terminal dimensions marks the bottom-right cell.
      const markerColor = [13, 137, 44]
      fs.writeFileSync(path.join(profile, 'claude-1-screen'), '\x1b[999;999H\x1b[38;2;' + markerColor.join(';') + 'm█\x1b[0m\x1b[1;1H')
      const cell = "[..." + pane + ".querySelectorAll('.xterm-rows span')].find(span => span.textContent === '█')"
      await requireState('!!(' + cell + ')', 'the last terminal cell did not render')
      const cellInfo = "(() => { const bounds = (" + cell + ").getBoundingClientRect(); const frame = " + pane + ".getBoundingClientRect(); " +
        "return { rightGap: frame.right - bounds.right, bottomGap: frame.bottom - bounds.bottom, " +
        "points: [0.15, 0.3, 0.5, 0.7, 0.85].map(offset => [Math.floor((bounds.left + bounds.width * offset) * devicePixelRatio), " +
        "Math.floor((bounds.top + bounds.bottom) / 2 * devicePixelRatio)]) }; })()"
      const idleCell = await js(cellInfo)
      await setWorking(true)
      const reduced = await snapshot('reduced-motion')
      check('reduced motion uses a visible static trace', reduced.trace.opacity === '1' && reduced.trace.name === 'none' && reduced.trace.border === '3px')
      const workingCell = await js(cellInfo)
      const screenshot = await screenshotData()
      const ink = await pixelsOf(screenshot, workingCell.points)
      const painted = ink.some(pixel => pixel.every((channel, index) => Math.abs(channel - markerColor[index]) < 8))
      const inset = parseFloat(reduced.trace.inset) + parseFloat(reduced.trace.border)
      check('focus and work stay clear of the last terminal row and column', painted &&
        workingCell.rightGap >= inset && workingCell.bottomGap >= inset &&
        JSON.stringify(workingCell) === JSON.stringify(idleCell), JSON.stringify({ idleCell, workingCell, ink }))
      if (capture) fs.writeFileSync(path.join(output, 'pane-contrast-' + capture + '-terminal-last-cell.png'), Buffer.from(screenshot, 'base64'))
    }
    if (capture) fs.writeFileSync(path.join(output, 'pane-contrast-' + capture + '.json'), JSON.stringify(frames, null, 2))
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
