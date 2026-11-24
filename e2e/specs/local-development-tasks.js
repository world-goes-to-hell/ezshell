const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE
const repo = path.join(profile, 'development repo')
const backTree = path.join(profile, 'checkout-backend')
const frontTree = path.join(profile, 'checkout-frontend')

function fixture() {
  const git = (folder, ...args) => execFileSync('git', args, { cwd: folder, stdio: 'pipe', windowsHide: true })
  const run = `
    console.log('Development fixture running in ' + process.cwd());
    if (process.argv[2]) console.log('Received ' + process.argv[2]);
    setTimeout(() => {}, 60000);
  `
  fs.mkdirSync(path.join(repo, 'backend'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'frontend'))
  fs.writeFileSync(path.join(repo, 'README.md'), '# Development fixture\n')
  fs.writeFileSync(path.join(repo, 'backend', 'build.gradle'), "plugins { id 'org.springframework.boot' }\n")
  fs.writeFileSync(path.join(repo, 'backend', 'gradlew.bat'), '@echo off\r\nnode run.cjs %*\r\n')
  fs.writeFileSync(path.join(repo, 'backend', 'gradlew'), '#!/bin/sh\nexec node run.cjs "$@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(repo, 'backend', 'run.cjs'), run)
  fs.writeFileSync(path.join(repo, 'frontend', 'run.cjs'), run)
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
  fixture()
  const driver = await connect()
  const { js, until, click, center, shot } = driver
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
    await js(`document.querySelectorAll('.terminal-tab .tab-close').forEach(button => button.click())`)
  } finally { driver.close() }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
