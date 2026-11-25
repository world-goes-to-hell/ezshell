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
  } finally { driver.close() }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
