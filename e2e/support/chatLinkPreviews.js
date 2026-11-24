const fs = require('node:fs')
const path = require('node:path')
const { connect, findPage, sleep } = require('./driver')

const panel = `document.querySelector('.chat-link-preview')`
const backdrop = `document.querySelector('.chat-link-preview-overlay')`
const inPanel = selector => `${panel}?.querySelector(${JSON.stringify(selector)})`
const closeButton = inPanel('[aria-label="미리보기 닫기"]')
const divider = inPanel('[role="separator"]')

async function openPreview({ driver, cover, href, name, pointer = true }) {
  const { js, until, click, center } = driver
  const anchor = `[...${cover}.querySelectorAll(${JSON.stringify(`.agent-chat-md a[href="${href}"]`)})].at(-1)`
  if (!await until(`!!${anchor}`)) throw new Error(`The preview link was not rendered (${href})`)
  await js(`${anchor}.scrollIntoView({ block: 'center' })`)
  if (pointer) await click(...await center(anchor))
  else await js(`(() => {
    const link = ${anchor}
    window.chatPreviewOpener = link
    link.focus({ preventScroll: true })
    link.click()
  })()`)
  const heading = inPanel('.chat-link-preview-heading h2')
  if (!await until(`${heading}?.textContent === ${JSON.stringify(name)}`)) {
    throw new Error(`The preview did not open (${name}): ${await js(`${panel}?.textContent ?? ''`)}`)
  }
  return pointer ? anchor : 'window.chatPreviewOpener'
}

