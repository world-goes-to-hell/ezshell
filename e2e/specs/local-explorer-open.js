const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { connect, createChecks, pageProblems, pages, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const isFileWindow = page => page.url.includes('remoteFileMode=true')

async function freePort() {
  const probe = net.createServer().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise(resolve => probe.close(resolve))
  return port
}

;(async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP  Windows Explorer integration')
    return
  }
  const profile = path.join(process.env.E2E_PROFILE, 'explorer')
  fs.mkdirSync(profile)
  const markdown = path.join(profile, '탐색기 문서 #1.md')
  const queuedText = path.join(profile, '잠긴 동안.TXT')
  const log = path.join(profile, '두 번째 파일.log')
  const extensionless = path.join(profile, 'build-output')
  const largeLog = path.join(profile, 'large.log')
  const image = path.join(profile, '그림 #1.PNG')
  const binary = path.join(profile, 'binary.dat')
  fs.writeFileSync(markdown, '# 탐색기에서 열기\n')
  fs.writeFileSync(queuedText, 'Queued while locked')
  fs.writeFileSync(log, 'Opened in the same editor')
  fs.writeFileSync(extensionless, 'Text without an extension')
  fs.writeFileSync(largeLog, 'FIRST LINE\n' + 'INFO filling the log\n'.repeat(270000) + 'ERROR last line\n')
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  fs.writeFileSync(binary, Buffer.from([0, 0xff, 0]))

  const start = (file, ...args) => spawn(process.env.E2E_APP || require('electron'), [
    ...(process.env.E2E_APP ? [] : [path.resolve(__dirname, '../../out/main/index.js')]),
    `--user-data-dir=${profile}`, `--open-explorer-file=${file}`, ...args
  ], { stdio: 'ignore', windowsHide: true })
  async function forward(file) {
    const child = start(file)
    const timer = setTimeout(() => child.kill(), 10000)
    try {
      const [code] = await once(child, 'exit')
      return code === 0
    } finally {
      clearTimeout(timer)
    }
  }

  const port = await freePort()
  process.env.E2E_CDP = `http://127.0.0.1:${port}`
  const app = start(markdown, `--remote-debugging-port=${port}`)
  const connectPreview = file => connect(page => isFileWindow(page) && page.title === `${path.basename(file)} - ezShell`)
  let main, editor, logPreview, imagePreview
  try {
    main = await connect()
    if (!await main.until(`!!document.querySelector('input[type=password]')`)) throw new Error('Expected the initial lock screen')
    check('the second launch forwards its request and exits while the app is locked', await forward(queuedText))
    check('Explorer files wait for the master password', !(await pages()).some(isFileWindow))

    await unlock(main)
    editor = await connect(isFileWindow)
    const tab = file => `[...document.querySelectorAll('.remote-file-tab-select')].find(button => button.textContent.trim() === ${JSON.stringify(path.basename(file))})`
    const activeText = `document.querySelector('.remote-file-pane:not([hidden]) .cm-content')?.textContent`
    check('both the startup file and forwarded TXT open in the editor after unlock', await editor.until(`!!${tab(markdown)} && !!${tab(queuedText)} && ${activeText} === 'Queued while locked'`))
    await editor.js(`${tab(markdown)}.click()`)
    await editor.until(`${activeText}?.includes('# 탐색기에서 열기')`)
    await editor.js(`[...document.querySelectorAll('.remote-view-option')].find(button => button.textContent === '마크다운').click()`)
    check('the Markdown file can switch to the rendered document', await editor.until(`document.querySelector('.markdown-body h1')?.textContent === '탐색기에서 열기'`))

    check('a .log file opens in the same editor', await forward(log) && await editor.until(`${activeText} === 'Opened in the same editor'`))
    check('plain text opens even without an extension', await forward(extensionless) && await editor.until(`${activeText} === 'Text without an extension'`))
    check('opening the same file again selects its existing tab', await forward(markdown) && await editor.until(`${tab(markdown)}.getAttribute('aria-selected') === 'true'`) &&
      await editor.js(`document.querySelectorAll('.remote-file-tab-select').length === 4`) && (await pages()).filter(isFileWindow).length === 1)

    check('a binary file reports a readable error', await forward(binary) && await editor.until(`
      document.querySelector('.remote-file-pane:not([hidden]) [role=alert]')?.textContent.includes('UTF-8')`))

    if (!await forward(largeLog)) throw new Error('Could not forward the large log')
    logPreview = await connectPreview(largeLog)
    check('a large log opens a preview of the last part', await logPreview.until(`
      document.querySelector('.remote-file-banner')?.textContent.includes('마지막 1MB') &&
      document.querySelector('.cm-content')?.textContent.includes('INFO filling the log') &&
      !document.querySelector('[aria-label="실시간 보기"]')`))
    await logPreview.js(`document.querySelector('.cm-content').focus()`)
    await logPreview.type('TYPED')
    check('the large log preview is read-only', await logPreview.js(`!document.querySelector('.cm-content').textContent.includes('TYPED')`))

    if (!await forward(image)) throw new Error('Could not forward the PNG')
    imagePreview = await connectPreview(image)
    check('the PNG renders in the image preview', await imagePreview.until(`
      document.querySelector('.remote-file-image')?.naturalWidth === 1 &&
      document.querySelector('.remote-file-image')?.alt === ${JSON.stringify(path.basename(image))}`))

    const problems = (await Promise.all([editor, logPreview, imagePreview].map(pageProblems))).flat()
    check('the file windows have no console errors or CSP refusals', problems.length === 0, problems.join(' || '))
  } finally {
    main?.close()
    editor?.close()
    logPreview?.close()
    imagePreview?.close()
    if (app.exitCode === null && app.signalCode === null) {
      const exited = once(app, 'exit')
      app.kill()
      await exited
    }
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
