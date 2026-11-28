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
  // An Eclipse web project in a module folder, for 이클립스 설정에서 채우기 (stage 2, second batch)
  fs.mkdirSync(path.join(repo, 'legacy', 'src'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'legacy', '.settings'))
  fs.mkdirSync(path.join(repo, 'legacy', 'WebContent', 'WEB-INF'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'legacy', 'src', 'Keep.java'), 'class Keep {}\n')
  fs.writeFileSync(path.join(repo, 'legacy', 'WebContent', 'WEB-INF', 'web.xml'), '<web-app/>\n')
  fs.writeFileSync(path.join(repo, 'legacy', '.classpath'), '<?xml version="1.0"?><classpath><classpathentry kind="src" path="src"/><classpathentry kind="output" path="build/classes"/></classpath>\n')
  fs.writeFileSync(path.join(repo, 'legacy', '.settings', 'org.eclipse.wst.common.component'),
    '<?xml version="1.0"?><project-modules id="moduleCoreId"><wb-module deploy-name="shop"><wb-resource deploy-path="/" source-path="/WebContent"/><property name="context-root" value="shop"/></wb-module></project-modules>\n')
  fs.writeFileSync(path.join(repo, 'legacy', '.settings', 'org.eclipse.jdt.core.prefs'), 'org.eclipse.jdt.core.compiler.compliance=1.8\n')
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
  const menuLabels = `[...document.querySelectorAll('.terminal-menu [role="menuitem"]')].map(item => item.textContent.trim())`
  // The start commands come after the items that are there from the start (they arrive a moment later)
  const firstTask = `[...document.querySelectorAll('.terminal-menu [role="menuitem"]')].find(item => / 기동(?: · |$)/.test(item.textContent.trim()))`
  let checkedMenuOrder = false
  const confirm = `document.querySelector('.confirm-dialog .btn-primary')`
  const message = `document.querySelector('.confirm-dialog-message')?.textContent`
  const launch = async (checkout, name) => {
    await js(`${row(checkout)}.scrollIntoView({ block: 'nearest' })`)
    await click(...await center(row(checkout)), 'right')
    if (!await until(`${firstTask}?.textContent.trim() === ${JSON.stringify(name)}`)) throw new Error(`Missing preferred task ${name}`)
    if (!checkedMenuOrder) {
      checkedMenuOrder = true
      const labels = await js(menuLabels)
      const firstStart = labels.findIndex(label => / 기동(?: · |$)/.test(label))
      check('found start commands join below the items the menu opened with, so those do not move', firstStart > 0
        && labels.slice(0, firstStart).includes('실행 구성 추가…'), labels.join(' | '))
    }
    await driver.pick(name)
  }
  const activeTab = `document.querySelector('.terminal-tab.active')`
  const activeBrowser = `document.querySelector('.terminal-tab.active[data-browser-tab]')`
  const browserView = `document.querySelector('.browser-review[data-browser-tab-id]')`
  const browserVisible = `${activeBrowser}?.dataset.tabId === ${browserView}?.dataset.browserTabId &&
    ${browserView}?.checkVisibility({ visibilityProperty: true })`
  const runtimeErrors = () => driver.events
    .filter(event => event.method === 'Runtime.exceptionThrown' ||
      (event.method === 'Log.entryAdded' && event.params.entry.level === 'error'))
    .map(event => event.params.exceptionDetails?.exception?.description ?? event.params.entry?.text)
    .slice(-6)
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
    // Each worktree's run presets load after its row; their place is held meanwhile, so the rows below do not
    // move when they come (a right click used to land on another worktree, whose menu puts another task first)
    const rowTops = `JSON.stringify([...document.querySelectorAll('.local-worktree')].map(item => Math.round(item.getBoundingClientRect().top)))`
    const topsAtListing = await js(rowTops)
    if (!await until(`document.querySelectorAll('[data-run-worktree]').length === document.querySelectorAll('.local-worktree').length`)) {
      throw new Error('The run presets of the worktrees did not load')
    }
    check('the worktree rows stay in place when their run presets load', await js(rowTops) === topsAtListing, `${topsAtListing} → ${await js(rowTops)}`)
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
    const backendChip = `document.querySelector('.development-status-chip[data-development-shell="${runningBackend}"]')`
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
      document.querySelectorAll('.terminal-tab').length === 2 && ${activeTab}?.dataset.tabId === ${JSON.stringify(runningBackend)} &&
      ${backendChip}?.dataset.status === 'running' &&
      ${backendChip}.querySelector('.development-status-port')?.textContent === ':${backendPort}' && ${inTerminal('Received bootRun')}
    `)
    if (!restartedServer || !restartedTab) {
      throw new Error(`The restarted backend was not ready in the same tab: ${JSON.stringify({ originalServer, restartedServer, restartedTab, backendPort })}`)
    }
    check('restart reuses the tab and starts a different process on the same port', true)
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

    await send('Runtime.enable')
    await send('Log.enable')
    await click(...await center(backendChip), 'right')
    await driver.pick('브라우저로 열기')
    const browserOpened = await until(`(async () => {
      if (!(${browserVisible})) return false
      const state = await window.electronAPI.browserReviewState(${activeBrowser}.dataset.tabId)
      return state?.url === 'http://127.0.0.1:${backendPort}/' && !state.loading && !state.error
    })()`)
    if (!browserOpened) {
      const state = await js(`(async () => {
        const active = ${activeTab}
        const page = ${activeBrowser} && await window.electronAPI.browserReviewState(${activeBrowser}.dataset.tabId)
        return { tab: active?.dataset.tabId, port: ${backendChip}?.querySelector('.development-status-port')?.textContent,
          url: page?.url, loading: page?.loading, error: page?.error }
      })()`)
      const errors = runtimeErrors()
      const missingChunk = errors.some(error => /ERR_FILE_NOT_FOUND|Failed to fetch dynamically imported module/.test(error))
      const hint = missingChunk ? '\nA rebuild can remove a lazy chunk from the shared out/ folder. Rerun after the build finishes.' : ''
      throw new Error(`The discovered server did not open at the expected address: ${JSON.stringify({
        backendPort, server: await readServer(backendPort), state, errors
      })}${hint}`)
    }
    check('the discovered server opens in an app browser tab', browserOpened)
    const logAnchor = await center(backendChip)
    if (!logAnchor) throw new Error('The backend chip is missing after opening its browser tab')
    await click(...logAnchor, 'right')
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

    // 파일 탐색기로 열기 on the project row's and the worktree row's menu (not clicked: it would open Explorer on this PC)
    const rightClick = selector => js(`(() => {
      const el = ${selector}
      if (!el) return false
      const box = el.getBoundingClientRect()
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + box.height / 2 }))
      return true
    })()`)
    const menuText = `[...document.querySelectorAll('.terminal-menu')].map(menu => menu.textContent).join('|')`
    const escape = async () => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await until(`!document.querySelector('.terminal-menu')`)
    }
    const projectHead = `[...document.querySelectorAll('.local-project')].find(el =>
      el.dataset.projectFolder.toLowerCase().replace(/\\\\/g, '/') === ${normalize(repo)})?.querySelector('.local-project-head')`
    check('right-clicking the project row offers 파일 탐색기로 열기', await rightClick(projectHead) &&
      await until(`(${menuText}).includes('파일 탐색기로 열기') && (${menuText}).includes('프로젝트')`), await js(menuText))
    await escape()
    const worktreeRow = `[...document.querySelectorAll('.local-worktree')].find(el =>
      el.dataset.worktreePath.toLowerCase().replace(/\\\\/g, '/') === ${normalize(repo)})?.querySelector(':scope > .local-worktree-row')`
    check('the worktree row’s menu offers 파일 탐색기로 열기 after its start commands', await rightClick(worktreeRow) &&
      await until(`(${menuText}).includes('파일 탐색기로 열기') && !(${menuText}).includes('찾는 중')`, 8000), await js(menuText))
    await shot('local-project-open-folder-menu')
    // 터미널 실행 (user request, 2026-11-26): a new shell in the worktree's folder, even with one open there
    check('the worktree row\u2019s menu starts with 터미널 실행', await js(`${menuLabels}[0] === '터미널 실행'`), await js(`${menuLabels}.join(' | ')`))
    const shellsIn = `(async () => (await window.electronAPI.localShellList()).filter(shell => shell.cwd &&
      shell.cwd.toLowerCase().replace(/\\\\/g, '/').replace(/\\/+$/, '') === ${normalize(repo)}).length)()`
    // The tabs closed above go one by one: opening a terminal before they are gone keeps them open
    await escape()
    await until(`!document.querySelector('.terminal-tab')`, 10000)
    await rightClick(worktreeRow)
    await until(`(${menuText}).includes('터미널 실행')`, 8000)
    const shellsBefore = await js(shellsIn)
    await driver.pick('터미널 실행')
    check('터미널 실행 opens a new local terminal in the worktree folder', await until(`(async () => (await ${shellsIn}) === ${shellsBefore + 1})()`, 8000),
      JSON.stringify({ before: shellsBefore, after: await js(shellsIn) }))
    // Closed again: the checks below start with no tab open
    await js(`document.querySelector('.terminal-tab.active .tab-close')?.click()`)
    if (await until(`!!${confirm}`, 1500)) await js(`${confirm}.click()`)
    await until(`!document.querySelector('.terminal-tab')`, 5000)
    await rightClick(worktreeRow)
    await until(`(${menuText}).includes('Spring Boot 기동 · backend')`, 8000)
    // A found command on disk is set up before it runs (2026-11-26 user request): the run preset dialog opens
    // with its folder and way chosen, offering 추가하고 실행; cancelling leaves nothing saved or started.
    // Compared before and after: tabs closed above may still be closing (one close at a time)
    const runState = () => js(`Promise.all([window.electronAPI.localShellList(), window.electronAPI.runPresetsList(${JSON.stringify(repo)})])
      .then(([shells, list]) => JSON.stringify({ shells: shells.filter(shell => !shell.exited).map(shell => shell.id).sort(), presets: list?.presets?.length ?? -1 }))`)
    const beforeMenuPick = await runState()
    await driver.pick('Spring Boot 기동 · backend')
    check('a found start command opens the preset dialog filled in from it', await until(`(() => {
      const dialog = document.querySelector('.run-preset-dialog')
      const chosen = dialog?.querySelector('input[name="run-preset-task"]:checked')?.closest('.run-preset-choice')
      const buttons = [...(dialog?.querySelectorAll('.modal-actions button') ?? [])].map(button => button.textContent.trim())
      return document.querySelector('#run-preset-folder')?.value === 'backend' &&
        document.querySelector('input[name="run-preset-kind"][value="task"]')?.checked &&
        chosen?.textContent.includes('bootRun') && buttons.join('|') === '취소|추가만|추가하고 실행'
    })()`, 8000), await js(`document.querySelector('.run-preset-dialog')?.textContent`))
    await shot('local-development-preset-from-menu')
    await js(`[...document.querySelectorAll('.run-preset-dialog .modal-actions button')].find(button => button.textContent.trim() === '취소').click()`)
    const closedDialog = await until(`!document.querySelector('.run-preset-dialog')`)
    await sleep(500)
    const afterCancel = await runState()
    const [before, after] = [JSON.parse(beforeMenuPick), JSON.parse(afterCancel)]
    check('cancelling the filled-in dialog starts and saves nothing', closedDialog && after.presets === before.presets &&
      after.shells.every(id => before.shells.includes(id)), `${beforeMenuPick} → ${afterCancel}`)

    // Run presets on the project card (docs/plan/2026-11-25-local-project-run.md): add one, run it, it
    // becomes ready on its port, crashes with an error, the notice offers the agent hand-off and a restart
    // Each worktree runs the project's presets on its own: the main checkout's card first
    const sectionOf = checkout => `[...document.querySelectorAll('.run-presets')].find(el =>
      el.dataset.runWorktree.toLowerCase().replace(/\\\\/g, '/') === ${normalize(checkout)})`
    const section = sectionOf(repo)
    // Without presets the card keeps no place for them: the worktree row has a small add button (2026-11-26)
    const rowAdd = `[...document.querySelectorAll('.local-worktree')].find(el =>
      el.dataset.worktreePath.toLowerCase().replace(/\\\\/g, '/') === ${normalize(repo)})?.querySelector(':scope > .local-worktree-row > .run-presets-row-add')`
    check('a project without presets offers to add one on its row, holding no place on the card', await until(`!!${rowAdd} && !${section}`, 8000))
    await click(...await center(rowAdd))
    check('the add dialog opens for the project', await until(`!!document.querySelector('.run-preset-dialog')`))
    const setValue = (selector, value) => js(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    // The dialog's layout (review, 2026-11-26): the kind first, 고급 folded, a name that follows the choice
    check('the dialog starts with the kind and keeps 고급 folded', await until(`
      [...document.querySelectorAll('.run-preset-kind-tab')].map(tab => tab.textContent.trim()).join('|') === '찾은 실행 방법|Tomcat|직접 입력' &&
      document.querySelector('.run-preset-advanced')?.open === false &&
      [...document.querySelectorAll('.run-preset-form .run-preset-switch')].filter(item => item.checkVisibility()).length === 2`))
    await js(`document.querySelector('input[name="run-preset-kind"][value="tomcat"]').click()`)
    check('a new preset\u2019s name follows the choice until it is typed in', await until(`document.querySelector('#run-preset-name')?.value === 'Tomcat'`))
    await setValue('#run-preset-name', '시험 서버')
    await setValue('#run-preset-folder', '.')
    // 찾아보기 opens a folder dialog (main checks the pick is inside the worktree): on the folder input's row, not clipped
    check('the folder input has a 찾아보기 button on its row', await js(`(() => {
      const input = document.querySelector('#run-preset-folder')?.getBoundingClientRect()
      const button = document.querySelector('.run-preset-folder-browse')
      const box = button?.getBoundingClientRect()
      const dialog = document.querySelector('.run-preset-dialog')?.getBoundingClientRect()
      return !!input && !!box && button.textContent.trim() === '찾아보기' && box.width >= 48 && input.width >= 160 &&
        Math.abs((box.top + box.bottom) / 2 - (input.top + input.bottom) / 2) < 4 && box.left >= input.right && box.right <= dialog.right
    })()`), await js(`document.querySelector('.run-preset-folder-input')?.outerHTML.slice(0, 300)`))
    await shot('local-run-preset-folder-browse')
    await js(`document.querySelector('input[name="run-preset-kind"][value="task"]').click()`)
    await until(`!!document.querySelector('input[name="run-preset-kind"][value="custom"]') && !document.querySelector('.run-preset-choices')?.textContent.includes('찾는 중')`)
    check('a typed name stays when the kind changes', await js(`document.querySelector('#run-preset-name').value === '시험 서버'`))
    await setValue('#run-preset-folder', 'backend')
    if (!await until(`document.querySelector('#run-preset-spring-port')?.value === '' && !!document.querySelector('#run-preset-spring-vmargs')`)) {
      throw new Error('The found Spring Boot task did not show the optional port and VM arguments')
    }
    await setValue('#run-preset-spring-port', '8181')
    await setValue('#run-preset-spring-vmargs', '-Xmx512m -Dapp.token=fixture-option')
    check('Spring Boot exposes the optional launch settings and warns about plain-text secrets', await until(`
      document.querySelector('#run-preset-spring-port')?.value === '8181' &&
      document.querySelector('.run-preset-secret-warn')?.textContent.includes('-Dapp.token')`))
    await setValue('#run-preset-folder', '.')
    // Stage 2: Tomcat is a kind of its own, with its fields, and hot reload can be picked for it
    await js(`document.querySelector('input[name="run-preset-kind"][value="tomcat"]').click()`)
    check('Tomcat shows its fields: the Tomcat (or where to fetch one), web folder, context path, port, VM arguments, build', await until(`(() => {
      const box = document.querySelector('.run-preset-tomcat')
      if (!box) return false
      const tomcat = !!box.querySelector('#run-preset-tomcat') || box.textContent.includes('설정 > 개발 도구에서 받기')
      return tomcat && !!box.querySelector('#run-preset-webapp') && box.querySelector('#run-preset-context')?.value === '/' &&
        box.querySelector('#run-preset-port')?.value === '8080' && !!document.querySelector('.run-preset-tomcat-advanced #run-preset-vmargs') &&
        box.querySelectorAll('input[name="run-preset-prepare"]').length === 4
    })()`))
    // 이클립스 설정에서 채우기: main reads the module's Eclipse settings; the web folder is kept from the worktree
    await setValue('#run-preset-folder', 'legacy')
    await until(`!!document.querySelector('.run-preset-eclipse-btn') && !document.querySelector('.run-preset-eclipse-btn').disabled`)
    await js(`document.querySelector('.run-preset-eclipse-btn').click()`)
    check('이클립스 설정에서 채우기 fills the web folder and context path and shows what it read', await until(`
      document.querySelector('#run-preset-webapp')?.value === 'legacy/WebContent' &&
      document.querySelector('#run-preset-context')?.value === '/shop' &&
      document.querySelector('.run-preset-eclipse-read')?.textContent.includes('소스 폴더: src') &&
      document.querySelector('.run-preset-eclipse-read').textContent.includes('Java 8')`, 8000),
      await js(`document.querySelector('.run-preset-eclipse')?.textContent`))
    await setValue('#run-preset-folder', '.')
    check('바로 반영 can be picked for a Tomcat preset', await until(`
      !!document.querySelector('.run-preset-reload')?.dataset.usable &&
      !document.querySelector('input[name="run-preset-reload"][value="standard"]').disabled`))
    // The debugger note shows once hot reload is on (not before)
    const debuggerNote = `document.querySelector('.run-preset-reload')?.textContent.includes('바로 반영을 켜면 이 실행에 IDE 디버거를 붙일 수 없습니다.')`
    const noteBefore = await js(debuggerNote)
    await js(`document.querySelector('input[name="run-preset-reload"][value="standard"]').click()`)
    check('the debugger note shows when hot reload is turned on', !noteBefore && await until(debuggerNote))
    await js(`document.querySelector('input[name="run-preset-reload"][value="off"]').click()`)
    // Second batch: the Eclipse-style build (compiled with the Eclipse settings, without build.xml)
    await js(`document.querySelector('input[name="run-preset-prepare"][value="eclipse"]').click()`)
    // Third batch: a workspace's servers and a context.xml are picked in main's folder chooser (not driven
    // here); the dialog offers both, says the passwords stay in the original file, and lists no extra libs yet
    check('Tomcat offers the workspace servers and a context.xml that is pointed at, not saved', await until(`(() => {
      const box = document.querySelector('.run-preset-tomcat')
      const advanced = document.querySelector('.run-preset-advanced .run-preset-tomcat-advanced')
      return !!box && !!advanced && [...box.querySelectorAll('.run-preset-eclipse-btn')].some(b => b.textContent.includes('워크스페이스 서버')) &&
        advanced.textContent.includes('비밀번호는 저장하지 않고 실행 때 원본에서 읽습니다') &&
        [...advanced.querySelectorAll('.run-preset-context-xml .run-preset-link')].some(b => b.textContent.trim() === '고르기') &&
        !advanced.querySelector('.run-preset-extra-libs')
    })()`))
    check('the Eclipse-style build says what it does', await until(`
      document.querySelector('.run-preset-tomcat .run-preset-prepare-note')?.textContent.includes('build.xml 없이 이클립스 설정')`))
    await js(`document.querySelector('input[name="run-preset-prepare"][value="maven"]').click()`)
    check('a build before the server is warned about as a command that runs', await until(`
      !!document.querySelector('.run-preset-tomcat [aria-label="Maven 목표"]') &&
      document.querySelector('.run-preset-confirm-note')?.textContent.includes('처음 실행할 때')`))
    // A Maven build brings Maven's settings under 고급 (which JDK runs Maven, the pin)
    check('a Maven build shows Maven\u2019s settings under 고급', await until(`
      !!document.querySelector('.run-preset-advanced .run-preset-maven #run-preset-maven-runner') &&
      document.querySelectorAll('.run-preset-maven input[name="run-preset-maven-source"]').length === 2`))
    check('a short, narrow run dialog scrolls its settings and keeps the title and submit button in place', await js(`(() => {
      const dialog = document.querySelector('.run-preset-dialog')
      const form = dialog.querySelector('.run-preset-form')
      const title = dialog.querySelector('.run-preset-title')
      const submit = dialog.querySelector('button[type="submit"]')
      const original = { width: dialog.style.width, maxHeight: dialog.style.maxHeight, scrollTop: form.scrollTop }
      dialog.style.width = '380px'
      dialog.style.maxHeight = '420px'
      try {
        const headerTop = title.getBoundingClientRect().top
        const buttonTop = submit.getBoundingClientRect().top
        form.scrollTop = form.scrollHeight
        return form.scrollTop > 0 && form.scrollWidth <= form.clientWidth + 1 && submit.form === form &&
          title.getBoundingClientRect().top === headerTop && submit.getBoundingClientRect().top === buttonTop &&
          submit.getBoundingClientRect().bottom <= dialog.getBoundingClientRect().bottom
      } finally {
        dialog.style.width = original.width
        dialog.style.maxHeight = original.maxHeight
        form.scrollTop = original.scrollTop
      }
    })()`))
    await shot('local-run-preset-advanced')
    await js(`document.querySelector('input[name="run-preset-kind"][value="custom"]').click()`)
    const server = path.join(__dirname, '..', 'support', 'devRunServer.js')
    await until(`!!document.querySelector('.run-preset-command')`)
    // Two spaces on purpose: the question must show the command as it runs
    const typed = `node "${server}" --crash-after  5000`
    await setValue('.run-preset-command', typed)
    check('a typed command is warned about in the dialog', await js(`!!document.querySelector('.run-preset-warn')`))
    // Stage 3: hot reload is for Spring Boot runs only; a typed command (the Node fixture) keeps it off
    check('바로 반영 is fixed to 끄기 for a typed command, with the reason', await until(`(() => {
      const field = document.querySelector('.run-preset-reload')
      if (!field || field.dataset.usable) return false
      const radio = value => field.querySelector('input[name="run-preset-reload"][value="' + value + '"]')
      return radio('off')?.checked && !radio('off').disabled && radio('standard')?.disabled && radio('enhanced')?.disabled &&
        /Spring Boot.* 실행에서만 됩니다\./.test(field.textContent)
    })()`))
    // The log encoding is for every kind (this typed command too) and is saved with the preset
    check('the log encoding offers 자동·UTF-8·MS949', await js(`[...document.querySelectorAll('#run-preset-log-encoding option')].map(o => o.value).join(',') === 'auto,utf-8,ms949'`))
    await js(`(() => { const select = document.querySelector('#run-preset-log-encoding'); select.value = 'utf-8'; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
    // A secret-looking env name: told it is saved as plain text (saving is not stopped); cleared before saving
    await setValue('#run-preset-env', 'DB_PASSWORD=hunter2')
    check('a secret-looking env name is warned about as plain text', await until(`
      document.querySelector('.run-preset-secret-warn')?.textContent.includes('평문으로 저장됩니다') &&
      document.querySelector('.run-preset-secret-warn').textContent.includes('DB_PASSWORD')`))
    await setValue('#run-preset-env', '')
    await js(`document.querySelector('.run-preset-dialog button[type="submit"]').click()`)
    const presetRow = `${section}?.querySelector('.run-preset')`
    check('the saved preset is a row with a start button', await until(`!document.querySelector('.run-preset-dialog') &&
      ${presetRow}?.textContent.includes('시험 서버') && !!${presetRow}.querySelector('[data-action="start"]')`, 8000))
    check('the chosen log encoding is saved with the preset', await js(`(async () => {
      const list = await window.electronAPI.runPresetsList(${JSON.stringify(repo)})
      return list.presets?.find(item => item.name === '시험 서버')?.logEncoding === 'utf-8'
    })()`))
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
    // 2026-11-26 user report: with its port and "오류 20", the row pushed 중지 and 더 보기 out of the sidebar.
    // An error count is put beside the port for the measure: every button stays inside the row, the name gives way.
    const fits = await js(`(() => {
      const row = ${presetRow}
      const state = row.querySelector('.run-preset-state')
      // As the row draws an error count: a warning sign and the number
      const extra = state.querySelector('.run-preset-pill').cloneNode()
      extra.classList.add('is-count')
      extra.innerHTML = '<svg width="10" height="10" aria-hidden="true"></svg>20'
      extra.dataset.kind = 'err'
      state.append(extra)
      const box = row.getBoundingClientRect()
      const buttons = [...row.querySelectorAll('.run-preset-main > .run-preset-btn, .run-preset-main > button')]
      const out = buttons.filter(button => { const b = button.getBoundingClientRect(); return b.width < 16 || b.right > box.right - 1 || b.left < box.left })
      const name = row.querySelector('.run-preset-name')
      const port = row.querySelector('.run-preset-pill[data-kind="port"]')
      const result = { buttons: buttons.length, portOpens: port?.tagName === 'BUTTON' && /브라우저로 열기/.test(port.getAttribute('aria-label') ?? ''), out: out.map(b => b.getAttribute('aria-label')), nameWidth: Math.round(name.getBoundingClientRect().width), row: Math.round(box.width),
        parts: [...row.querySelector('.run-preset-main').children].map(el => el.className.split(' ')[0].replace('run-preset-', '') + ':' + Math.round(el.getBoundingClientRect().width)).join(' ') }
      extra.remove()
      return result
    })()`)
    check('a running row with its port and an error count keeps all its buttons inside, its port opens the browser', fits.buttons >= 3 && fits.portOpens && fits.out.length === 0 && fits.nameWidth >= 20, JSON.stringify(fits))
    // The row tells the preset server's state (the tab of a local shell is its id)
    const presetShell = await js(`${activeTab}?.dataset.tabId`)
    // The tab keeps its status dot (seen with the sidebar folded); only the text chip is left to the card
    check('the old development chip leaves a preset server alone, the tab keeps its dot', await js(`!document.querySelector('.development-status-chip[data-development-shell="' + ${JSON.stringify(presetShell)} + '"]') &&
      !!${activeTab}?.querySelector('.development-status-dot')`), String(presetShell))
    await shot('local-run-preset-running')
    check('a crash turns the row red and tells the exit code', await until(`${presetRow}?.dataset.status === 'crashed' &&
      ${presetRow}.textContent.includes('종료 1')`, 15000))
    const notice = `document.querySelector('.run-crash')`
    const failureReason = `${presetRow}?.querySelector('.run-preset-failure-line')`
    check('the stopped row and notice explain the failure with credentials redacted by default', await until(`
      ${failureReason}?.textContent.includes('Internal server error: fixture failed pwd=****') &&
      ${notice}?.querySelector('.run-crash-reason')?.textContent.includes('Internal server error: fixture failed pwd=****') &&
      !${failureReason}.textContent.includes('fixture-terminal-only')`))
    check('the crash notice masks the credential while the terminal shows the original output', await until(`
      ${notice}?.textContent.includes('Internal server error: fixture failed pwd=****') &&
      !${notice}.textContent.includes('fixture-terminal-only') && ${inTerminal('fixture-terminal-only')}`, 5000))
    check('the crash notice action buttons share a height and top edge', await js(`
      (() => {
        const buttons = [...(${notice}?.querySelectorAll('.run-crash-actions > button') ?? [])]
          .map(button => button.getBoundingClientRect())
        return buttons.length === 3 && buttons[0].height > 0 && buttons.every(button =>
          Math.abs(button.y - buttons[0].y) < 1 && Math.abs(button.height - buttons[0].height) < 1)
      })()`))
    await shot('local-run-preset-crash')
    await js(`${notice}.querySelector('.btn-primary').click()`)
    // The preview is main's text (what goes out): the name, the folder relative to the project, the errors
    check('the hand-off dialog previews main’s text and opens sending after it', await until(`
      document.querySelector('.run-send-dialog .run-send-preview[data-ready]')?.textContent.startsWith('시험 서버') &&
      document.querySelector('.run-send-dialog .run-send-preview').textContent.includes('폴더 ./') &&
      document.querySelector('.run-send-dialog .run-send-preview').textContent.includes('Internal server error')`))
    await setValue('.run-send-note-input', '확인 부탁합니다 token=fixture-send-note')
    check('the preview includes the note and masks credentials from both the note and the log', await until(`
      (() => {
        const text = document.querySelector('.run-send-dialog .run-send-preview[data-ready]')?.textContent
        return text?.includes('pwd=****') && text.includes('확인 부탁합니다 token=****') &&
          !text.includes('fixture-send-note') && !text.includes('fixture-terminal-only')
      })()`))
    await shot('local-run-preset-send')
    await js(`[...document.querySelectorAll('.run-send-dialog button')].find(b => b.textContent.trim() === '취소').click()`)
    await until(`!document.querySelector('.run-send-dialog')`)
    // Run diagnosis: from the notice, and from the row's menu (a click inside must not open the row's log)
    await js(`${notice}.querySelector('.run-crash-diagnose').click()`)
    const diagnosis = `document.querySelector('.run-suggestions-dialog')`
    check('진단 보기 on the notice opens the diagnosis of the run', await until(`!!${diagnosis} &&
      (${diagnosis}.textContent.includes('로그에서 알려진 문제를 찾지 못했습니다') || !!${diagnosis}.querySelector('.run-suggestion'))`, 8000),
      await js(`${diagnosis}?.textContent`))
    await js(`[...${diagnosis}.querySelectorAll('button')].find(b => b.textContent.trim() === '닫기').click()`)
    await until(`!${diagnosis}`)
    // Another tab in front first: a click that reached the row would bring the preset's log tab forward
    await js(`[...document.querySelectorAll('.terminal-tab')].find(tab => tab.dataset.tabId !== ${JSON.stringify(presetShell)})?.click()`)
    await until(`${activeTab}?.dataset.tabId !== ${JSON.stringify(presetShell)}`)
    const tabBeforeDiagnosis = await js(`${activeTab}?.dataset.tabId`)
    await click(...await center(`${presetRow}.querySelector('[aria-label$="더 보기"]')`))
    await driver.pick('실행 진단')
    await until(`!!${diagnosis}`, 8000)
    await click(...await center(`${diagnosis}.querySelector('#run-suggestions-lead')`))
    check('실행 진단 in the row menu opens the same dialog, and neither the pick nor clicks in it open the row\u2019s log', await until(`!!${diagnosis}`) &&
      tabBeforeDiagnosis !== presetShell && await js(`${activeTab}?.dataset.tabId`) === tabBeforeDiagnosis,
      JSON.stringify({ before: tabBeforeDiagnosis, after: await js(`${activeTab}?.dataset.tabId`), presetShell }))
    await js(`[...${diagnosis}.querySelectorAll('button')].find(b => b.textContent.trim() === '닫기').click()`)
    await until(`!${diagnosis}`)
    await js(`[...${notice}.querySelectorAll('button')].find(b => b.textContent.includes('다시 실행')).click()`)
    check('다시 실행 clears both the notice and the previous failure reason', await until(
      `['starting', 'running'].includes(${presetRow}?.dataset.status) && !${notice} && !${failureReason}`, 10000))
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

    const maven = path.join(profile, 'Maven diagnosis fixture')
    fs.mkdirSync(maven)
    fs.writeFileSync(path.join(maven, 'pom.xml'), '<project>spring-boot-maven-plugin</project>')
    fs.writeFileSync(path.join(maven, 'mvnw.cmd'), '@echo off\r\nnode run.cjs %*\r\n')
    fs.writeFileSync(path.join(maven, 'mvnw'), '#!/bin/sh\nexec node run.cjs "$@"\n', { mode: 0o755 })
    fs.writeFileSync(path.join(maven, 'run.cjs'), `
      const fs = require('node:fs');
      const path = require('node:path');
      const { fileURLToPath } = require('node:url');
      const args = process.argv.slice(2);
      if (!args.includes('-gs')) {
        console.error('[ERROR] Could not transfer artifact sample:demo:jar:1 from/to maven-default-http-blocker (http://0.0.0.0/): Blocked mirror for repositories: [legacy (http://legacy.invalid/maven/, default)]');
        process.exit(1);
      }
      const local = args.find(arg => arg.startsWith('-Dmaven.repo.local='))?.slice('-Dmaven.repo.local='.length);
      const relative = path.join('sample', 'demo', '1');
      if (args.includes('-s')) {
        const contents = fs.readFileSync(args[args.indexOf('-s') + 1], 'utf8');
        const url = contents.split('<url>')[1]?.split('</url>')[0];
        const mirror = fileURLToPath(url);
        if (fs.readFileSync(path.join(mirror, relative, 'demo-1.jar'), 'utf8') !== 'pinned artifact') process.exit(2);
        if (!(args.filter(arg => arg === '-gs').length === 1 && args.filter(arg => arg === '-s').length === 1)) process.exit(3);
      } else if (local && fs.existsSync('repository-gone')) {
        console.error('[ERROR] Could not transfer artifact sample:demo:jar:1 from/to legacy (https://legacy.invalid/maven): status code: 401');
        process.exit(1);
      } else if (local) {
        const folder = path.join(local, relative);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'demo-1.jar'), 'pinned artifact');
        fs.writeFileSync(path.join(folder, '_remote.repositories'), 'demo-1.jar>legacy=\\n');
      }
      fs.writeFileSync('received.json', JSON.stringify(args));
      const property = '-Dspring-boot.run.jvmArguments=';
      const jvmOptions = args.find(arg => arg.startsWith(property))?.slice(property.length);
      fs.writeFileSync('received-spring-options.json', JSON.stringify({
        port: process.env.SERVER_PORT,
        vmArgs: process.env.EZSHELL_HOT_RELOAD_MAVEN_OPTIONS ?? jvmOptions
      }));
      console.log('BUILD SUCCESS');
    `)
    const folderArg = JSON.stringify(maven)
    const savedMaven = await js(`window.electronAPI.runPresetsSave(${folderArg}, ${JSON.stringify({
      name: 'Maven 설정 시험', kind: 'task', taskId: '.:maven', notify: false, port: 8181, vmArgs: '-Xmx512m -Dlabel="local backend"'
    })})`)
    if (!savedMaven?.preset) throw new Error('Could not create the Maven diagnosis fixture')
    const mavenId = savedMaven.preset.id
    const args = `${folderArg}, ${JSON.stringify(mavenId)}`
    const diagnose = `window.electronAPI.runPresetDiagnosis(${args})`
    const mavenState = `(await window.electronAPI.runPresetsList(${folderArg})).states[${JSON.stringify(mavenId)}]?.status`
    const initialMaven = await js(`window.electronAPI.runPresetStart(${args})`)
    if (!initialMaven.needsConfirm?.command.includes('Spring Boot 실행 포트\n8181') ||
        !initialMaven.needsConfirm.command.includes('Spring Boot VM 인자\n-Xmx512m -Dlabel="local backend"') ||
        !(await js(`window.electronAPI.runPresetStart(${args}, { confirmCustom: true })`)).ok) {
      throw new Error('The first Maven run did not require and accept approval')
    }
    if (!await until(`(async () => ${mavenState} === 'crashed' &&
      (await ${diagnose}).suggestions?.some(item => item.kind === 'mavenHttpBlocked'))()`, 15000)) {
      throw new Error('The failed Maven invocation did not produce a diagnosis')
    }
    const { suggestions } = await js(diagnose)
    const chosen = suggestions.find(item => item.kind === 'mavenHttpBlocked')
    const approved = { id: chosen.id, replacementUrl: 'https://mirror.example.test/maven/' }
    const accepted = await js(`window.electronAPI.runPresetApplySuggestion(${args}, ${JSON.stringify(approved)})`)
    const question = await js(`window.electronAPI.runPresetStart(${args})`)
    check('Maven replacement applies the diagnosed repository and needs a fresh execution confirmation',
      accepted.ok && accepted.preset.mavenMirrors[0].repositoryId === 'legacy' &&
      question.needsConfirm?.command.includes(approved.replacementUrl) && !fs.existsSync(path.join(maven, 'received.json')),
      JSON.stringify({ applied: accepted.ok, applyError: accepted.error, confirmation: Boolean(question.needsConfirm), startError: question.error }))
    check('the confirmed Spring Boot launch passes the saved mirror as a Maven settings argument',
      (await js(`window.electronAPI.runPresetStart(${args}, { confirmCustom: true })`)).ok &&
      await until(`(async () => ${mavenState} === 'stopped')()`, 15000))
    const received = JSON.parse(fs.readFileSync(path.join(maven, 'received.json'), 'utf8'))
    const settings = path.join(fs.realpathSync(profile), 'runtimes', 'maven-settings', `${mavenId}.xml`)
    check('the Maven launcher receives a single absolute settings filename',
      received.length === 4 && received[0] === 'spring-boot:run' && received[1] === '-gs' &&
      path.dirname(path.dirname(received[2])) === path.dirname(settings) && path.basename(received[2]) === path.basename(settings) &&
      fs.readFileSync(settings, 'utf8').includes('<mirrorOf>legacy</mirrorOf>'))
    const springOptions = JSON.parse(fs.readFileSync(path.join(maven, 'received-spring-options.json'), 'utf8'))
    check('the Maven launcher receives the port and quoted JVM options',
      received[3]?.startsWith('-Dspring-boot.run.jvmArguments=') &&
      springOptions.port === '8181' && springOptions.vmArgs === '-Xmx512m "-Dlabel=local backend"')

    const enabledPin = await js(`window.electronAPI.runPresetsSave(${folderArg}, ${JSON.stringify({ ...accepted.preset, mavenPin: true })})`)
    const pinStatus = `window.electronAPI.runPresetMavenPinStatus(${args})`
    const pinQuestion = await js(`window.electronAPI.runPresetStart(${args})`)
    check('a successfully completed Spring Maven PTY publishes its repository after confirmation',
      enabledPin.preset?.mavenPin === true && pinQuestion.needsConfirm?.command.includes('의존성 보관') &&
      (await js(`window.electronAPI.runPresetStart(${args}, { confirmCustom: true })`)).ok &&
      await until(`(async () => ${mavenState} === 'stopped' && (await ${pinStatus}).pinned)()`, 15000))
    fs.writeFileSync(path.join(maven, 'repository-gone'), '')
    await js(`window.electronAPI.runPresetStart(${args})`)
    check('Maven suggests replay after a repository becomes unauthorized', await until(`(async () => ${mavenState} === 'crashed' &&
      (await ${diagnose}).suggestions?.some(item => item.apply === 'mavenPinned'))()`, 15000))
    const pinnedSuggestion = (await js(diagnose)).suggestions.find(item => item.apply === 'mavenPinned')
    const selectedPin = await js(`window.electronAPI.runPresetApplySuggestion(${args}, { id: ${JSON.stringify(pinnedSuggestion.id)} })`)
    const replayQuestion = await js(`window.electronAPI.runPresetStart(${args})`)
    check('pinned replay uses the captured file mirror with exactly one settings argument per slot',
      selectedPin.preset?.mavenSource === 'pinned' && replayQuestion.needsConfirm?.command.includes('file:') &&
      (await js(`window.electronAPI.runPresetStart(${args}, { confirmCustom: true })`)).ok &&
      await until(`(async () => ${mavenState} === 'stopped')()`, 15000))
    const exportQuestion = await js(`window.electronAPI.runPresetExportMavenPin(${args})`)
    const exported = path.join(maven, '.mvn-repo', 'sample', 'demo', '1', 'demo-1.jar')
    check('export requires confirmation and writes the captured artifact to the active worktree',
      exportQuestion.needsConfirm?.command.includes('.mvn-repo/') && !fs.existsSync(exported) &&
      (await js(`window.electronAPI.runPresetExportMavenPin(${args}, { confirmCustom: true })`)).ok &&
      fs.readFileSync(exported, 'utf8') === 'pinned artifact')
    check('deleting the preset removes temporary and online settings while retaining the pin',
      (await js(`window.electronAPI.runPresetsDelete(${args})`)).ok && !fs.existsSync(settings) && !fs.existsSync(received[2]) &&
      fs.readdirSync(path.join(profile, 'runtimes', 'maven-pinned', mavenId)).some(name => name.startsWith('repo-')))

    const dbFolder = path.join(profile, 'database startup fixture')
    fs.mkdirSync(dbFolder)
    fs.writeFileSync(path.join(dbFolder, 'fail.cjs'), `
      console.error('ERROR o.h.engine.jdbc.spi.SqlExceptionHelper : Socket fail to connect to host:address=(host=localhost)(port=3306)(type=primary). Connection refused: getsockopt')
      console.error('[ERROR] Process terminated with exit code: 1')
      console.error('[ERROR] [Help 1] http://example.test/help')
      process.exitCode = 1
    `)
    const dbArg = JSON.stringify(dbFolder)
    const database = await js(`window.electronAPI.runPresetsSave(${dbArg}, {
      name: 'DB 기동 시험', kind: 'custom', command: 'node fail.cjs', notify: false
    })`)
    if (!database?.preset) throw new Error('Could not save the DB failure fixture')
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([dbFolder, repo]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    const dbRow = `document.querySelector('.run-preset[data-run-preset="${database.preset.id}"]')`
    if (!await until(`!!${dbRow}`)) throw new Error('Could not find the DB failure fixture row')
    const dbArgs = `${dbArg}, ${JSON.stringify(database.preset.id)}`
    const dbQuestion = await js(`window.electronAPI.runPresetStart(${dbArgs})`)
    if (!dbQuestion.needsConfirm?.command.includes('node fail.cjs')) throw new Error(`Unexpected DB fixture confirmation: ${JSON.stringify(dbQuestion)}`)
    const dbRun = await js(`window.electronAPI.runPresetStart(${dbArgs}, { confirmCustom: true })`)
    check('a startup failure identifies the DB and port on the row without a notification', dbRun.ok &&
      await until(`${dbRow}?.querySelector('.run-preset-failure-line')?.textContent === 'DB 점검 필요 · 3306 포트 연결 실패'`) &&
      !await js(`!!document.querySelector('.run-crash[data-run-preset="${database.preset.id}"]')`), JSON.stringify(dbRun))
    await shot('local-run-preset-db-failure')
    await js(`${dbRow}?.querySelector('.run-preset-failure-line')?.click()`)
    check('the failure reason opens the DB diagnosis with a connection check', await until(
      `${diagnosis}?.querySelector('.run-suggestion')?.textContent.includes('설정한 호스트와 포트에서 접속할 수 있는지')`))
  } finally { driver.close() }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
