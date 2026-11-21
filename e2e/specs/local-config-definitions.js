// Placeholders in a config file (`${UPLOAD_DIR:./uploads}`): Ctrl + click lists where the name is set
// in the work folder, picking one opens that file at the line (highlighted); a name set in one place
// opens there at once. Run by e2e/run.js (fresh profile, no server needed).
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, unlock, findPage, pages, pageProblems } = require('../support/driver')

const { check, finish } = createChecks()
const CTRL = 2

;(async () => {
  const repo = path.join(process.env.E2E_PROFILE, 'config repo')
  fs.mkdirSync(path.join(repo, 'deploy'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'application.yml'), 'app:\n  upload:\n    dir: ${UPLOAD_DIR:./uploads}\n  db: ${DB_URL}\n')
  fs.writeFileSync(path.join(repo, '.env'), '# settings\nDB_URL=jdbc:mariadb://db/app\nUPLOAD_DIR=/data/uploads\n')
  fs.writeFileSync(path.join(repo, 'deploy', 'docker-compose.yml'), 'services:\n  app:\n    environment:\n      UPLOAD_DIR: /srv/uploads\n')
  fs.writeFileSync(path.join(repo, 'node_modules', 'x', '.env'), 'UPLOAD_DIR=/should/not/show\n')
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe', windowsHide: true })

  const driver = await connect()
  const { js, until } = driver
  let editor
  const visiblePane = '.remote-file-pane:not([hidden])'
  const selectedTab = `document.querySelector('.remote-file-tab-select[aria-selected="true"] .remote-file-tab-name')`
  const ctrlClickOn = async (page, text) => {
    const at = await page.js(`(() => {
      const el = [...document.querySelectorAll('${visiblePane} .cm-placeholder-ref')].find(e => e.textContent.includes(${JSON.stringify(text)}))
      if (!el) return null
      const r = el.getBoundingClientRect()
      return [r.left + r.width / 2, r.top + r.height / 2]
    })()`)
    if (!at) return false
    await page.send('Page.bringToFront')
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', buttons: 1, clickCount: 1, modifiers: CTRL })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', buttons: 0, clickCount: 1, modifiers: CTRL })
    return true
  }
  const highlighted = `document.querySelector('${visiblePane} .cm-revealed-line')?.textContent`
  const revealed = (page) => page.js(highlighted)

  try {
    await unlock(driver)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([repo]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    await until(`!!document.querySelector('.local-worktree-open')`)
    await js(`document.querySelector('.local-worktree-open').click()`)
    await until(`!!document.querySelector('.local-terminal-host .xterm-helper-textarea')`)
    await js(`document.querySelector('.workspace-indicator').click()`)
    await js(`document.querySelector('#workspace-tab-files').click()`)
    const row = name => `[...document.querySelectorAll('.workspace-tree-row')].find(r => r.textContent.trim() === ${JSON.stringify(name)})`
    await until(`!!${row('application.yml')}`, 15000)

    await js(`${row('application.yml')}.click()`)
    const target = await findPage(t => t.url.includes('remoteFileMode'), 15000)
    check('the config file opens in the file window', !!target)
    if (!target) throw new Error('no file window')
    const yml = editor = await connect(t => t.id === target.id)
    const selectYml = () => yml.js(`[...document.querySelectorAll('.remote-file-tab-select')].find(tab => tab.textContent.trim() === 'application.yml').click()`)
    check('placeholders are underlined', await yml.until(`document.querySelectorAll('.cm-placeholder-ref').length === 2`, 15000))

    // ---- Set in two places: a list ----
    await ctrlClickOn(yml, 'UPLOAD_DIR')
    const items = `[...document.querySelectorAll('.definition-list-item')]`
    check('Ctrl + click lists where the name is set', await yml.until(`${items}.length === 2`, 15000), await yml.js(`document.querySelector('.definition-list')?.textContent ?? null`))
    const listed = await yml.js(`${items}.map(i => i.textContent)`)
    check('with each file, line and value, and nothing from generated folders',
      listed.some(t => t.includes('.env') && t.includes(':3') && t.includes('UPLOAD_DIR=/data/uploads')) &&
      listed.some(t => t.includes('docker-compose.yml') && t.includes(':4') && t.includes('UPLOAD_DIR: /srv/uploads')) &&
      !listed.some(t => t.includes('should/not/show')), JSON.stringify(listed))
    check('the default written in the placeholder is shown first', (await yml.js(`document.querySelector('.definition-list-fallback code')?.textContent`)) === './uploads')
    await yml.send('Page.captureScreenshot', { format: 'png' }).then(r => r?.result?.data && fs.writeFileSync(path.join(process.env.E2E_OUT, 'local-config-definitions-list.png'), Buffer.from(r.result.data, 'base64')))

    await yml.js(`${items}.find(i => i.textContent.includes('docker-compose.yml')).click()`)
    check('picking one opens that file in a tab', await yml.until(`${selectedTab}?.textContent === 'docker-compose.yml'`))
    check('at its line, highlighted', await yml.until(`(${highlighted} || '').includes('UPLOAD_DIR: /srv/uploads')`, 5000), String(await revealed(yml)))
    check('the list closes after picking', await yml.until(`!document.querySelector('.definition-list')`, 3000))

    // ---- Set in one place: opened at once ----
    await selectYml()
    await yml.until(`${selectedTab}?.textContent === 'application.yml'`)
    await ctrlClickOn(yml, 'DB_URL')
    check('a name set in one place opens that file at once', await yml.until(`(${highlighted} || '').includes('DB_URL=jdbc')`, 15000), String(await revealed(yml)))

    // ---- Opening an already open file only moves to the line ----
    await selectYml()
    await yml.until(`${selectedTab}?.textContent === 'application.yml'`)
    await ctrlClickOn(yml, 'UPLOAD_DIR')
    await yml.until(`${items}.length === 2`, 15000)
    await yml.js(`${items}.find(i => i.textContent.includes('.env')).click()`)
    check('an open file is brought forward at the line instead of opening again', await yml.until(`(${highlighted} || '').includes('UPLOAD_DIR=/data/uploads')`, 8000) &&
      await yml.js(`document.querySelectorAll('.remote-file-tab-select').length === 3`) &&
      (await pages()).filter(t => t.url.includes('remoteFileMode')).length === 1, String(await revealed(yml)))

    const problems = await pageProblems(yml)
    check('the file window has no console errors or CSP refusals', problems.length === 0, problems.join(' || '))
  } finally {
    editor?.close()
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
