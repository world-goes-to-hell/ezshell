// An SSH tab connects to the test server (host key asked once), and `SFTP 를 현재 폴더로` opens the
// SFTP panel at the terminal's folder, follows a `cd`, and lists the folder's files.
// Run by e2e/run.js, which starts e2e/support/sshd.js for specs named ssh-*.
const { sleep, createChecks, connect, findPage, pages, unlock, connectSsh } = require('../support/driver')
const { check, finish } = createChecks()
;(async () => {
  const driver = await connect()
  const { js, until, click, center, type, enter, menuPick } = driver
  // The remote pane's path: the last path bar in the SFTP panel
  const remotePath = () => js(`(() => { const bars = [...document.querySelectorAll('.sftp-panel input, .sftp-panel [class*="path"]')].map(e => (e.value ?? e.textContent ?? '').trim()).filter(Boolean); return JSON.stringify(bars) })()`)
  const sync = async () => {
    const term = await center(`document.querySelector('.terminal-container:not(.split-terminal) .xterm-screen')`)
    // Waits for the submenu and its item, and tries once more (the item was looked for too early before: `no menu item`)
    await menuPick(term[0], term[1] - 60, '편의', 'SFTP 를 현재 폴더로')
    await sleep(1500)
  }

  await unlock(driver)
  check('SSH tab connected', await connectSsh(driver))
  await sleep(700)

  // 1. Panel closed: opens at the terminal's folder
  await sync()
  check('SFTP panel opens', await until(`!!document.querySelector('.sftp-panel')`, 5000))
  await sleep(1000)
  let paths = await remotePath()
  check('at /var (the folder in the prompt)', paths.includes('"/var"'), paths)

  const session = JSON.stringify(await js(`document.querySelector('.terminal-tab').dataset.tabId`))
  const mainTerminal = `document.querySelector('.terminal-container:not(.split-terminal) .xterm')`
  const sendCommand = async (command) => {
    await js(`${mainTerminal}.querySelector('.xterm-helper-textarea').focus()`)
    await type(command)
    await enter()
  }
  const countShown = count => until(`${mainTerminal}.querySelector('.xterm-rows').textContent.includes('OPEN-SFTP ${count}')`, 5000)
  await js(`window.electronAPI.sftpClose(${session})`)
  await sendCommand('sftp-count')
  check('the server releases the previous SFTP channel', await countShown(0))
  await js(`Promise.all(Array.from({ length: 5 }, () => window.electronAPI.sftpOpen(${session})))`)
  await sendCommand('sftp-count')
  check('five simultaneous requests leave just one SFTP channel on the server', await countShown(1))
  await sendCommand('refuse')
  const refused = await js(`window.electronAPI.sshCreateShell(${session})`)
  // The client can still be waiting for the earlier channel's close acknowledgement.
  const channelDetail = /SSH 연결 채널 \d+개 · 셸 1 · SFTP 1(?: · 닫는 중 \d+)?\)/
  check('a refused shell distinguishes active channels from ones still closing', !refused.success && channelDetail.test(refused.error), refused.error)

  // 2. Panel open: goes to the new folder
  const term = await center(`document.querySelector('.terminal-container:not(.split-terminal) .xterm-screen')`)
  await click(term[0], term[1] - 60); await sleep(300)
  for (const cmd of ['ll', 'll /var/log', 'll /var /etc']) {
    await type(cmd); await enter(); await sleep(250)
  }
  await type('etc'); await enter(); await sleep(800)
  const labels = () => js(`[...document.querySelectorAll('.terminal-file-zone-label')].map(label => label.textContent).sort().join(' | ')`)
  check('completed listings keep the original folder labels after moving', (await labels()) === '/var | /var/log', await labels())
  const pointAtName = (name, prefix) => js(`(() => {
    const rows = [...document.querySelectorAll('.terminal-container:not(.split-terminal) .xterm-rows > div')];
    const row = rows.find(row => row.textContent.startsWith(${JSON.stringify(prefix)}) && row.textContent.trimEnd().endsWith(${JSON.stringify(name)}));
    let offset = row.textContent.lastIndexOf(${JSON.stringify(name)}) + 1;
    const textNodes = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = textNodes.nextNode(); node; node = textNodes.nextNode()) {
      if (offset >= node.length) { offset -= node.length; continue; }
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    }
  })()`)
  const hoverFile = ([x, y]) => js(`(() => {
    const moving = (x, y) => document.elementFromPoint(x, y).dispatchEvent(new MouseEvent('mousemove', {
      clientX: x, clientY: y, bubbles: true
    }));
    moving(${x}, ${y - 32});
    moving(${x}, ${y});
  })()`)
  const oldFile = await pointAtName('old.txt', '-rw')
  await hoverFile(oldFile)
  const tooltip = `document.querySelector('.terminal-container:not(.split-terminal) .xterm')?.title || ''`
  check('hover resolves the old file even though the new folder has a file of the same name', await until(`(${tooltip}).startsWith(${JSON.stringify('/var/old.txt\n')})`, 4000), await js(tooltip))
  const previewItem = `[...document.querySelectorAll('.terminal-menu-item')].find(item => item.textContent.trim() === '미리보기')`
  await click(oldFile[0], oldFile[1], 'right')
  check('the old listing opens the file menu', await until(`!!${previewItem}`, 4000))
  if (await js(`!!${previewItem}`)) {
    await js(`${previewItem}.click()`)
    const target = await findPage(page => page.url.includes('remoteFileMode'), 8000)
    check('preview opens the file from the original folder', !!target)
    if (target) {
      const page = await connect(p => p.id === target.id)
      check('the preview shows the original file contents', await page.until(`(document.querySelector('.cm-content')?.textContent || '').trim() === 'old'`, 8000))
      page.close()
      await driver.send('Page.bringToFront')
    }
  }
  const explicitFile = await pointAtName('app.log', '-rw')
  await hoverFile(explicitFile)
  check('hover on an explicit listing resolves the listed directory', await until(`(${tooltip}).startsWith(${JSON.stringify('/var/log/app.log\n')})`, 4000), await js(tooltip))
  const known = new Set((await pages()).map(page => page.id))
  const [fileX, fileY] = explicitFile
  await js(`(() => {
    const file = document.elementFromPoint(${fileX}, ${fileY});
    const options = { clientX: ${fileX}, clientY: ${fileY}, bubbles: true, ctrlKey: true };
    file.dispatchEvent(new MouseEvent('mousedown', options));
    file.dispatchEvent(new MouseEvent('mouseup', options));
  })()`)
  const editorTarget = await findPage(page => page.url.includes('remoteFileMode') && !known.has(page.id), 8000)
  check('Ctrl+click opens the file from the original explicit directory', !!editorTarget)
  if (editorTarget) {
    const editor = await connect(page => page.id === editorTarget.id)
    check('the editor shows the original log', await editor.until(`(document.querySelector('.cm-content')?.textContent || '').includes('ERROR db down')`, 8000))
    editor.close()
    await driver.send('Page.bringToFront')
  }
  const unknownFile = await pointAtName('hosts', 'hosts')
  await click(unknownFile[0], unknownFile[1], 'right')
  check('relative names from a multi-folder listing have no file menu', await until(`!!document.querySelector('.terminal-menu')`, 3000) && await js(`![...document.querySelectorAll('.terminal-menu-item')].some(item => item.textContent.trim() === '미리보기')`))
  await click(term[0], term[1] - 60)
  await sync()
  paths = await remotePath()
  check('follows to /etc', paths.includes('"/etc"'), paths)
  check('and lists the files of that folder', await until(`(document.querySelector('.sftp-panel')?.textContent || '').includes('hosts')`, 8000))

  // 3. Home (~) is asked from the server
  await click(term[0], term[1] - 60); await sleep(300)
  await type('home'); await enter(); await sleep(800)
  await sync()
  paths = await remotePath()
  check('~ becomes the login folder (/ on the test server)', paths.includes('"/"') && !paths.includes('"/etc"'), paths)
  finish()
})().catch((e) => { console.error(e); process.exit(1) })