async function checkChatLinkPreviews({ driver, cover, shellId, profile, addAnswer, check }) {
  const { js, until, send, click, center, shot } = driver
  const folder = path.join(profile, 'preview')
  fs.mkdirSync(path.join(folder, 'release'), { recursive: true })
  fs.copyFileSync(path.resolve(__dirname, '../../assets/icon.png'), path.join(folder, 'workspace.png'))
  fs.writeFileSync(path.join(folder, 'release', 'steps.md'), [
    '# 배포 전 확인', '', '테스트 결과와 복구 절차를 검토합니다.', '',
    '- 변경 목록 확인', '- 릴리스 노트 작성', '', '![구성도](https://example.invalid/diagram.png)', '', '<b>HTML은 본문으로 표시</b>'
  ].join('\n'))
  fs.writeFileSync(path.join(folder, 'release', 'release.json'), '{"ready": true}\n')
  fs.mkdirSync(path.join(folder, 'release', 'notes'))
  fs.writeFileSync(path.join(folder, 'script.js'), Array.from({ length: 100 }, (_, index) => `const step${index + 1} = ${index + 1};`).join('\n'))
  fs.writeFileSync(path.join(folder, 'large.log'), '')
  fs.truncateSync(path.join(folder, 'large.log'), 3 * 1024 * 1024)
  fs.writeFileSync(path.join(folder, 'release.pdf'), [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
    'trailer<</Root 1 0 R>>', '%%EOF', ''
  ].join('\n'))
  const webPath = 'mockups/byte-daemon.html'
  fs.mkdirSync(path.join(profile, 'mockups'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'mockups', 'byte-daemon.html'), '<!doctype html><title>Byte Daemon</title>' +
    '<link rel="stylesheet" href="../preview/site.css"><h1>Byte Daemon</h1>')
  fs.writeFileSync(path.join(folder, 'site.css'), 'h1 { color: rgb(24, 106, 187); }')

  addAnswer('파일을 확인해 주세요.\n\n' +
    '[이미지](preview/workspace.png) · [코드 72행](preview/script.js:72) · [마크다운](preview/release/steps.md) · ' +
    '[폴더](preview/release/) · [큰 로그](preview/large.log) · [PDF](preview/release.pdf) · ' + `\`${webPath}\``)
  const open = (href, name) => openPreview({ driver, cover, href, name })
  const close = async () => {
    await click(...await center(closeButton))
    if (!await until(`!${panel}`)) throw new Error('The preview close button did not dismiss the drawer')
  }
  const key = async (key, windowsVirtualKeyCode, modifiers = 0) => {
    const event = { key, code: key, windowsVirtualKeyCode, modifiers }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }

  await send('Page.bringToFront')
  const originalChatWidth = await js(`${cover}.offsetWidth`)
  const anchor = await open('preview/workspace.png', 'workspace.png')
  check('the image opens in an app-wide dialog without changing the wide chat layout', await until(`
    ${originalChatWidth} > 650 && ${cover}.offsetWidth === ${originalChatWidth} &&
    ${inPanel('img')}?.naturalWidth > 0 && ${panel}.parentElement === document.body &&
    ${panel}.getAttribute('aria-modal') === 'true' && ${panel}.getBoundingClientRect().right === innerWidth &&
    ${panel}.getBoundingClientRect().top === document.querySelector('.title-bar').getBoundingClientRect().bottom &&
    ${panel}.getBoundingClientRect().bottom === document.querySelector('.app-footer').getBoundingClientRect().top &&
    getComputedStyle(${panel}).getPropertyValue('--bg-primary') === getComputedStyle(${cover}).getPropertyValue('--bg-primary')
  `), String(originalChatWidth))
  const image = inPanel('img')
  check('the drawer shows the icon at its original size', await until(`(() => {
    const image = ${image}
    if (!image?.naturalWidth) return false
    const bounds = image.getBoundingClientRect()
    return bounds.width === image.naturalWidth && bounds.height === image.naturalHeight
  })()`))
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  try {
    const motion = `(() => {
      const style = getComputedStyle(${backdrop})
      return [matchMedia('(prefers-reduced-motion: reduce)').matches, style.animationName, style.transitionProperty]
    })()`
    check('reduced motion disables the backdrop animation and transition', await until(`(() => {
      const [reduced, animation, transition] = ${motion}
      return reduced && animation === 'none' && transition === 'none'
    })()`, 3000), JSON.stringify(await js(motion)))
    check('the backdrop gives dark themes a stronger dim', await js(`(() => {
      const overlay = ${backdrop}
      const previous = overlay.style.colorScheme
      const ctx = document.createElement('canvas').getContext('2d')
      const dim = scheme => {
        overlay.style.colorScheme = scheme
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = getComputedStyle(overlay).backgroundColor
        ctx.fillRect(0, 0, 1, 1)
        const [red, green, blue, alpha] = ctx.getImageData(0, 0, 1, 1).data
        return red === 0 && green === 0 && blue === 0 ? alpha / 255 : 0
      }
      try {
        const light = dim('light')
        const dark = dim('dark')
        return light >= 0.3 && dark > light && dark >= 0.5 && dark < 0.6
      } finally {
        overlay.style.colorScheme = previous
      }
    })()`))
  } finally {
    await send('Emulation.setEmulatedMedia', { features: [] })
  }
  await until(`getComputedStyle(${backdrop}).opacity === '1'`)
  await shot('local-agent-chat-preview-wide')
  check('the drawer initially focuses its close button', await until(`document.activeElement === ${closeButton}`))
  await key('Tab', 9, 8)
  check('Shift+Tab wraps from the first control to the divider', await until(`document.activeElement === ${divider}`))
  await key('Tab', 9)
  check('Tab wraps from the divider to the first control', await until(`document.activeElement === ${closeButton}`))
  await js(`${anchor}.focus()`)
  check('the dialog keeps focus when a background control tries to take it', await until(`${panel}.contains(document.activeElement)`))
  const originalWidth = await js(`${panel}.offsetWidth`)
  await js(`${divider}.focus()`)
  await key('ArrowLeft', 37)
  check('the keyboard adjusts the drawer width', await until(`${panel}.offsetWidth === ${originalWidth} + 24`))
  const [x, y] = await center(divider)
  await driver.move(x, y)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  for (const step of [24, 48, 72]) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - step, y, button: 'left', buttons: 1 })
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 72, y, button: 'left', buttons: 0, clickCount: 1 })
  check('dragging the left edge resizes only the drawer', await until(`
    ${panel}.offsetWidth === ${originalWidth} + 96 && ${cover}.offsetWidth === ${originalChatWidth}
  `, 2500), JSON.stringify({ before: originalWidth, after: await js(`${panel}?.offsetWidth`) }))
  const [resetX, resetY] = await center(divider)
  for (const clickCount of [1, 2]) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: resetX, y: resetY, button: 'left', buttons: 1, clickCount })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: resetX, y: resetY, button: 'left', clickCount })
  }
  check('double-clicking the divider restores the default width', await until(`${panel}.offsetWidth === ${originalWidth}`))
  await close()

  await open('preview/script.js:72', 'script.js')
  check('the code drawer reveals its requested line with syntax colors', await until(`
    ${inPanel('.cm-revealed-line')}?.textContent.includes('step72') &&
    !!${inPanel('.cm-revealed-line span')}
  `))
  await shot('local-agent-chat-preview-code')
  await close()

  await open('preview/release/steps.md', 'steps.md')
  check('the Markdown preview renders headings and safe image and HTML placeholders', await until(`
    ${inPanel('.markdown-body h1')}?.textContent === '배포 전 확인' &&
    ${inPanel('.md-image')}?.textContent.includes('구성도') && !${inPanel('.markdown-body img, .markdown-body b')}
  `))
  await shot('local-agent-chat-preview-markdown')
  await close()

  await open('preview/release/', 'release')
  check('the linked folder shows its children', await until(`
    ${inPanel('.chat-link-preview-directory')}?.textContent.includes('release.json') &&
    ${inPanel('.chat-link-preview-directory')}?.textContent.includes('notes')
  `))
  await shot('local-agent-chat-preview-folder')
  await close()

  await open('preview/large.log', 'large.log')
  check('the large file keeps its actions and shows the empty preview', await until(`
    ${inPanel('.chat-link-preview-empty')}?.textContent.includes('미리보기 없음') &&
    ${inPanel('.chat-link-preview-actions')}?.querySelectorAll('button').length === 3
  `))
  await shot('local-agent-chat-preview-large')
  await close()

  await open('preview/release.pdf', 'release.pdf')
  check('the PDF gets a typed blob frame', await until(`${inPanel('iframe')}?.src.startsWith('blob:')`))
  let pdfFrame = false
  for (let attempt = 0; attempt < 30 && !pdfFrame; attempt++) {
    const tree = (await send('Page.getFrameTree')).result?.frameTree
    pdfFrame = tree?.childFrames?.some(child => child.frame.url.startsWith('blob:') && child.frame.mimeType === 'application/pdf') ?? false
    if (!pdfFrame) await sleep(100)
  }
  check('the PDF frame loads inside the drawer', pdfFrame)
  await close()
  const escapeAnchor = await open('preview/workspace.png', 'workspace.png')
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 360, deviceScaleFactor: 1, mobile: false })
  try {
    check('the drawer defaults to 480px in a narrow window', await until(`innerWidth === 760 && ${panel}.offsetWidth === 480`))
    check('an image larger than the available height shrinks proportionally', await until(`(() => {
      const image = ${image}
      if (!image?.naturalWidth) return false
      const bounds = image.getBoundingClientRect()
      return bounds.height > 0 && bounds.height < image.naturalHeight &&
        Math.abs(bounds.width / bounds.height - image.naturalWidth / image.naturalHeight) < 0.01
    })()`))
    await js(`${divider}.focus()`)
    await key('End', 35)
    check('the maximum width leaves room for the backdrop in a narrow window', await until(`${panel}.offsetWidth === 736`))
  } finally {
    await send('Emulation.clearDeviceMetricsOverride')
  }
  await key('Escape', 27)
  check('Escape closes the preview and returns focus to the clicked link', await until(`!${panel} && document.activeElement === ${escapeAnchor}`))
  const backdropAnchor = await open('preview/workspace.png', 'workspace.png')
  await click(12, 95)
  check('clicking the backdrop closes the preview and restores focus', await until(`!${panel} && document.activeElement === ${backdropAnchor}`))
  const missing = await js(`window.electronAPI.agentChatLinkPreview(${JSON.stringify(shellId)}, 'preview/not-in-chat.txt')`)
  check('the preview IPC rejects a path the conversation did not show', missing?.ok === false)

  const webAnchor = await open(webPath, 'byte-daemon.html')
  const browserButton = `[...${panel}.querySelectorAll('.chat-link-preview-actions button')].find(b => b.textContent.trim() === '브라우저로 열기')`
  const closeBrowserTab = async () => {
    const target = await findPage(page => page.url.startsWith('ezshell-workspace://') && page.url.endsWith(`/${webPath}`), 8000)
    if (!target) throw new Error('The chat document did not open in the workspace browser')
    const page = await connect(p => p.id === target.id)
    try {
      check('the browser renders the HTML and its relative stylesheet in an isolated tab', await page.until(`
        document.querySelector('h1')?.textContent === 'Byte Daemon' &&
        getComputedStyle(document.querySelector('h1')).color === 'rgb(24, 106, 187)' &&
        typeof window.electronAPI === 'undefined'
      `))
    } finally { page.close() }
    const browserTab = `.terminal-tab[data-tab-id="browser:${new URL(target.url).host}"]`
    check('the file drawer closes and the browser tab becomes active', await until(`!${panel} && document.querySelector(${JSON.stringify(browserTab)}).classList.contains('active')`))
    await js(`document.querySelector(${JSON.stringify(`${browserTab} .tab-close`)}).click()`)
    await until(`!!${webAnchor} && ${webAnchor}.checkVisibility({ visibilityProperty: true })`)
  }
  await click(...await center(browserButton))
  await closeBrowserTab()
  await js(`${webAnchor}.scrollIntoView({ block: 'center' })`)
  await click(...await center(webAnchor), 'right')
  await driver.pick('브라우저로 열기')
  await closeBrowserTab()
}

