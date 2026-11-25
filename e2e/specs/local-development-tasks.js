const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, selectThemeTab, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE
const repo = path.join(profile, 'development repo')
const backTree = path.join(profile, 'checkout-backend')
const frontTree = path.join(profile, 'checkout-frontend')

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function fixture(backendPort, frontendPort) {
  const git = (folder, ...args) => execFileSync('git', args, { cwd: folder, stdio: 'pipe', windowsHide: true })
  const run = port => `
    const http = require('node:http');
    const fs = require('node:fs');
    http.createServer((req, res) => res.end('Development fixture ' + process.pid)).listen(${port}, '127.0.0.1', () => {
      console.log('Development fixture running in ' + process.cwd());
      console.log('Server PID ' + process.pid);
      console.log('Local: http://127.0.0.1:${port}/');
      if (process.argv[2]) console.log('Received ' + process.argv[2]);
    });
    setInterval(() => { if (fs.existsSync('exit-fixture')) process.exit(23) }, 50);
  `
  fs.mkdirSync(path.join(repo, 'backend'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'frontend'))
  fs.writeFileSync(path.join(repo, 'README.md'), '# Development fixture\n')
  fs.writeFileSync(path.join(repo, 'backend', 'build.gradle'), "plugins { id 'org.springframework.boot' }\n")
  fs.writeFileSync(path.join(repo, 'backend', 'gradlew.bat'), '@echo off\r\nnode run.cjs %*\r\n')
  fs.writeFileSync(path.join(repo, 'backend', 'gradlew'), '#!/bin/sh\nexec node run.cjs "$@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(repo, 'backend', 'run.cjs'), run(backendPort))
  fs.writeFileSync(path.join(repo, 'frontend', 'run.cjs'), run(frontendPort))
  const manifest = { name: 'frontend-fixture', version: '1.0.0', scripts: { dev: 'node run.cjs' } }
  fs.writeFileSync(path.join(repo, 'frontend', 'package.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(repo, 'frontend', 'package-lock.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: manifest.name, version: manifest.version } }
  }))
  git(repo, 'init', '-b', 'main')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Dev projects')
  git(repo, 'worktree', 'add', '-b', 'backend', backTree)
  git(repo, 'worktree', 'add', '-b', 'frontend', frontTree)
  for (const checkout of [backTree, frontTree]) {
    git(checkout, 'sparse-checkout', 'set', '--no-cone', '--', '/*', '!/backend/', '!/frontend/')
  }
}

