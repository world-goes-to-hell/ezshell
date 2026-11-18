// The live log view ("실시간 보기"): a stack trace counts as one error, F8 / F9 and Alt + wheel move
// between problems and markers (first, last, stopping at the ends), the list panel shows what came
// after each marker, and a marker can be named.
// Run by e2e/run.js with the test server: its /var/trace.log has two errors (the first with a stack
// trace) and a warning, and the shell word `burst` adds one more error to it.
const { sleep, createChecks, connect, pages, findPage, unlock, connectSsh, pageProblems } = require('../support/driver')
const { check, finish } = createChecks()

const ALT = 1, CTRL = 2, SHIFT = 8
const KEYS = { F8: 119, F9: 120, m: 77, Enter: 13 }

;(async () => {
  const main = await connect()
  const { js, until, center, menuPick } = main

  await unlock(main)
  check('an SSH tab connects to the test server', await connectSsh(main))

  // The SFTP panel at the terminal's folder (/var), then 실시간 보기 on the log
  const term = await center(`document.querySelector('.terminal-container:not(.split-terminal) .xterm-screen')`)
  await menuPick(term[0], term[1] - 60, '편의', 'SFTP 를 현재 폴더로')
  const row = `[...document.querySelectorAll('.sftp-panel .remote-pane .file-item')].find(r => r.textContent.trim().startsWith('trace.log'))`
  check('the SFTP panel lists the log', await until(`!!${row}`, 15000))
  const known = new Set((await pages()).map((p) => p.id))
  await js(`(() => { const r = ${row}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: b.left + 40, clientY: b.top + b.height / 2 })) })()`)
  const item = `[...document.querySelectorAll('.sftp-context-menu .context-menu-item')].find(i => i.querySelector('.context-menu-label')?.textContent === '실시간 보기')`
  await until(`!!${item}`, 4000)
  await js(`${item}.click()`)
  const target = await findPage((t) => t.url.includes('remoteFileMode') && !known.has(t.id), 15000)
  check('실시간 보기 opens a window', !!target)
  if (!target) return finish()
  const page = await connect((t) => t.id === target.id)

  const text = (selector) => page.js(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`)
  const counts = () => page.js(`[...document.querySelectorAll('.remote-file-status button.remote-log-count:not(.remote-log-marker)')].map(b => b.textContent.trim()).join(' | ')`)
  const position = () => text('.remote-file-status .remote-log-position')
  const cursorLine = async () => Number((/줄 (\d+),/.exec(await page.js(`document.querySelector('.remote-file-status').textContent`)) || [])[1])
  const key = async (name, modifiers = 0) => {
    const event = { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: KEYS[name], modifiers }
    await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
    await sleep(250)
  }
  const focusLog = async () => { await page.send('Page.bringToFront'); await page.js(`document.querySelector('.cm-content').focus()`) }

  check('the log is shown', await page.until(`(document.querySelector('.cm-content')?.textContent || '').includes('second failure') || document.querySelectorAll('.remote-log-problem-row').length > 0`, 20000))
  await sleep(500)

  // ---- Counting: the stack trace is one error ----
  check('a stack trace counts as one error (오류 2, 경고 1)', (await counts()) === '오류 2 | 경고 1', await counts())
  const rows = () => page.js(`[...document.querySelectorAll('.remote-log-problem-row')].map(r => r.querySelector('.remote-log-problem-text').textContent).join(' | ')`)
  check('the list panel shows the three problems, newest first', (await rows()) === 'ERROR second failure | WARN slow query | ERROR request failed', await rows())
  check('with the time of each', (await page.js(`document.querySelector('.remote-log-problem-row .remote-log-row-time').textContent`)) === '10:01:10')

  // ---- At the end of the log, cursor not on screen: a step goes to a problem outside the view ----
  // (the last error is on screen there; "moving" to it would not move the view)
  const scrollTop = () => page.js(`Math.round(document.querySelector('.cm-scroller').scrollTop)`)
  const wheelAt = await page.center(`document.querySelector('.cm-scroller')`)
  const endTop = await scrollTop()
  await page.send('Page.bringToFront')
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: wheelAt[0], y: wheelAt[1], deltaX: 0, deltaY: -100, modifiers: ALT })
  await sleep(400)
  check('Alt + wheel up at the end of the log scrolls to a problem above the view', (await scrollTop()) < endTop && (await position()) === '2/3', `${endTop} -> ${await scrollTop()}, ${await position()}`)
  check('the line it arrived at is lit', await page.js(`!!document.querySelector('.cm-line.cm-log-arrived')`))

  // ---- Keys: first, next, last, previous ----
  await focusLog()
  await key('F8', CTRL | SHIFT)
  check('Ctrl+Shift+F8 goes to the first problem', (await position()) === '1/3' && (await cursorLine()) === 2, `${await position()} line ${await cursorLine()}`)
  await key('F8')
  check('F8 goes past the stack trace to the next problem', (await position()) === '2/3' && (await cursorLine()) === 9, `${await position()} line ${await cursorLine()}`)
  await key('F8', CTRL)
  check('Ctrl+F8 goes to the last problem', (await position()) === '3/3' && (await cursorLine()) === 130, `${await position()} line ${await cursorLine()}`)
  await key('F8', SHIFT)
  check('Shift+F8 goes back one', (await position()) === '2/3', await position())
  check('the list marks the problem the cursor is at', (await page.js(`document.querySelector('.remote-log-problem-row.is-current .remote-log-problem-text')?.textContent || ''`)) === 'WARN slow query')

  // ---- Alt + wheel: one problem a notch, stopping at the ends ----
  const editorAt = await page.center(`document.querySelector('.cm-scroller')`)
  const wheel = async (deltaY, modifiers) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: editorAt[0], y: editorAt[1], deltaX: 0, deltaY, modifiers })
    await sleep(350)
  }
  await wheel(-100, ALT)
  check('Alt + wheel up goes to the previous problem', (await position()) === '1/3', await position())
  await wheel(-100, ALT)
  check('and stops at the first one (no going round)', (await position()) === '1/3' && (await cursorLine()) === 2, `${await position()} line ${await cursorLine()}`)
  await wheel(100, ALT)
  await wheel(100, ALT)
  check('Alt + wheel down goes on, one problem a notch', (await position()) === '3/3', await position())
  const scrollBefore = await page.js(`document.querySelector('.cm-scroller').scrollTop`)
  await wheel(100, ALT)
  check('at the last one the text does not scroll either', (await page.js(`document.querySelector('.cm-scroller').scrollTop`)) === scrollBefore && (await position()) === '3/3')

  await wheel(-100, CTRL)
  check('Ctrl + wheel does the same (a lone Alt does not reach the window on every PC)', (await position()) === '2/3', await position())
  await wheel(100, CTRL)

  // ---- A list row ----
  await page.js(`[...document.querySelectorAll('.remote-log-problem-row')].find(r => r.textContent.includes('request failed')).click()`)
  await sleep(300)
  check('a row of the list goes to its line', (await cursorLine()) === 2 && (await position()) === '1/3', `line ${await cursorLine()}`)

  // ---- Markers: what came after, a name, F9 ----
  await focusLog()
  await key('m', CTRL)
  check('Ctrl+M puts a marker at the end, listed in the panel', await page.until(`document.querySelectorAll('.remote-log-marker-row').length === 1`, 4000))
  check('with nothing after it yet', (await text('.remote-log-marker-row .remote-log-row-sub')) === '뒤 0줄', await text('.remote-log-marker-row .remote-log-row-sub'))

  // The server writes a new error: typed in the terminal of the main window
  await main.send('Page.bringToFront')
  await main.click(term[0], term[1])
  await main.type('burst')
  await main.enter()
  check('the new error is counted once (오류 3)', await page.until(`[...document.querySelectorAll('.remote-file-status button.remote-log-count')].some(b => b.textContent.trim() === '오류 3')`, 15000), await counts())
  check('the marker tells what came after it (3 lines, 1 error)', (await text('.remote-log-marker-row .remote-log-row-sub')) === '뒤 3줄 · 오류 1', await text('.remote-log-marker-row .remote-log-row-sub'))
  check('and so does the status line', (await text('.remote-file-status .remote-log-marker')).includes('뒤 3줄') && (await text('.remote-file-status .remote-log-marker')).includes('오류 1'), await text('.remote-file-status .remote-log-marker'))

  check('new errors have a separate button from new lines', (await text('.remote-log-new-errors')) === '새 오류 1개' && (await text('.remote-log-new-lines:not(.remote-log-new-errors)')) === '새 줄 3개')
  check('an ordinary three-line append does not show a surge', !(await text('.remote-log-burst')))
  await page.js(`document.querySelector('.remote-log-new-errors').click()`)
  check('the new error button jumps to and highlights the error', await page.until(`document.querySelector('.cm-log-arrived')?.textContent.includes('ERROR burst failure')`, 3000))
  check('the visited error is acknowledged', await page.until(`!document.querySelector('.remote-log-new-errors')`, 3000))

  await page.js(`document.querySelector('.remote-log-row-sub').click()`)
  check('a marker count limits the list and the status counts', await page.until(`!!document.querySelector('.remote-log-scope') && document.querySelectorAll('.remote-log-problem-row').length === 1`, 3000) && (await counts()) === '오류 1 | 경고 0' && (await rows()) === 'ERROR burst failure')
  await focusLog()
  await key('F8', CTRL | SHIFT)
  check('F8 also respects the marker range', (await position()) === '1/1' && (await cursorLine()) === 132)
  await page.js(`document.querySelector('.remote-log-scope').click()`)
  check('clearing the marker range restores all problems', await page.until(`!document.querySelector('.remote-log-scope') && document.querySelectorAll('.remote-log-problem-row').length === 4`, 3000))

  await focusLog()
  await page.js(`document.querySelector('.remote-log-marker-row button[aria-label$="이름 붙이기"]').click()`)
  await page.until(`!!document.querySelector('.remote-log-marker-input')`, 3000)
  await page.type('배포 뒤')
  await key('Enter')
  check('a marker can be named: the panel shows the name', await page.until(`(document.querySelector('.remote-log-marker-name')?.textContent || '') === '배포 뒤'`, 4000), await text('.remote-log-marker-name'))
  // Only the lines on screen are drawn: go to the marker to see its band
  await page.js(`document.querySelector('.remote-log-marker-row .remote-log-row-main').click()`)
  await page.until(`!!document.querySelector('.cm-log-marker-label')`, 3000)
  check('and so does its band in the log', (await text('.cm-log-marker-label')).includes('배포 뒤'), await text('.cm-log-marker-label'))

  // A second marker above the first problem (a click on its line number), then F9 between them
  await page.js(`[...document.querySelectorAll('.remote-log-problem-row')].find(r => r.textContent.includes('request failed')).click()`)
  await sleep(300)
  const gutter = await page.js(`(() => { const el = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find(e => e.textContent === '2'); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)
  if (gutter) await page.click(gutter[0], gutter[1])
  check('a click on a line number puts a marker there', await page.until(`document.querySelectorAll('.remote-log-marker-row').length === 2`, 4000))
  check('it counts everything after it (오류 3, 경고 1)', (await page.js(`document.querySelector('.remote-log-marker-row .remote-log-row-sub').textContent`)).endsWith('오류 3 · 경고 1'), await page.js(`document.querySelector('.remote-log-marker-row .remote-log-row-sub').textContent`))
  await focusLog()
  await key('F9', CTRL)
  check('Ctrl+F9 goes to the last marker', (await cursorLine()) === 132, `line ${await cursorLine()}`)
  await key('F9', CTRL | SHIFT)
  check('Ctrl+Shift+F9 goes to the first marker', (await cursorLine()) === 2, `line ${await cursorLine()}`)
  await key('F9')
  check('F9 goes to the next marker', (await cursorLine()) === 132, `line ${await cursorLine()}`)
  await wheel(-100, ALT | SHIFT)
  check('Alt + Shift + wheel up goes to the previous marker', (await cursorLine()) === 2, `line ${await cursorLine()}`)
  await wheel(-100, ALT | SHIFT)
  check('and stops at the first marker', (await cursorLine()) === 2, `line ${await cursorLine()}`)

  // ---- The list's level choice also decides where the keys and the wheel go ----
  const pickLevel = (label) => page.js(`[...document.querySelectorAll('.remote-log-filter button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`)
  await pickLevel('오류')
  await focusLog()
  await key('F8', CTRL | SHIFT)
  await key('F8')
  check('with 오류 chosen, F8 skips the warning', (await cursorLine()) === 130 && (await position()) === '오류 2/3', `line ${await cursorLine()}, ${await position()}`)
  await wheel(-100, CTRL)
  check('and so does the wheel', (await cursorLine()) === 2, `line ${await cursorLine()}`)
  await pickLevel('경고')
  await focusLog()
  await key('F8', CTRL)
  check('with 경고 chosen, the keys go to warnings only', (await cursorLine()) === 9 && (await position()) === '경고 1/1', `line ${await cursorLine()}, ${await position()}`)
  await pickLevel('전체')
  await sleep(200)

  // ---- Line folding and the panel's button ----
  await page.js(`document.querySelector('.popout-title-action[aria-label="줄바꿈"]').click()`)
  check('the 줄바꿈 button folds long lines', await page.until(`!!document.querySelector('.cm-content.cm-lineWrapping')`, 3000))
  await page.js(`document.querySelector('.popout-title-action[aria-label="줄바꿈"]').click()`)
  await page.shot('ssh-log-view-1-panel')
  await page.js(`document.querySelector('.popout-title-action[aria-label="기준점·오류 목록"]').click()`)
  check('the list panel closes with its button', await page.until(`!document.querySelector('.remote-log-outline')`, 3000))
  check('the status line still shows the position', (await position()).endsWith('/4'), await position())
  await page.shot('ssh-log-view-2-closed')

  // ---- A high-volume arrival while already following the end ----
  const atBottom = `(() => { const s = document.querySelector('.cm-scroller'); return s.scrollHeight - s.clientHeight - s.scrollTop < 40 })()`
  await page.js(`(() => { const s = document.querySelector('.cm-scroller'); s.scrollTop = s.scrollHeight })()`)
  await page.until(atBottom, 3000)
  await page.until(`!document.querySelector('.toast')`, 7000)
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await page.js(`(() => {
    window.burstPulses = 0;
    document.addEventListener('animationstart', event => {
      if (event.animationName === 'remote-log-burst-arrival') window.burstPulses++;
    });
  })()`)
  await main.send('Page.bringToFront')
  await main.click(term[0], term[1])
  await main.type('spike')
  await main.enter()
  await page.send('Page.bringToFront')
  check('following the end shows the 240-line surge in the status bar', await page.until(`document.querySelector('.remote-log-burst')?.textContent === '+240줄'`, 15000))
  check('the surge uses one entrance animation', await page.until(`window.burstPulses === 1`, 2000))
  check('following stays at the end and exposes both passed errors', await page.until(`${atBottom} && document.querySelector('.remote-log-new-errors')?.textContent === '새 오류 2개' && !document.querySelector('.remote-log-new-lines:not(.remote-log-new-errors)')`, 4000))
  await page.shot('ssh-log-view-3-surge')
  check('the surge fades back to ordinary live view', await page.until(`!document.querySelector('.remote-log-burst')`, 6000))
  check('the two errors remain available after the surge', (await text('.remote-log-new-errors')) === '새 오류 2개')
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  check('reduced motion keeps the error button without its entrance animation', await page.js(`getComputedStyle(document.querySelector('.remote-log-new-errors')).animationName === 'none'`))
  await page.js(`document.querySelector('.remote-log-new-errors').click()`)
  check('the button highlights the first passed error and keeps the second', await page.until(`document.querySelector('.cm-log-arrived')?.textContent.includes('ERROR spike first') && document.querySelector('.remote-log-new-errors')?.textContent === '새 오류 1개'`, 3000))
  await page.js(`document.querySelector('.remote-log-new-errors').click()`)
  check('a second click highlights the second error and clears the button', await page.until(`document.querySelector('.cm-log-arrived')?.textContent.includes('ERROR spike second') && !document.querySelector('.remote-log-new-errors')`, 3000))

  const problems = await pageProblems(page)
  check('no console errors or CSP refusals', problems.length === 0, problems.join(' || '))
  page.close()
  finish()
})().catch((error) => { console.error(error); process.exit(1) })