async function checkSplitChatLinkPreview({ driver, cover, browserTabId, profile, check }) {
  const { js, until, click, center, shot } = driver
  const browser = JSON.stringify(`.terminal-tab[data-tab-id="${browserTabId}"]`)
  await js(`(() => {
    const tab = document.querySelector(${browser})
    const dataTransfer = new DataTransfer()
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    window.previewSplitDrag = { tab, dataTransfer }
  })()`)
  await js(`(() => {
    const area = document.querySelector('.terminal-area')
    const rect = area.getBoundingClientRect()
    area.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.previewSplitDrag.dataTransfer,
      clientX: rect.right - 15, clientY: rect.top + rect.height / 2 }))
  })()`)
  if (!await until(`!!document.querySelector('.drop-zone-right.active')`)) throw new Error('The browser tab did not reach the right split zone')
  await js(`(() => {
    const { tab, dataTransfer } = window.previewSplitDrag
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
    delete window.previewSplitDrag
  })()`)

  const splitClose = `document.querySelector('.split-pane-tab-item[data-tab-id="${browserTabId}"] .split-pane-tab-close')`
  if (!await until(`!!${splitClose} && !!${cover}`)) throw new Error('The browser and chat did not open in separate screens')
  await js(`${cover}.closest('.split-pane').querySelector('.split-pane-tab-item.active').click()`)
  const nativeState = path.join(profile, 'chat-preview-browser-visible')
  const browserIsVisible = async expected => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (fs.existsSync(nativeState) && fs.readFileSync(nativeState, 'utf8') === String(expected)) return true
      await sleep(100)
    }
    return false
  }
  check('the split browser page is visible before opening the preview', await browserIsVisible(true))
  const originalChatWidth = await js(`${cover}.offsetWidth`)
  // CDP pointer events to the main renderer can be lost while a native child view owns input.
  const anchor = await openPreview({ driver, cover, href: 'preview/workspace.png', name: 'workspace.png', pointer: false })
  check('the narrow chat keeps its width and the drawer extends over the neighbouring screen', await until(`
    ${originalChatWidth} < 650 && ${cover}.offsetWidth === ${originalChatWidth} &&
    ${inPanel('img')}?.naturalWidth > 0 && ${panel}.offsetWidth === Math.round(Math.max(480, Math.min(innerWidth * 0.55, 1100))) &&
    ${panel}.getBoundingClientRect().right > ${cover}.getBoundingClientRect().right
  `), String(originalChatWidth))
  check('the drawer hides the browser WebContentsView', await browserIsVisible(false))
  await until(`getComputedStyle(${backdrop}).opacity === '1'`)
  await shot('local-agent-chat-preview-narrow')
  await click(...await center(closeButton))
  check('the close button restores focus to the split chat link or its composer', await until(`
    !${panel} && (document.activeElement === ${anchor} ||
      (!${anchor}.isConnected && document.activeElement === ${cover}.querySelector('.agent-chat-input')))
  `))
  await js('delete window.chatPreviewOpener')
  check('closing the drawer restores the browser WebContentsView', await browserIsVisible(true))
  await js(`${splitClose}.click()`)
  await until(`!${splitClose} && !!${cover}`)
}

module.exports = { checkChatLinkPreviews, checkSplitChatLinkPreview }
