const fs = require('node:fs')
const path = require('node:path')
const { sleep } = require('./driver')

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

  addAnswer('파일을 확인해 주세요.\n\n' +
    '[이미지](preview/workspace.png) · [코드 72행](preview/script.js:72) · [마크다운](preview/release/steps.md) · ' +
    '[폴더](preview/release/) · [큰 로그](preview/large.log) · [PDF](preview/release.pdf)')
  const panel = `${cover}.querySelector('.chat-link-preview')`
  const inPanel = selector => `${panel}?.querySelector(${JSON.stringify(selector)})`
  const open = async (href, name) => {
    const anchor = `${cover}.querySelector(${JSON.stringify(`.agent-chat-md a[href="${href}"]`)})`
    if (!await until(`!!${anchor}`)) throw new Error(`The preview link was not rendered (${href})`)
    await js(`${anchor}.scrollIntoView({ block: 'nearest' })`)
    await click(...await center(anchor))
    const heading = inPanel('.chat-link-preview-heading h2')
    if (!await until(`${heading}?.textContent === ${JSON.stringify(name)}`)) {
      throw new Error(`The preview did not open (${name}): ${await js(`${panel}?.textContent ?? ''`)}`)
    }
    return anchor
  }
  const key = async (key, windowsVirtualKeyCode) => {
    const event = { key, code: key, windowsVirtualKeyCode }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }

  await send('Page.bringToFront')
  await open('preview/workspace.png', 'workspace.png')
  check('the file link opens an image beside the chat', await until(`
    ${inPanel('img')}?.naturalWidth > 0 && ${panel}.getBoundingClientRect().left > ${cover}.getBoundingClientRect().left
  `))
  await js(`window.firstChatPreview = ${panel}`)
  await shot('local-agent-chat-preview-image')
  const originalWidth = await js(`${panel}.offsetWidth`)
  await js(`${inPanel('[role="separator"]')}.focus()`)
  await key('ArrowLeft', 37)
  check('the preview divider resizes the panel', await until(`${panel}.offsetWidth > ${originalWidth}`))

  await open('preview/script.js:72', 'script.js')
  check('another link replaces the same panel and reveals its code line with syntax colors', await until(`
    ${panel} === window.firstChatPreview &&
    ${inPanel('.cm-revealed-line')}?.textContent.includes('step72') &&
    !!${inPanel('.cm-revealed-line span')}
  `))
  await shot('local-agent-chat-preview-code')

  await open('preview/release/steps.md', 'steps.md')
  check('the Markdown preview renders headings and safe image and HTML placeholders', await until(`
    ${inPanel('.markdown-body h1')}?.textContent === '배포 전 확인' &&
    ${inPanel('.md-image')}?.textContent.includes('구성도') && !${inPanel('.markdown-body img, .markdown-body b')}
  `))
  await shot('local-agent-chat-preview-markdown')

  await open('preview/release/', 'release')
  check('the linked folder shows its children', await until(`
    ${inPanel('.chat-link-preview-directory')}?.textContent.includes('release.json') &&
    ${inPanel('.chat-link-preview-directory')}?.textContent.includes('notes')
  `))
  await shot('local-agent-chat-preview-folder')

  await open('preview/large.log', 'large.log')
  check('the large file keeps its actions and shows the empty preview', await until(`
    ${inPanel('.chat-link-preview-empty')}?.textContent.includes('미리보기 없음') &&
    ${inPanel('.chat-link-preview-actions')}?.querySelectorAll('button').length === 3
  `))
  await shot('local-agent-chat-preview-large')

  await open('preview/release.pdf', 'release.pdf')
  check('the PDF gets a typed blob frame', await until(`${inPanel('iframe')}?.src.startsWith('blob:')`))
  let pdfFrame = false
  for (let attempt = 0; attempt < 30 && !pdfFrame; attempt++) {
    const tree = (await send('Page.getFrameTree')).result?.frameTree
    pdfFrame = tree?.childFrames?.some(child => child.frame.url.startsWith('blob:') && child.frame.mimeType === 'application/pdf') ?? false
    if (!pdfFrame) await sleep(100)
  }
  check('the PDF frame loads inside the chat', pdfFrame)
  const anchor = await open('preview/workspace.png', 'workspace.png')
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 780, deviceScaleFactor: 1, mobile: false })
  try {
    check('the preview covers a narrow chat pane', await until(`getComputedStyle(${panel}).position === 'absolute' &&
      getComputedStyle(${inPanel('[role="separator"]')}).display === 'none'`))
  } finally {
    await send('Emulation.clearDeviceMetricsOverride')
  }
  await key('Escape', 27)
  check('Escape closes the preview and returns focus to the clicked link', await until(`!${panel} && document.activeElement === ${anchor}`))
  await js('delete window.firstChatPreview')
  const missing = await js(`window.electronAPI.agentChatLinkPreview(${JSON.stringify(shellId)}, 'preview/not-in-chat.txt')`)
  check('the preview IPC rejects a path the conversation did not show', missing?.ok === false)
}

module.exports = { checkChatLinkPreviews }
