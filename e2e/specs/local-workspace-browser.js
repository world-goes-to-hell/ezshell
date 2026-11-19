// The files and Git tabs follow the current local shell, including a change of folder and split focus.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, unlock } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const repo = path.join(process.env.E2E_PROFILE, 'workspace repo')
  const nested = path.join(repo, 'nested folder')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(repo, 'README.md'), 'main folder')
  fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested folder')
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Workspace Test', '-c', 'user.email=workspace@example.invalid', ...args], {
    cwd: repo, stdio: 'pipe', windowsHide: true
  })
  git('init', '-b', 'main')
  git('add', '.')
  git('commit', '-m', 'Create workspace')
  git('switch', '-c', 'feature')
  git('commit', '--allow-empty', '-m', 'Develop feature')
  git('switch', 'main')
  git('commit', '--allow-empty', '-m', 'Update main')
  git('merge', '--no-ff', 'feature', '-m', 'Merge feature')

  const driver = await connect()
  const { js, until, send } = driver
  try {
    await unlock(driver)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([repo]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    await until(`!!document.querySelector('.local-worktree-open')`)
    await js(`document.querySelector('.local-worktree-open').click()`)
    await until(`!!document.querySelector('.local-terminal-host .xterm-helper-textarea')`)
    await js(`document.querySelector('.workspace-indicator').click()`)
    const section = id => js(`document.querySelector('#workspace-tab-${id}').click()`)
    const tabStrip = await js(`(() => {
      const workspace = document.querySelector('.workspace-header')
      const tabs = document.querySelector('.terminal-tabs').getBoundingClientRect()
      const header = workspace.getBoundingClientRect()
      return {
        aligned: Math.abs(tabs.top - header.top) < 1 && Math.abs(tabs.bottom - header.bottom) < 1,
        labels: [...workspace.querySelectorAll('[role=tab]')].map(tab => tab.getAttribute('aria-label')),
        iconOnly: workspace.textContent.trim() === '' && workspace.querySelectorAll('[role=tab] > svg').length === 3
      }
    })()`)
    check('the icon-only workspace tabs align with the main tab strip and retain their names',
      tabStrip.aligned && tabStrip.iconOnly && tabStrip.labels.join(',') === '대화 기록,파일,Git 기록', JSON.stringify(tabStrip))

    await section('files')
    // The files are a tree now: each entry is a .workspace-tree-item with its own row button
    const file = (name, kind) => `[...document.querySelectorAll('.workspace-tree-item')].some(row =>
      row.querySelector(':scope > .workspace-tree-row')?.textContent.trim() === ${JSON.stringify(name)}${kind ? ` && row.dataset.kind === ${JSON.stringify(kind)}` : ''})`
    check('files opens at the worktree and shows both directories and files', await until(`
      ${file('README.md', 'file')} && ${file('nested folder', 'directory')}
    `))

    await js(`document.querySelector('.local-terminal-host .xterm-helper-textarea').focus()`)
    const cd = process.platform === 'win32'
      ? `Set-Location -LiteralPath '${nested.replace(/'/g, "''")}'`
      : `cd -- '${nested.replace(/'/g, "'\\''")}'`
    await send('Input.insertText', { text: cd })
    await driver.enter()
    check('cd updates the directory and replaces the files shown', await until(`
      document.querySelector('.workspace-browser-path')?.title === ${JSON.stringify(nested)} &&
      ${file('nested.txt')} && !${file('README.md')}
    `))

    await section('git')
    check('Git reads the repository from the subfolder and shows real merge edges', await until(`(() => {
      const rows = [...document.querySelectorAll('.workspace-git-commit')]
      return rows.length === 4 && rows[0].dataset.merge === 'true' &&
        rows[0].textContent.includes('Merge feature') && rows[0].textContent.includes('HEAD') &&
        rows[0].querySelectorAll('path[data-segment=parent]').length === 2
    })()`))
    git('commit', '--allow-empty', '-m', 'Refresh this commit')
    await js(`document.querySelector('.workspace-browser-header button').click()`)
    check('refresh reads commits added while the panel was open', await until(`
      document.querySelector('.workspace-commit-subject')?.textContent === 'Refresh this commit'
    `))

    await section('files')
    const bounds = await js(`(() => {
      const { x, y, width, height } = document.querySelector('.local-terminal-pane').getBoundingClientRect()
      return { x, y, width, height }
    })()`)
    const y = bounds.y + bounds.height / 2
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bounds.x + bounds.width * .25, y, button: 'left', buttons: 1, modifiers: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bounds.x + bounds.width * .75, y, buttons: 1, modifiers: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bounds.x + bounds.width * .75, y, button: 'left', modifiers: 1 })
    const splits = `document.querySelectorAll('.local-terminal-pane[data-local-shell-id]')`
    check('the tab can open a second shell', await until(`${splits}.length === 2`))
    await js(`${splits}[1].querySelector('.xterm-helper-textarea').focus()`)
    check('focusing the other split shows its own working folder', await until(file('README.md')))
    await js(`${splits}[0].querySelector('.xterm-helper-textarea').focus()`)
    check('focus back in the first split returns to the subfolder', await until(file('nested.txt')))

    // Moving the focus between shells in the same folder does not read the folder again (the tree
    // stays as it is), and the Git log is not read again inside the same repository
    await send('Input.insertText', { text: process.platform === 'win32' ? `Set-Location -LiteralPath '${repo.replace(/'/g, "''")}'` : `cd -- '${repo.replace(/'/g, "'\\''")}'` })
    await driver.enter()
    await until(file('README.md'))
    await js(`document.querySelector('.workspace-content').firstElementChild.dataset.keep = 'yes'; document.querySelector('.workspace-tree-item').dataset.keep = 'yes'`)
    await js(`${splits}[1].querySelector('.xterm-helper-textarea').focus()`)
    await new Promise(resolve => setTimeout(resolve, 2500))
    await js(`${splits}[0].querySelector('.xterm-helper-textarea').focus()`)
    await new Promise(resolve => setTimeout(resolve, 2500))
    check('switching between shells in the same folder keeps the files tree as it is',
      await js(`document.querySelector('.workspace-tree-item')?.dataset.keep === 'yes'`))
    await section('git')
    await until(`document.querySelectorAll('.workspace-git-commit').length === 5`)
    await js(`document.querySelector('.workspace-git-commit').dataset.keep = 'yes'`)
    await js(`${splits}[0].querySelector('.xterm-helper-textarea').focus()`)
    await send('Input.insertText', { text: cd })
    await driver.enter()
    await new Promise(resolve => setTimeout(resolve, 2500))
    await js(`${splits}[1].querySelector('.xterm-helper-textarea').focus()`)
    await new Promise(resolve => setTimeout(resolve, 2500))
    check('the Git log is not read again for another shell or folder of the same repository',
      await js(`document.querySelector('.workspace-git-commit')?.dataset.keep === 'yes' && document.querySelectorAll('.workspace-git-commit').length === 5`))
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
