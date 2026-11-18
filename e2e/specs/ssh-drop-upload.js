// A file dragged from the OS file manager onto an SSH terminal is uploaded to the login folder.
// The file's place on this PC comes from the preload's getPathForFile (File.path is gone from
// Electron 32 on), so this is the spec to watch across an Electron upgrade.
// Run by e2e/run.js with the test server. The drag is made with CDP's Input.dispatchDragEvent, which
// carries real file paths the way a drag from Explorer does.
const fs = require('fs')
const path = require('path')
const { sleep, createChecks, connect, unlock, connectSsh, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { send, js, until, shot } = driver

  const name = `dropped-${Date.now()}.txt`
  const file = path.join(process.env.E2E_PROFILE, name)
  fs.writeFileSync(file, 'dropped on the terminal\n')

  await unlock(driver)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  check('an SSH tab connects to the test server', await connectSsh(driver))
  await js(`(() => {
    window.__transferCompletions = []
    document.addEventListener('animationstart', event => {
      if (event.animationName === 'transfer-check') {
        window.__transferCompletions.push(event.target.closest('.file-item')?.querySelector('.file-name')?.textContent)
      }
    })
    ;[...${PANEL}.querySelectorAll('.terminal-header-btn')].find(b => (b.title || b.dataset.heldTitle || '').includes('SFTP')).click()
  })()`)
  await until(`!!document.querySelector('.sftp-panel')`, 10000)

  const at = await js(`(() => { const r = ${PANEL}.querySelector('.terminal-container[data-pane="main"]').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] })()`)
  const data = { items: [], files: [file], dragOperationsMask: 1 }
  await send('Page.bringToFront')
  const drag = (type) => send('Input.dispatchDragEvent', { type, x: at[0], y: at[1], data })
  const entered = await drag('dragEnter')
  await drag('dragOver')
  await sleep(300)
  if (entered.error) {
    // The runtime cannot make an OS file drag: say so instead of failing for the wrong reason
    console.log('SKIP  Input.dispatchDragEvent is not available here:', JSON.stringify(entered.error))
    return finish()
  }
  await shot('ssh-drop-upload-1-over')
  await drag('drop')

  const status = () => js(`${PANEL}?.querySelector('.terminal-upload-status')?.textContent || ''`)
  const sawStatus = await until(`!!${PANEL}?.querySelector('.terminal-upload-status')`, 8000)
  const shown = await status()
  check('the drop is taken as an upload', sawStatus, shown)
  check('one file is queued, none left out', shown.includes('1개 파일 업로드 시작') && !shown.includes('제외') && !shown.includes('실패'), shown)

  // The file arrives in the login folder of the server: the SFTP panel lists it there
  const listed = `[...document.querySelectorAll('.sftp-panel .remote-pane .file-item')].some(r => r.textContent.includes(${JSON.stringify(name)}))`
  let arrived = await until(listed, 6000)
  if (!arrived) {
    // The list may have been read before the transfer ended: read it again
    await js(`[...document.querySelectorAll('.sftp-panel .remote-pane button')].find(b => (b.title || b.dataset.heldTitle || '').includes('새로고침'))?.click()`)
    arrived = await until(listed, 10000)
  }
  check('the file is on the server', arrived, String(await js(`[...document.querySelectorAll('.sftp-panel .remote-pane .file-item')].map(r => r.textContent.trim().slice(0, 30)).join(' | ')`)))
  const completed = `[...document.querySelectorAll('.remote-pane .file-item.transfer-mark--done')].find(r => r.querySelector('.file-name')?.textContent === ${JSON.stringify(name)})`
  check('a real upload plays the completion check on its own row',
    await until(`window.__transferCompletions.includes(${JSON.stringify(name)})`))
  check('the temporary highlight clears and leaves the direction badge',
    await until(`!!${completed}?.querySelector('.transfer-mark-badge') && !${completed}?.querySelector('.transfer-completion')`))
  await shot('ssh-drop-upload-2-listed')

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
