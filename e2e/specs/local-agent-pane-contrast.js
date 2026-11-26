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
// Restore the pre-card painting in the fixture while keeping the same live panes, geometry and states.
const beforeCardStyles = `
  .local-terminal-tab.is-split,
  .local-terminal-tab.is-split > .local-terminal-pane,
  .local-terminal-tab.is-split .agent-chat-cover {
    background-color: var(--terminal-bg, var(--bg-primary)) !important;
  }
  .local-terminal-tab.is-split > .pane-divider { background: var(--border) !important; }
  .local-terminal-tab.is-split > .local-terminal-pane {
    --pane-card-radius: 0px !important;
    --local-pane-focus: var(--pane-focus-color) !important;
    --local-pane-trace: var(--pane-trace-color) !important;
    box-shadow: none !important;
  }
  .local-terminal-tab.is-split > .local-terminal-pane:not(:focus-within, [data-agent-work='working'])::before,
  .local-terminal-tab.is-split .agent-chat-head::before { content: none !important; }
  .local-terminal-tab.is-split .agent-chat-head { border-bottom-color: var(--border) !important; }
`

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
  async function showChat(on, frame = pane) {
    const chat = frame + "?.querySelector('.agent-chat-cover')"
    if (Boolean(await js('!!' + chat)) !== on) {
      if (on && frame !== pane) {
        await click(...await center(frame), 'right')
        const item = "[...document.querySelectorAll('.terminal-menu-item')].find(button => button.textContent.startsWith('채팅으로 보기 ('))"
        await requireState(`!!${item} && !${item}.hasAttribute('data-disabled')`, 'the pane has no chat action')
        await click(...await center(item))
      } else {
        const input = on ? '.xterm-helper-textarea' : '.agent-chat-input'
        await js(`${frame}.querySelector(${JSON.stringify(input)}).focus()`)
        await press('F11', 'F11', 122, 10)
      }
      if (!await until((on ? '!!' : '!') + chat)) {
        const state = await js(`({ pane: ${frame}.dataset.pane, focus: document.activeElement?.className,
          toasts: [...document.querySelectorAll('.toast')].map(toast => toast.textContent) })`)
        throw new Error(`could not ${on ? 'open' : 'close'} the chat: ${JSON.stringify(state)}`)
      }
    }
  }
  async function setChatTheme(label, expected) {
    const button = cover + ".querySelector('.agent-chat-theme-trigger')"
    await click(...await center(button))
    const option = `[...document.querySelectorAll('.select-menu-content [role="menuitemradio"]')]
      .find(item => item.textContent.trim().startsWith(${JSON.stringify(label)}))`
    await requireState('!!' + option, 'the chat theme was not offered')
    await js(`(${option}).scrollIntoView({ block: 'nearest' })`)
    await click(...await center(option))
    await requireState(cover + (expected ? `?.dataset.chatTheme === ${JSON.stringify(expected)}` : '?.dataset.chatTheme === undefined'), 'the chat theme did not apply')
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
        const depths = sample === 'card' ? [-2, 0, 2]
          : sample === 'focus' ? [-1, 0, 2, 3] : [inset - 1, inset + 1, inset + 1, inset + 3]
        const points = edgePoints(info, edge, depths)
        const pixels = await pixelsOf(screenshot, points)
        if (sample === 'card') {
          const [gap, border, inside] = pixels
          info.contrast = [contrast([border, inside]), Math.max(contrast([border, gap]), contrast([inside, gap]))]
          info.gapContrast = contrast([inside, gap])
        } else {
          info.contrast = [contrast(pixels.slice(0, 2)), contrast(pixels.slice(2))]
        }
      }
    }
    return info
  }
  async function inspect(name, isChat, isSplit) {
    await setWorking(false)
    const input = isChat ? composer : terminal
    await js(input + '.blur()')
    if (isSplit && capture !== 'before') await checkCardEdge(name)
    else if (capture) await snapshot(name + '-idle')
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

  async function checkCardEdge(name) {
    const idle = await snapshot(name + '-idle', 'card')
    check(name + ' draws a 1px card edge with 3:1 contrast', idle.focus.width === '1px' &&
      Math.min(...idle.contrast) >= 3, JSON.stringify(idle.contrast))
    check(name + ' distinguishes the gap from the card surface', idle.gapContrast >= 1.3, idle.gapContrast.toFixed(2) + ':1')
  }

  async function compareCards(name, after) {
    await send('DOM.enable')
    await send('CSS.enable')
    const { frameTree } = (await send('Page.getFrameTree')).result
    const { styleSheetId } = (await send('CSS.createStyleSheet', { frameId: frameTree.frame.id })).result
    const setStyles = text => send('CSS.setStyleSheetText', { styleSheetId, text })
    let before
    try {
      await setStyles(beforeCardStyles)
      await requireState(`getComputedStyle(${pane}.parentElement.querySelector('.local-terminal-pane:not(:focus-within)')).boxShadow === 'none'`,
        'the comparison did not disable the card styling')
      before = await screenshotData()
    } finally {
      await setStyles('')
    }
    const comparison = await js(`(async () => {
      const bounds = ${pane}.parentElement.getBoundingClientRect()
      const round = n => Math.round(n * devicePixelRatio)
      const left = round(bounds.left), top = round(bounds.top)
      const width = round(bounds.right) - left, height = round(bounds.bottom) - top
      const margin = 26, gutter = 24, header = 55
      const canvas = new OffscreenCanvas(width * 2 + margin * 2 + gutter, height + header + margin)
      const ctx = canvas.getContext('2d')
      const dark = ${JSON.stringify(name === 'dark')}
      ctx.fillStyle = dark ? '#111318' : '#ecf0f4'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = dark ? '#e7ebf2' : '#1e2735'
      ctx.font = '700 22px "Malgun Gothic", sans-serif'
      const images = ${JSON.stringify([before, after])}
      for (const [index, label] of ['적용 전', '적용 후'].entries()) {
        const x = margin + index * (width + gutter)
        const bytes = Uint8Array.from(atob(images[index]), code => code.charCodeAt(0))
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        ctx.fillText(label, x, 36)
        ctx.drawImage(image, left, top, width, height, x, header, width, height)
        image.close()
      }
      const png = await canvas.convertToBlob({ type: 'image/png' })
      return new Promise(resolve => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result.split(',')[1])
        reader.readAsDataURL(png)
      })
    })()`)
    fs.writeFileSync(path.join(output, `local-agent-pane-cards-compare-${name}.png`), Buffer.from(comparison, 'base64'))
  }

  async function addAgentBelow(target, kind) {
    const mainTab = await js(`${pane}.dataset.localTabId`)
    const workTab = `.terminal-tab[data-tab-id=${JSON.stringify(mainTab)}]`
    await openLocalAgent(driver, kind, profile)
    const active = "document.querySelector('.terminal-tab.active')"
    await requireState(`${active}?.dataset.tabId && ${active}.dataset.tabId !== ${JSON.stringify(mainTab)}`, 'the extra agent did not open')
    const incoming = await js(`${active}.dataset.tabId`)
    const source = `.terminal-tab[data-tab-id=${JSON.stringify(incoming)}]`
    await requireState(`window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent =>
      agent.shellId === ${JSON.stringify(incoming)} && agent.active && agent.mcpConnected))`, 'the extra agent did not connect', 30000)
    await js(`document.querySelector(${JSON.stringify(workTab)}).click()`)
    await requireState(`${active}?.dataset.tabId === ${JSON.stringify(mainTab)}`, 'the grid tab did not return')
    const accepted = await js(`(async () => {
      const tab = document.querySelector(${JSON.stringify(source)})
      const frame = ${target}
      const rect = frame.getBoundingClientRect()
      const dataTransfer = new DataTransfer()
      const eventArgs = { bubbles: true, cancelable: true, dataTransfer, clientX: (rect.left + rect.right) / 2, clientY: rect.bottom - 64 }
      tab.dispatchEvent(new DragEvent('dragstart', eventArgs))
      await new Promise(resolve => setTimeout(resolve, 120))
      const drop = new DragEvent('drop', eventArgs)
      frame.dispatchEvent(drop)
      tab.dispatchEvent(new DragEvent('dragend', eventArgs))
      return drop.defaultPrevented
    })()`)
    if (!accepted) throw new Error('the grid did not accept the agent tab')
    const frame = `${pane}.parentElement.querySelector(${JSON.stringify(`[data-local-shell-id=${JSON.stringify(incoming)}]`)})`
    await requireState(`!!${frame}?.querySelector('.xterm-helper-textarea')`, 'the agent did not move below the selected pane')
    return frame
  }

  async function captureGrid() {
    const right = `${pane}.parentElement.querySelector('[data-pane="split-1"]')`
    const rightShell = await js(`${right}.dataset.localShellId`)
    await js(`window.electronAPI.localShellWrite(${JSON.stringify(rightShell)}, 'codex --yolo\\r')`)
    await requireState(`window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent =>
      agent.shellId === ${JSON.stringify(rightShell)} && agent.kind === 'codex' && agent.active))`, 'Codex did not start in the second pane', 30000)
    const lowerLeft = await addAgentBelow(pane, 'codex')
    const lowerRight = await addAgentBelow(right, 'claude')
    const grid = [pane, right, lowerLeft, lowerRight]
    check('the four panes are placed in a 2 × 2 grid with 6px between their cards', await js(`(() => {
      const [tl, tr, bl, br] = [${grid.join(', ')}].map(pane => pane.getBoundingClientRect())
      return [tr.left - tl.right, br.left - bl.right, bl.top - tl.bottom, br.top - tr.bottom]
        .every(gap => Math.abs(gap - 6) < 0.1) && Math.abs(bl.top - br.top) < 0.1
    })()`))

    for (const [index, frame] of grid.entries()) {
      const role = ['구조 검토', '기능 구현', '화면 시험', '문서 검토'][index]
      const note = ['분할 배치와 포커스 표시를 확인해 주세요.', '칸을 움직여도 셸이 유지되는지 확인해 주세요.',
        '밝은 화면과 어두운 화면을 캡처해 주세요.', '사용자 안내 문구를 정리해 주세요.'][index]
      await js(`window.electronAPI.agentMessagesSnapshot().then(state => {
        const agent = state.agents.find(item => item.shellId === ${frame}.dataset.localShellId && item.active)
        return window.electronAPI.agentMessageSetRole(agent.id, ${JSON.stringify(role)})
      })`)
      await showChat(true, frame)
      await js(`${frame}.querySelector('.agent-chat-input').focus()`)
      await send('Input.insertText', { text: note })
    }
    const scenes = [
      { name: 'light', app: ['Minimal Light', 'minimal-light'], chat: ['카톡 모드', 'chat-kakao'], radius: '0px' },
      { name: 'dark', app: ['macOS Dark', 'macos-dark'], chat: ['미드나잇', 'chat-midnight'], radius: '7px' }
    ]
    for (const scene of scenes) {
      await setAppTheme(...scene.app)
      await showChat(true, right)
      await showChat(true, lowerLeft)
      await setChatTheme(...scene.chat)
      await js('document.activeElement?.blur()')
      await checkCardEdge(scene.name + ' chat grid')
      await js(composer + '.focus()')
      await setWorking(true)
      check(`${scene.name} chat cards use their theme corners and 3px provider stripes`, await js(`
        [${grid.join(', ')}].every((frame, index) => {
          const head = frame.querySelector('.agent-chat-head')
          const stripe = getComputedStyle(head, '::before')
          const expected = ['rgb(217, 119, 87)', 'rgb(132, 154, 179)', 'rgb(132, 154, 179)', 'rgb(217, 119, 87)'][index]
          const header = getComputedStyle(head)
          const card = getComputedStyle(frame)
          return stripe.width === '3px' && stripe.left === '3px' && stripe.backgroundColor === expected &&
            header.borderBottomWidth === '1px' && card.borderRadius === ${JSON.stringify(scene.radius)} && card.boxShadow !== 'none' &&
            (frame.matches(':focus-within') || header.borderBottomColor === getComputedStyle(frame, '::before').borderBottomColor)
        })
      `))
      await js(trace + '.pause(); ' + trace + '.currentTime = ' + phase[2])
      await sleep(120)
      const save = async layout => fs.writeFileSync(path.join(output, `local-agent-pane-cards-${layout}-${scene.name}.png`), Buffer.from(await screenshotData(), 'base64'))
      const quad = await screenshotData()
      fs.writeFileSync(path.join(output, `local-agent-pane-cards-quad-${scene.name}.png`), Buffer.from(quad, 'base64'))
      await compareCards(scene.name, quad)
      await setWorking(false)
      await showChat(false, right)
      await showChat(false, lowerLeft)
      check(`${scene.name} mixed grid retains two terminal cards alongside the chats`, await js(`
        !${right}.hasAttribute('data-chat-kind') && !${lowerLeft}.hasAttribute('data-chat-kind') &&
        ${pane}.dataset.chatKind === 'claude' && ${lowerRight}.dataset.chatKind === 'claude'
      `))
      await js(composer + '.focus()')
      await setWorking(true)
      await sleep(150)
      await save('mixed')
      await setWorking(false)
      await js(trace + '.play()')
    }
    await setChatTheme('앱 테마 따르기')
    await js('document.activeElement?.blur()')
    await checkCardEdge('chat grid following the app theme')
    check('a chat following the app keeps the rounded card and matching work trace', await js(`
      getComputedStyle(${pane}).borderRadius === '7px' &&
      getComputedStyle(${pane}, '::after').borderRadius === '3px'
    `))
  }

  try {
    await unlock(driver)
    // These checks measure the light running around the border (도는 빛), one of the looks in 설정 > 테마 > 창 효과
    await driver.js(`localStorage.setItem('agent-work-style', 'trace'); document.documentElement.dataset.agentWorkStyle = 'trace'`)
    await send('Page.bringToFront')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await openLocalAgent(driver, 'claude', profile)
    await requireState("document.body.textContent.includes('fixture ready: claude-1') && " + pane + "?.dataset.agentWork", 'the fake Claude did not bind', 30000)
    await showChat(true)
    await setChatTheme('카톡 모드', 'chat-kakao')

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
        await inspect(id + '-' + layout + '-chat', true, layout === 'split')
        await showChat(false)
        await inspect(id + '-' + layout + '-terminal', false, layout === 'split')
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
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
      await captureGrid()
    }
    if (capture) fs.writeFileSync(path.join(output, 'pane-contrast-' + capture + '.json'), JSON.stringify(frames, null, 2))
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
