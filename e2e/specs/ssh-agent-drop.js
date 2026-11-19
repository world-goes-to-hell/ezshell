// A past agent session dragged from the work panel's agent history: onto the start screen or a tab strip it
// resumes in a new local terminal tab, on a pane edge in a new split, and in the center by replacing
// the shell after confirmation. An SSH tab refuses it. Run by e2e/run.js with e2e/support/agentHistoryApp.js
// (fake transcripts, local shells that record how they were asked to start) and the test SSH server.
const fs = require('fs')
const path = require('path')
const { connect, createChecks, unlock, connectSsh, sleep } = require('../support/driver')
const { check, finish } = createChecks()

const CLAUDE_ID = 'abcdef12-1111-4222-8333-444455556666'
const CODEX_ID = '01a1ec18-9b8a-71c1-839d-2e31c010300f'

;(async () => {
  const driver = await connect()
  const { js, until, shot } = driver
  const profile = process.env.E2E_PROFILE
  const spawned = path.join(profile, 'spawned.jsonl')
  const launches = () => fs.existsSync(spawned) ? fs.readFileSync(spawned, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const resumedClaude = (launch) => !!launch && launch.args.join(' ').includes(`--resume ${CLAUDE_ID}`) && path.normalize(launch.cwd) === path.join(profile, 'work app')
  const ROW = `[...document.querySelectorAll('.agent-history-row')].find(row => row.textContent.includes('로그 화면 개선'))`
  const CODEX_ROW = `[...document.querySelectorAll('.agent-history-row')].find(row => row.textContent.includes('사이드바 검색칸을 만들어 줘'))`
  const LOCAL_PANES = `[...document.querySelectorAll('.local-terminal-tab')].filter(t => getComputedStyle(t).visibility !== 'hidden' && t.offsetParent !== null).flatMap(t => [...t.querySelectorAll(':scope > .local-terminal-pane')])`
  const tabCount = () => js(`document.querySelectorAll('.terminal-tab').length`)
  const marker = () => js(`document.querySelector('.agent-drop-marker span')?.textContent ?? null`)

  // The work panel stands beside the terminals (it does not cover them); the status bar button opens it
  const openPanel = async () => {
    if (!(await js(`!!document.querySelector('.workspace-panel')`))) await js(`document.querySelector('.workspace-indicator').click()`)
    return until(`!!(${ROW})`, 10000)
  }
  // HTML5 drag from CDP pointer input does not start: the events are sent directly
  const startDrag = (rowExpression = ROW) => js(`(() => {
    const row = ${rowExpression}
    if (!row) return 'no row'
    window.__dt = new DataTransfer()
    window.__row = row
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
    return 'ok'
  })()`)
  const dragOver = (x, y) => js(`(() => {
    const target = document.elementFromPoint(${x}, ${y}) || document.body
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: ${x}, clientY: ${y} })
    target.dispatchEvent(over)
    return over.defaultPrevented
  })()`)
  const dropAt = (x, y) => js(`(() => {
    const target = document.elementFromPoint(${x}, ${y}) || document.body
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientX: ${x}, clientY: ${y} }))
    window.__row.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
    return 'ok'
  })()`)
  const centerOf = (expr) => js(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.left, r.top, r.width, r.height] })()`)
  const shellsInView = () => js(`${LOCAL_PANES}.map(el => el.dataset.localShellId)`)
  const replaceAt = async (point, rowExpression) => {
    await startDrag(rowExpression)
    await dragOver(point[0], point[1])
    await dropAt(point[0], point[1])
    return until("!!document.querySelector('.confirm-dialog .btn-danger')", 3000)
  }

  await unlock(driver)
  check('the agent history panel lists the session', await openPanel())
  check('its rows can be dragged', await js(`(${ROW}).draggable === true`))

  // ---- Onto the start screen: a new local terminal tab ----
  const welcome = await centerOf(`document.querySelector('.welcome-screen')`)
  check('the start screen is there', !!welcome)
  await startDrag()
  check('over the start screen the drop is taken', await dragOver(welcome[0] - 200, welcome[1]))
  check('and the marker says a new tab', await until(`document.querySelector('.agent-drop-marker span')?.textContent === '여기에 놓으면 새 탭에서 이어서 실행'`, 3000), String(await marker()))
  await dropAt(welcome[0] - 200, welcome[1])
  check('dropping there opens a local terminal tab', await until(`document.querySelectorAll('.terminal-tab').length === 1`, 15000))
  await sleep(500)
  check('which resumes the Claude session in its folder', resumedClaude(launches().at(-1)), JSON.stringify(launches().at(-1)))
  check('the marker goes away', await until(`!document.querySelector('.agent-drop-marker')`, 3000))
  await until(`${LOCAL_PANES}.length === 1`, 15000)

  const singlePane = await centerOf(`${LOCAL_PANES}[0]`)
  const [oldMain] = await shellsInView()
  const beforeCancel = launches().length
  await startDrag()
  await dragOver(singlePane[0], singlePane[1])
  check('the center previews replacement of the whole pane', await until(`(() => {
    const marker = document.querySelector('.agent-drop-marker.is-replacing')
    return marker?.textContent.includes('기존 셸을 바꾸고') && Math.abs(marker.getBoundingClientRect().width - ${singlePane[4]}) < 1
  })()`, 3000))
  await dropAt(singlePane[0], singlePane[1])
  check('replacement asks before ending the existing shell', await until("document.querySelector('.confirm-dialog-message')?.textContent.includes('종료됩니다')"))
  await js("document.querySelector('.confirm-dialog .btn-secondary').click()")
  await until("!document.querySelector('.confirm-dialog')")
  check('cancelling leaves the shell and tab in place', (await shellsInView())[0] === oldMain && launches().length === beforeCancel && (await tabCount()) === 1)

  await until("!document.querySelector('.agent-history-scope button').disabled")
  await js("document.querySelector('.agent-history-scope button:last-child').click()")
  await until(`!!(${CODEX_ROW})`)
  check('the center can be dropped on again with a Codex conversation from another project', await replaceAt(singlePane, CODEX_ROW))
  await js("document.querySelector('.confirm-dialog .btn-danger').click()")
  check('confirming replaces the main shell in the same pane', await until(`(() => {
    const panes = ${LOCAL_PANES}
    return panes.length === 1 && panes[0].dataset.localShellId && panes[0].dataset.localShellId !== ${JSON.stringify(oldMain)}
  })()`) && (await tabCount()) === 1 && JSON.stringify(await centerOf(`${LOCAL_PANES}[0]`)) === JSON.stringify(singlePane))
  const mainReplacement = launches().at(-1)
  check('the original main shell closes and the Codex conversation resumes in its project',
    await until(`window.electronAPI.localShellAttach(${JSON.stringify(oldMain)}).then(state => state === null)`) &&
    mainReplacement?.args.join(' ').includes(`resume ${CODEX_ID}`) && mainReplacement?.cwd === path.join(profile, 'other folder'))
  check('the project filter follows the new main shell without switching tabs', await until(
    "document.querySelector('.agent-history-scope button')?.textContent === 'other folder'"))

  // ---- Onto the right side of that tab's pane: a new pane there ----
  check('the panel opens again', await openPanel())
  const pane = await centerOf(`${LOCAL_PANES}[0]`)
  const rightPick = pane[2] + pane[4] * 0.9
  const launchCount = launches().length
  await startDrag()
  check('while dragging, the page marks the drag', await until(`document.documentElement.dataset.agentDrag === 'on'`, 3000))
  check('over a local pane the drop is taken', await dragOver(rightPick, pane[1]))
  check('and the marker names the side', await until(`/이 칸의 오른쪽에서 이어서 실행/.test(document.querySelector('.agent-drop-marker span')?.textContent || '')`, 3000), String(await marker()))
  await shot('ssh-agent-drop-1-pane')
  await dropAt(rightPick, pane[1])
  check('after the drop the mark is gone', await until(`!document.documentElement.dataset.agentDrag`, 3000))
  check('dropping there adds a pane to the same tab', await until(`${LOCAL_PANES}.length === 2`, 15000) && (await tabCount()) === 1, JSON.stringify([await js(`${LOCAL_PANES}.length`), await tabCount()]))
  const rects = await js(`${LOCAL_PANES}.map(el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] })`)
  const added = rects.reduce((a, b) => (b[0] > a[0] ? b : a))
  const kept = rects.reduce((a, b) => (b[0] < a[0] ? b : a))
  check('the new pane is on the right', added[0] > kept[0] && Math.abs(added[1] - kept[1]) < 4, JSON.stringify(rects))
  await sleep(500)
  check('and its shell resumes the session', launches().length > launchCount && resumedClaude(launches().at(-1)), JSON.stringify(launches().at(-1)))

  const splitPane = await centerOf(`${LOCAL_PANES}[1]`)
  const [mainId, oldSplit] = await shellsInView()
  check('replacement can target a split shell', await replaceAt(splitPane))
  await js("document.querySelector('.confirm-dialog .btn-danger').click()")
  check('only the targeted split changes shell and takes keyboard focus', await until(`(() => {
    const panes = ${LOCAL_PANES}
    const shellId = panes[1]?.dataset.localShellId
    return panes.length === 2 && panes[0].dataset.localShellId === ${JSON.stringify(mainId)} &&
      shellId && shellId !== ${JSON.stringify(oldSplit)} && panes[1].contains(document.activeElement)
  })()`) && (await tabCount()) === 1 && JSON.stringify(await centerOf(`${LOCAL_PANES}[1]`)) === JSON.stringify(splitPane))
  check('the original split shell closes', await until(`window.electronAPI.localShellAttach(${JSON.stringify(oldSplit)}).then(state => state === null)`))

  // ---- An SSH tab does not take it ----
  check('an SSH tab connects', await connectSsh(driver))
  check('the panel opens again', await openPanel())
  const sshPane = await centerOf(`document.querySelector('.terminal-container[data-pane="main"]:not([style*="hidden"])')`)
  const sshTabs = await tabCount()
  await startDrag()
  await dragOver(sshPane[2] + 60, sshPane[1])
  check('over an SSH pane the marker refuses', await until(`document.querySelector('.agent-drop-marker.is-blocked span')?.textContent === '에이전트 대화는 로컬 터미널 탭에서만 이어서 열 수 있습니다.'`, 3000), String(await marker()))
  await dropAt(sshPane[2] + 60, sshPane[1])
  await sleep(800)
  check('and dropping does nothing but tell why', (await tabCount()) === sshTabs && await js(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('로컬 터미널 탭에서만'))`))

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