;(async () => {
  const backendPort = await freePort()
  let frontendPort = await freePort()
  while (frontendPort === backendPort) frontendPort = await freePort()
  fixture(backendPort, frontendPort)
  const driver = await connect()
  const { js, until, click, center, shot, send, move } = driver
  const normalize = value => JSON.stringify(value.toLowerCase().replace(/\\/g, '/'))
  const row = checkout => `[...document.querySelectorAll('.local-worktree')].find(row =>
    row.dataset.worktreePath.toLowerCase().replace(/\\\\/g, '/') === ${normalize(checkout)})?.querySelector('.local-worktree-open')`
  const firstTask = `document.querySelector('.terminal-menu [role="menuitem"]')`
  const confirm = `document.querySelector('.confirm-dialog .btn-primary')`
  const message = `document.querySelector('.confirm-dialog-message')?.textContent`
  const launch = async (checkout, name) => {
    await js(`${row(checkout)}.scrollIntoView({ block: 'nearest' })`)
    await click(...await center(row(checkout)), 'right')
    if (!await until(`${firstTask}?.textContent.trim() === ${JSON.stringify(name)}`)) throw new Error(`Missing preferred task ${name}`)
    await driver.pick(name)
  }
  const activeTab = `document.querySelector('.terminal-tab.active')`
  const backendChip = `document.querySelector('.development-status-chip[aria-label^="Spring Boot"]')`
  const readServer = async port => {
    try { return await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })).text() }
    catch { return null }
  }
  async function waitServer(port, matches) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const value = await readServer(port)
      if (matches(value)) return value ?? true
      await sleep(100)
    }
    return null
  }
  const theme = async (name, themeId) => {
    const keys = async (key, code, virtualKey, modifiers = 0) => {
      const descriptor = { key, code, windowsVirtualKeyCode: virtualKey, modifiers }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...descriptor })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...descriptor })
    }
    await js(`document.activeElement?.blur()`)
    await keys(',', 'Comma', 188, 2)
    await selectThemeTab(driver, '앱 테마')
    await js(`[...document.querySelectorAll('.theme-card-main')].find(button => button.querySelector('.theme-name').textContent === ${JSON.stringify(name)}).click()`)
    if (!await until(`document.documentElement.dataset.theme === ${JSON.stringify(themeId)}`)) throw new Error(`Theme ${name} not applied`)
    await keys('Escape', 'Escape', 27)
    if (!await until(`!document.querySelector('.settings-modal')`)) throw new Error('Theme settings stayed open')
  }
  const inTerminal = text => `[...document.querySelectorAll('.local-terminal-pane .xterm-rows')].some(row =>
    row.checkVisibility({ visibilityProperty: true }) && row.textContent.includes(${JSON.stringify(text)}))`

  try {
    await unlock(driver)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([repo]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    if (!await until(`!!${row(backTree)} && !!${row(frontTree)}`)) throw new Error('Worktrees were not listed')
    await launch(backTree, 'Spring Boot 기동 · backend')
    check('the sparse worktree is confirmed with its own path and command', await until(`
      ${message}?.includes(${JSON.stringify(backTree)}) && ${message}.includes('backend/') && ${message}.includes('bootRun')
    `))
    await shot('local-development-backend-confirm')
    await js(`document.querySelector('.confirm-dialog .btn-secondary').click()`)
    check('cancel leaves the source and terminals untouched', await until(`!document.querySelector('.confirm-dialog, .terminal-tab')`) &&
      !fs.existsSync(path.join(backTree, 'backend')))

    await launch(backTree, 'Spring Boot 기동 · backend')
    await until(`!!${confirm}`)
    await js(`${confirm}.click()`)
    check('Gradle runs bootRun in the backend worktree terminal', await until(`${activeTab}?.textContent.includes('Spring Boot · backend') && ${inTerminal('Received bootRun')}`))
    const runningBackend = await js(`${activeTab}.dataset.tabId`)
    const originalServer = await waitServer(backendPort, value => value?.startsWith('Development fixture '))
    check('the running process is marked in the sidebar and tab and its port appears', await until(`
      ${backendChip}?.dataset.status === 'running' && ${backendChip}.textContent.includes(':${backendPort}') &&
      !!${activeTab}?.querySelector('.development-status-dot[data-status="running"]')
    `) && Boolean(originalServer))
    check('only backend was included in its worktree', fs.existsSync(path.join(backTree, 'backend', 'build.gradle')) && !fs.existsSync(path.join(backTree, 'frontend')))

    await launch(frontTree, 'Node 기동 · frontend')
    check('the frontend confirmation includes npm installation and its own command', await until(`
      ${message}?.includes(${JSON.stringify(frontTree)}) && ${message}.includes('frontend/') &&
      ${message}.includes(' ci') && ${message}.includes(' run dev')
    `))
    await js(`${confirm}.click()`)
    check('npm installs and starts the frontend in a separate local terminal', await until(`
      ${activeTab}?.textContent.includes('Node · frontend') && ${inTerminal('Development fixture running')}
    `, 25000))
    check('the two tasks use their respective module directories', await js(`window.electronAPI.localShellList().then(shells => {
      const folders = shells.filter(shell => !shell.exited).map(shell => shell.cwd.toLowerCase().replace(/\\\\/g, '/'))
      return folders.includes(${normalize(path.join(backTree, 'backend'))}) && folders.includes(${normalize(path.join(frontTree, 'frontend'))})
    })`) && !fs.existsSync(path.join(frontTree, 'backend')))
    await shot('local-development-frontend-running')
    await launch(backTree, 'Spring Boot 기동 · backend')
    check('a second launch switches back to the running tab without duplicating it', await until(`
      document.querySelectorAll('.terminal-tab').length === 2 && ${activeTab}.dataset.tabId === ${JSON.stringify(runningBackend)}
    `))

    await theme('Minimal Light', 'minimal-light')
    await move(600, 400)
    await sleep(300)
    await shot('local-development-light')
    await theme('Minimal Dark', 'minimal-dark')
    await move(...await center(backendChip))
    check('hovering the running chip offers all four actions', await until(`
      ['재기동', '중지', '브라우저로 열기', '로그 보기'].every(label => [...document.querySelectorAll('.terminal-menu [role="menuitem"]')].some(item => item.textContent.trim() === label))
    `))
    await shot('local-development-dark')
    await driver.pick('재기동')
    const restartedServer = await waitServer(backendPort, value => value?.startsWith('Development fixture ') && value !== originalServer)
    const restartedTab = await until(`
      document.querySelectorAll('.terminal-tab').length === 2 && ${activeTab}.dataset.tabId === ${JSON.stringify(runningBackend)} &&
      ${backendChip}?.dataset.status === 'running' && ${inTerminal('Received bootRun')}
    `)
    check('restart reuses the tab and starts a different process on the same port', Boolean(restartedServer) && restartedTab,
      !restartedServer || !restartedTab ? JSON.stringify({ originalServer, restartedServer, restartedTab }) : undefined)
    const backendViewport = `document.querySelector('[data-local-shell-id="${runningBackend}"] .xterm-viewport')`
    let dividerVisible = false
    let previousOutputVisible = false
    for (const fraction of [0, 0.25, 0.5, 0.75]) {
      await js(`(() => { const view = ${backendViewport}; view.scrollTop = (view.scrollHeight - view.clientHeight) * ${fraction} })()`)
      dividerVisible ||= await until(inTerminal('개발 서버 재기동'), 550)
      if (originalServer) previousOutputVisible ||= await js(inTerminal(`Server PID ${originalServer.split(' ').at(-1)}`))
      if (dividerVisible && previousOutputVisible) break
    }
    check('the restart divider and previous output can be reached in scrollback', dividerVisible && previousOutputVisible)
    await js(`${backendViewport}.scrollTop = ${backendViewport}.scrollHeight`)

    await click(...await center(backendChip), 'right')
    await driver.pick('브라우저로 열기')
    check('the discovered server opens in an app browser tab', await until(`${activeTab}?.hasAttribute('data-browser-tab') &&
      window.electronAPI.browserReviewState(${activeTab}.dataset.tabId).then(state => state?.url === 'http://127.0.0.1:${backendPort}/')`))
    await click(...await center(backendChip), 'right')
    await driver.pick('로그 보기')
    check('logs focus the same development tab', await until(`${activeTab}.dataset.tabId === ${JSON.stringify(runningBackend)}`))
    await click(...await center(activeTab), 'right')
    const tabStop = `[...document.querySelectorAll('.tab-context-menu button')].find(button => button.textContent.trim() === '중지')`
    await until(`!!${tabStop}`)
    await js(`${tabStop}.click()`)
    const stoppedPort = await waitServer(backendPort, value => value === null)
    const stoppedTab = await until(`
      ${activeTab}.dataset.tabId === ${JSON.stringify(runningBackend)} && ${backendChip}?.dataset.status === 'exited' && ${inTerminal('Received bootRun')}
    `)
    check('stop kills the server tree and keeps logs in a stopped tab', Boolean(stoppedPort) && stoppedTab,
      !stoppedPort || !stoppedTab ? JSON.stringify({ stoppedPort, stoppedTab }) : undefined)

    fs.writeFileSync(path.join(frontTree, 'frontend', 'exit-fixture'), '')
    check('the sidebar and tab report the native exit code', await until(`
      document.querySelector('.development-status-chip[aria-label^="Node"]')?.textContent.includes('종료 23') &&
      !!document.querySelector('.development-status-dot[aria-label="종료 23"]')
    `))
    await js(`document.querySelectorAll('.terminal-tab .tab-close').forEach(button => button.click())`)

    // Run presets on the project card (docs/plan/2026-11-25-local-project-run.md): add one, run it, it
    // becomes ready on its port, crashes with an error, the notice offers the agent hand-off and a restart
    // Each worktree runs the project's presets on its own: the main checkout's card first
    const sectionOf = checkout => `[...document.querySelectorAll('.run-presets')].find(el =>
      el.dataset.runWorktree.toLowerCase().replace(/\\\\/g, '/') === ${normalize(checkout)})`
    const section = sectionOf(repo)
    check('a project without presets offers to add one', await until(`!!${section}?.querySelector('.run-presets-add')`, 8000))
    await click(...await center(`${section}.querySelector('.run-presets-add')`))
    check('the add dialog opens for the project', await until(`!!document.querySelector('.run-preset-dialog')`))
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await setValue('#run-preset-name', '시험 서버')
    await setValue('#run-preset-folder', '.')
    await until(`[...document.querySelectorAll('.run-preset-choice')].some(c => c.textContent.includes('직접 입력'))`)
    await js(`[...document.querySelectorAll('.run-preset-choice')].find(c => c.textContent.includes('직접 입력')).querySelector('input').click()`)
    const server = path.join(__dirname, '..', 'support', 'devRunServer.js')
    await until(`!!document.querySelector('.run-preset-command')`)
    // Two spaces on purpose: the question must show the command as it runs
    const typed = `node "${server}" --crash-after  5000`
    await setValue('.run-preset-command', typed)
    check('a typed command is warned about in the dialog', await js(`!!document.querySelector('.run-preset-warn')`))
    await js(`document.querySelector('.run-preset-dialog button[type="submit"]').click()`)
    const presetRow = `${section}?.querySelector('.run-preset')`
    check('the saved preset is a row with a start button', await until(`!document.querySelector('.run-preset-dialog') &&
      ${presetRow}?.textContent.includes('시험 서버') && !!${presetRow}.querySelector('[data-action="start"]')`, 8000))
    await shot('local-run-preset-idle')
    await click(...await center(`${presetRow}.querySelector('[data-action="start"]')`))
    const ask = `document.querySelector('.run-command-dialog')`
    check('the typed command is shown exactly, spaces kept, before it first runs', await until(`
      document.querySelector('.run-command-text')?.textContent === ${JSON.stringify(typed)}`))
    check('the question starts on 취소 and its 실행 is off at first', await js(`
      document.activeElement?.textContent.trim() === '취소' &&
      [...${ask}.querySelectorAll('button')].find(b => b.textContent.trim() === '실행')?.disabled === true`))
    await driver.enter()
    check('Enter right away does not run it', await until(`!${ask}`) && await js(`['idle', 'stopped'].includes(${presetRow}?.dataset.status)`))
    await click(...await center(`${presetRow}.querySelector('[data-action="start"]')`))
    await until(`!!${ask}`)
    await sleep(900)
    await js(`[...${ask}.querySelectorAll('button')].find(b => b.textContent.trim() === '실행').click()`)
    check('the preset starts and its tab comes to the front', await until(`['starting', 'running'].includes(${presetRow}?.dataset.status) &&
      ${inTerminal('VITE v5.4.0 ready')}`, 15000))
    check('once ready the row shows its port', await until(`${presetRow}?.dataset.status === 'running' &&
      /:\\d+/.test(${presetRow}.querySelector('.run-preset-pill[data-kind="port"]')?.textContent ?? '')`, 10000))
    // The row tells the preset server's state (the tab of a local shell is its id)
    const presetShell = await js(`${activeTab}?.dataset.tabId`)
    // The tab keeps its status dot (seen with the sidebar folded); only the text chip is left to the card
    check('the old development chip leaves a preset server alone, the tab keeps its dot', await js(`!document.querySelector('.development-status-chip[data-development-shell="' + ${JSON.stringify(presetShell)} + '"]') &&
      !!${activeTab}?.querySelector('.development-status-dot')`), String(presetShell))
    await shot('local-run-preset-running')
    check('a crash turns the row red and tells the exit code', await until(`${presetRow}?.dataset.status === 'crashed' &&
      ${presetRow}.textContent.includes('종료 1')`, 15000))
    const notice = `document.querySelector('.run-crash')`
    check('the crash notice shows the last error lines', await until(`${notice}?.textContent.includes('Internal server error')`, 5000))
    await shot('local-run-preset-crash')
    await js(`${notice}.querySelector('.btn-primary').click()`)
    // The preview is main's text (what goes out): the name, the folder relative to the project, the errors
    check('the hand-off dialog previews main’s text and opens sending after it', await until(`
      document.querySelector('.run-send-dialog .run-send-preview[data-ready]')?.textContent.startsWith('시험 서버') &&
      document.querySelector('.run-send-dialog .run-send-preview').textContent.includes('폴더 ./') &&
      document.querySelector('.run-send-dialog .run-send-preview').textContent.includes('Internal server error')`))
    await shot('local-run-preset-send')
    await js(`[...document.querySelectorAll('.run-send-dialog button')].find(b => b.textContent.trim() === '취소').click()`)
    await until(`!document.querySelector('.run-send-dialog')`)
    await js(`[...${notice}.querySelectorAll('button')].find(b => b.textContent.includes('다시 실행')).click()`)
    check('다시 실행 starts it again and takes the notice away', await until(`['starting', 'running'].includes(${presetRow}?.dataset.status) && !${notice}`, 10000))
    // It crashes again by design: stop it first so the next crash does not race the end of the spec
    await until(`${presetRow}?.dataset.status === 'running'`, 10000)
    await click(...await center(`${presetRow}.querySelector('[data-action="stop"]')`))
    check('■ stops the preset (stopped, not crashed)', await until(`${presetRow}?.dataset.status === 'stopped' && !${notice}`, 10000))

    // The same preset in another worktree of the project: listed there too, run there on its own
    const otherRow = `${sectionOf(backTree)}?.querySelector('.run-preset')`
    check('a preset added once is listed under every worktree of the project', await until(`${otherRow}?.textContent.includes('시험 서버')`, 8000))
    await js(`${otherRow}.scrollIntoView({ block: 'nearest' })`)
    await click(...await center(`${otherRow}.querySelector('[data-action="start"]')`))
    if (await until(`!!document.querySelector('.run-command-dialog')`, 3000)) {
      await sleep(900)
      await js(`[...document.querySelectorAll('.run-command-dialog button')].find(b => b.textContent.trim() === '실행').click()`)
    }
    check('running it in the other worktree leaves the first worktree’s state alone', await until(`
      ['starting', 'running'].includes(${otherRow}?.dataset.status) && ${presetRow}?.dataset.status === 'stopped'`, 15000))
    await until(`${otherRow}?.dataset.status === 'running'`, 10000)
    await click(...await center(`${otherRow}.querySelector('[data-action="stop"]')`))
    await until(`${otherRow}?.dataset.status === 'stopped'`, 10000)
  } finally { driver.close() }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
