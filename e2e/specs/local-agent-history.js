// Agent session history in the right panel: fake transcripts from e2e/support/agentHistoryApp.js.
// Run by e2e/run.js with that launcher (no SSH server).
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { connect, createChecks, unlock, SET, sleep } = require('../support/driver')

const { check, finish } = createChecks()
const CLAUDE_ID = 'abcdef12-1111-4222-8333-444455556666'
const EMPTY_ID = 'abcdef12-1111-4222-8333-777788889999'
const CODEX_ID = '01a1ec18-9b8a-71c1-839d-2e31c010300f'

;(async () => {
  const driver = await connect()
  const { js, until, send, shot, center, click } = driver
  const profile = process.env.E2E_PROFILE
  const work = path.join(profile, 'work app')
  const tree = path.join(profile, 'work branch')
  const other = path.join(profile, 'other folder')
  const git = (...args) => execFileSync('git', ['-c', 'user.name=History Test', '-c', 'user.email=history@example.invalid', ...args], {
    cwd: work, stdio: 'pipe', windowsHide: true
  })
  git('init', '-b', 'main')
  git('commit', '--allow-empty', '-m', 'Start project')
  git('worktree', 'add', '-b', 'feature', tree)
  fs.writeFileSync(path.join(profile, 'claude-config', 'projects', 'work-app', `${EMPTY_ID}.jsonl`),
    JSON.stringify({ type: 'mode', mode: 'default', sessionId: EMPTY_ID, cwd: tree }) + '\n')

  const rows = `[...document.querySelectorAll('.agent-history-row')]`
  const titles = `${rows}.map(row => row.querySelector('.agent-history-title').textContent)`
  const worktree = folder => `[...document.querySelectorAll('.local-worktree')].find(row => row.dataset.worktreePath === ${JSON.stringify(folder)})`
  const open = async folder => {
    if (!await until(`!!${worktree(folder)}`, 10000)) throw new Error(`Worktree row did not appear: ${folder}`)
    await js(`${worktree(folder)}.querySelector('.local-worktree-open').click()`)
  }
  const escape = async () => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }

  await unlock(driver)
  check('the status bar has the work panel button', await until(`!!document.querySelector('.workspace-indicator')`, 8000))
  const mainWidth = await js(`document.querySelector('#main-content').getBoundingClientRect().width`)
  await js(`document.querySelector('.workspace-indicator').click()`)
  check('the work panel opens beside the main area, which gets narrower (not covered)',
    await until(`!!document.querySelector('.workspace-panel') && document.querySelector('#main-content').getBoundingClientRect().width < ${mainWidth} - 200`, 5000))
  check('the history panel asks for a project and shows no list or search without one', await until(`
    document.querySelector('.agent-history-note')?.textContent.includes('프로젝트의 로컬 터미널') &&
    ${rows}.length === 0 && !document.querySelector('.agent-history-search input')
  `))
  check('the history IPC also requires a project shell', await js(`window.electronAPI.agentHistoryList().then(result => result.success === false)`))

  await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([work, other]))});
    window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
  await open(work)
  check('the history lists the selected project and has no all-project control', await until(`
    document.querySelector('.agent-history-project')?.textContent === 'work app' &&
    JSON.stringify(${titles}) === JSON.stringify(['로그 화면 개선']) &&
    ![...document.querySelectorAll('.agent-history-bar button')].some(button => button.textContent.trim() === '전체')
  `))
  check('the count covers only the project and its linked worktree', await js(`
    document.querySelector('.agent-history-count').textContent === '1개 표시 · 프로젝트 2개'
  `))

  await js(`document.querySelector('.agent-history-empty-toggle input').click()`)
  check('the empty session in the linked worktree can be shown', await until(`
    ${rows}.length === 2 && ${rows}[0].querySelector('.agent-history-meta').textContent.includes('work branch')
  `, 3000))
  await js(`document.querySelector('.agent-history-empty-toggle input').click()`)

  await js(`document.querySelector('.agent-history-search input').focus()`)
  await js(`(() => { const set = ${SET}; set(document.querySelector('.agent-history-search input'), '화면 claude') })()`)
  check('search matches metadata from the project', await until(`JSON.stringify(${titles}) === JSON.stringify(['로그 화면 개선'])`, 3000))

  // Words only in the answers (not in the titles or folders): found by the conversation search
  const setQuery = (value) => js(`(() => { const set = ${SET}; set(document.querySelector('.agent-history-search input'), ${JSON.stringify(value)}) })()`)
  await setQuery('고쳤습니다')
  check('a word said only in an answer finds that session', await until(`JSON.stringify(${titles}) === JSON.stringify(['로그 화면 개선'])`, 8000), await js(`JSON.stringify(${titles})`))
  check('with an excerpt of the conversation, the word marked', await until(`document.querySelector('.agent-history-snippet mark')?.textContent === '고쳤습니다'`, 3000),
    await js(`document.querySelector('.agent-history-snippet')?.textContent ?? null`))
  await setQuery('넣었습니다')
  check('another project’s conversation gives no result or excerpt', await until(`
    ${rows}.length === 0 && document.querySelector('.agent-history-note')?.textContent === '조건에 맞는 세션이 없습니다.'
  `, 8000))
  check('the IPC filters content search and denies detail from the other project', await js(`(async () => {
    const shell = document.querySelector('.local-terminal-pane').dataset.localShellId
    const result = await window.electronAPI.agentHistorySearch(shell, '넣었습니다')
    const detail = await window.electronAPI.agentHistoryDetail(shell, 'codex:${CODEX_ID}')
    return result?.success && result.matches.length === 0 && detail?.success === false
  })()`))
  await escape()
  check('Esc in the search clears it and keeps the panel open',
    await until(`${rows}.length === 1 && document.querySelector('.agent-history-search input').value === ''`, 3000) &&
    await js(`!!document.querySelector('.workspace-panel')`))

  await js(`${rows}[0].click()`)
  check('a row opens its first prompt and the latest turns', await until(`(() => {
    const detail = document.querySelector('.agent-history-detail')
    if (!detail) return false
    const text = detail.textContent
    return text.includes('실시간 보기에서 오류 이동을 고쳐 줘') && text.includes('오류 이동을 고쳤습니다.') && text.includes('feat/log') && text.includes('claude-opus-5-5')
  })()`, 5000))
  await shot('local-agent-history-1-detail')

  const tabs = await js(`document.querySelectorAll('.terminal-tab').length`)
  await js(`document.querySelector('.agent-history-primary').click()`)
  check('resuming opens a local terminal tab', await until(`document.querySelectorAll('.terminal-tab').length === ${tabs + 1}`, 15000))
  const spawned = path.join(profile, 'spawned.jsonl')
  await until(`true`, 500)
  const launches = fs.existsSync(spawned) ? fs.readFileSync(spawned, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const launch = launches.at(-1)
  check('the shell starts Claude Code with --resume in the session folder',
    !!launch && launch.args.join(' ').includes(`--resume ${CLAUDE_ID}`) && path.normalize(launch.cwd) === path.join(profile, 'work app'),
    JSON.stringify(launch))
  // A press in the new terminal does not move the docked panel aside
  await until(`[...document.querySelectorAll('.local-terminal-pane')].some(el => getComputedStyle(el).visibility === 'visible')`, 8000)
  const [px, py] = await center(`[...document.querySelectorAll('.local-terminal-pane')].find(el => getComputedStyle(el).visibility === 'visible')`)
  await click(px, py)
  await sleep(300)
  check('the work panel stays open while working in the terminal', await js(`!!document.querySelector('.workspace-panel')`))

  await open(other)
  check('switching to the second project replaces the list and clears expanded details', await until(`
    document.querySelector('.agent-history-project')?.textContent === 'other folder' &&
    JSON.stringify(${titles}) === JSON.stringify(['사이드바 검색칸을 만들어 줘']) && !document.querySelector('.agent-history-detail')
  `))
  check('the compressed Codex session shows its branch', await js(`${rows}[0].textContent.includes('main') && ${rows}[0].querySelector('.agent-history-agent.is-codex')?.getAttribute('aria-label') === 'Codex'`))
  await setQuery('넣었습니다')
  check('the compressed Codex conversation is searchable within its project', await until(`
    document.querySelector('.agent-history-snippet mark')?.textContent === '넣었습니다'
  `, 8000))
  await open(tree)
  check('choosing a linked worktree shows the same project’s history', await until(`
    document.querySelector('.agent-history-project')?.textContent === 'work app' &&
    JSON.stringify(${titles}) === JSON.stringify(['로그 화면 개선'])
  `))

  // The width follows the dragged edge and is remembered with the open state
  const [ex, ey] = await center(`document.querySelector('.workspace-resize')`)
  const before = await js(`document.querySelector('.workspace-panel').getBoundingClientRect().width`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ex, y: ey, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ex, y: ey, button: 'left', buttons: 1, clickCount: 1 })
  for (let i = 1; i <= 5; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ex - i * 20, y: ey, button: 'none', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ex - 100, y: ey, button: 'left', buttons: 0, clickCount: 1 })
  const after = await js(`document.querySelector('.workspace-panel').getBoundingClientRect().width`)
  check('dragging the left edge widens the panel', Math.abs(after - before - 100) <= 2, `${before} -> ${after}, window ${await js('window.innerWidth')}`)
  check('the width and the open state are remembered', await js(`(() => { const p = JSON.parse(localStorage.getItem('workspacePanel')); return p.isOpen === true && Math.abs(p.width - ${after}) <= 1 })()`))

  const [nx, ny] = await center(`document.querySelector('.workspace-resize')`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nx, y: ny, button: 'none', buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nx, y: ny, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nx + after - 280, y: ny, button: 'none', buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nx + after - 280, y: ny, button: 'left', buttons: 0, clickCount: 1 })
  const pending = await js(`new Promise(resolve => {
    const header = document.querySelector('.agent-history-header')
    const box = selector => header.querySelector(selector).getBoundingClientRect()
    const observer = new MutationObserver(() => {
      if (!header.querySelector('.agent-history-searching')) return
      observer.disconnect()
      clearTimeout(timeout)
      resolve({
        width: document.querySelector('.workspace-panel').getBoundingClientRect().width,
        controlsFit: box('.agent-history-project').right <= box('.agent-history-count').left &&
          box('.agent-history-count').right <= box('.agent-history-bar > button').left,
        statusBelow: box('.agent-history-searching').top >= box('.agent-history-bar').bottom,
        showsEmpty: !!document.querySelector('.agent-history-note')
      })
    })
    const timeout = setTimeout(() => { observer.disconnect(); resolve(null) }, 3000)
    observer.observe(header, { childList: true, subtree: true })
    const set = ${SET}
    set(header.querySelector('input[type=search]'), '호랑이')
  })`)
  check('at minimum width search progress has its own line, clear of the controls',
    pending?.width === 280 && pending.controlsFit && pending.statusBelow, JSON.stringify(pending))
  check('no results is shown only once the search finishes', pending?.showsEmpty === false &&
    await until(`document.querySelector('.agent-history-note')?.textContent.trim() === '조건에 맞는 세션이 없습니다.'`, 5000))

  await js(`document.querySelector('.workspace-close').click()`)
  check('the close button hides the panel and the main area takes the room back', await until(`!document.querySelector('.workspace-panel') && document.querySelector('#main-content').getBoundingClientRect().width >= ${mainWidth} - 2`, 3000))

  finish()
})().catch(error => { console.error(error); process.exit(1) })
