// Server file windows opened from the SFTP list: text preview, edit (CodeMirror), live view, image
// and PDF preview. Each must show its content without console errors or Content Security Policy
// refusals (the PDF is a blob: URL in an iframe, the editor loads lazily): the things a Chromium
// change is most likely to break. Run by e2e/run.js with the test server (its /var holds old.txt,
// doc.pdf and pic.png).
const { sleep, createChecks, connect, pages, findPage, unlock, connectSsh, pageProblems } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const main = await connect()
  const { js, until, center, menuPick, shot } = main

  const row = (name) => `[...document.querySelectorAll('.sftp-panel .remote-pane .file-item')].find(r => r.textContent.trim().startsWith(${JSON.stringify(name)}))`
  /** Right-click a server file and choose a menu item; resolves with the window that opens */
  const openFrom = async (name, label) => {
    const known = new Set((await pages()).map((p) => p.id))
    await js(`(() => { const r = ${row(name)}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: b.left + 40, clientY: b.top + b.height / 2 })) })()`)
    const item = `[...document.querySelectorAll('.sftp-context-menu .context-menu-item')].find(i => i.querySelector('.context-menu-label')?.textContent === ${JSON.stringify(label)})`
    if (!(await until(`!!${item}`, 4000))) {
      console.log('  menu has:', await js(`[...document.querySelectorAll('.sftp-context-menu .context-menu-label')].map(l => l.textContent).join(', ')`))
      await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
      return null
    }
    await js(`${item}.click()`)
    const target = await findPage((t) => t.url.includes('remoteFileMode') && !known.has(t.id), 15000)
    return target ? connect((t) => t.id === target.id) : null
  }
  const closeAll = async () => {
    for (const page of await pages()) {
      if (!page.url.includes('remoteFileMode')) continue
      try { await fetch(`${process.env.E2E_CDP}/json/close/${page.id}`) } catch { /* already gone */ }
    }
    await sleep(600)
  }
  const noProblems = async (page, what) => {
    const problems = await pageProblems(page)
    check(`${what}: no console errors or CSP refusals`, problems.length === 0, problems.join(' || '))
  }

  await unlock(main)
  check('an SSH tab connects to the test server', await connectSsh(main))

  // The SFTP panel at the terminal's folder (/var)
  const term = await center(`document.querySelector('.terminal-container:not(.split-terminal) .xterm-screen')`)
  await menuPick(term[0], term[1] - 60, '편의', 'SFTP 를 현재 폴더로')
  check('the SFTP panel lists /var', await until(`!!${row('old.txt')} && !!${row('doc.pdf')} && !!${row('pic.png')}`, 15000), String(await js(`[...document.querySelectorAll('.sftp-panel .remote-pane .file-item')].map(r => r.textContent.trim().slice(0, 16)).join(' | ')`)))

  // ---- Text preview ----
  let page = await openFrom('old.txt', '미리보기')
  check('미리보기 opens a window', !!page)
  if (page) {
    check('it shows the file text', await page.until(`(document.querySelector('.cm-content')?.textContent || '').includes('old')`, 20000), String(await page.js(`(document.body.innerText || '').slice(0, 200)`)))
    // Read-only in CodeMirror keeps the text selectable (still contenteditable): typing is what must not work
    await page.send('Page.bringToFront')
    await page.js(`document.querySelector('.cm-content').focus()`)
    await page.type('TYPED')
    await sleep(400)
    check('it is read-only (typing changes nothing)', await page.js(`!(document.querySelector('.cm-content')?.textContent || '').includes('TYPED')`))
    await noProblems(page, 'text preview')
    await page.shot('ssh-remote-file-1-preview')
    page.close()
  }
  await closeAll()

  // ---- Edit ----
  page = await openFrom('old.txt', '편집')
  check('편집 opens a window', !!page)
  if (page) {
    check('the editor shows the file text', await page.until(`(document.querySelector('.cm-content')?.textContent || '').includes('old')`, 20000), String(await page.js(`(document.body.innerText || '').slice(0, 200)`)))
    check('with syntax-highlighting styles in place (CodeMirror mounted its theme)', await page.js(`!!document.querySelector('.cm-editor .cm-scroller .cm-line')`))
    check('and can be typed in', await page.js(`document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true'`))
    await page.send('Page.bringToFront')
    await page.js(`document.querySelector('.cm-content').focus()`)
    await page.type('EDITED')
    check('typing changes the document', await page.until(`(document.querySelector('.cm-content')?.textContent || '').includes('EDITED')`, 5000))
    await noProblems(page, 'editor')
    await page.shot('ssh-remote-file-2-edit')
    page.close()
  }
  // The edit window asks before closing with unsaved text: leave it for the app's exit

  // ---- Live view ----
  page = await openFrom('old.txt', '실시간 보기')
  check('실시간 보기 opens a window', !!page)
  if (page) {
    check('it shows the file text', await page.until(`(document.querySelector('.cm-content')?.textContent || '').includes('old')`, 20000), String(await page.js(`(document.body.innerText || '').slice(0, 200)`)))
    check('and says it is following the file', await page.until(`!!document.querySelector('.remote-log-follow')`, 8000), String(await page.js(`document.querySelector('.remote-log-follow')?.textContent || ''`)))
    await sleep(2500)
    check('the follow state is not an error after a few checks', await page.js(`!/오류|실패/.test(document.querySelector('.remote-log-follow')?.textContent || '')`), String(await page.js(`document.querySelector('.remote-log-follow')?.textContent || ''`)))
    await noProblems(page, 'live view')
    await page.shot('ssh-remote-file-3-live')
    page.close()
  }

  // ---- Image ----
  page = await openFrom('pic.png', '미리보기')
  check('an image opens in the preview window', !!page)
  if (page) {
    check('the image is drawn (it has its natural size)', await page.until(`(() => { const img = document.querySelector('.remote-file-image'); return !!img && img.complete && img.naturalWidth === 1 })()`, 20000), String(await page.js(`(document.body.innerText || '').slice(0, 200)`)))
    check('from a blob: URL', await page.js(`(document.querySelector('.remote-file-image')?.src || '').startsWith('blob:')`))
    await noProblems(page, 'image preview')
    page.close()
  }

  // ---- PDF ----
  page = await openFrom('doc.pdf', '미리보기')
  check('a PDF opens in the preview window', !!page)
  if (page) {
    check('in an iframe with a blob: URL', await page.until(`(document.querySelector('iframe.remote-file-pdf')?.src || '').startsWith('blob:')`, 20000), String(await page.js(`(document.body.innerText || '').slice(0, 200)`)))
    await sleep(3000)
    // The viewer is a frame of its own inside the iframe: the frame tree shows whether it was allowed to load
    const tree = await page.send('Page.getFrameTree')
    const frames = []
    const walk = (node) => { frames.push(node.frame.url.slice(0, 60) + ' [' + (node.frame.mimeType || '') + ']'); for (const child of node.childFrames || []) walk(child) }
    if (tree.result?.frameTree) walk(tree.result.frameTree)
    console.log('  frames:', JSON.stringify(frames))
    check('the PDF frame loaded (it is in the frame tree as a blob: document)', frames.some((f) => f.startsWith('blob:')), JSON.stringify(frames))
    await noProblems(page, 'PDF preview')
    await page.shot('ssh-remote-file-4-pdf')
    page.close()
  }

  await shot('ssh-remote-file-5-main')
  finish()
})().catch((error) => { console.error(error); process.exit(1) })
