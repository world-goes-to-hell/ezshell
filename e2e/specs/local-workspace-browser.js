// The files and Git tabs follow the current local shell, including a change of folder and split focus.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, unlock, SET } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const repo = path.join(process.env.E2E_PROFILE, 'workspace repo')
  const nested = path.join(repo, 'nested folder')
  const backend = path.join(repo, 'checkouts', 'backend')
  const frontend = path.join(process.env.E2E_PROFILE, 'frontend')
  const frontendRepo = path.join(repo, 'frontend')
  fs.mkdirSync(nested, { recursive: true })
  fs.writeFileSync(path.join(repo, 'README.md'), 'main folder')
  fs.writeFileSync(path.join(nested, 'nested.txt'), 'nested folder')
  const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Workspace Test', '-c', 'user.email=workspace@example.invalid', ...args], {
    cwd, stdio: 'pipe', windowsHide: true, encoding: 'utf8'
  })
  const git = (...args) => gitIn(repo, ...args)
  git('init', '-b', 'main')
  git('add', '.')
  git('commit', '-m', 'Create workspace')
  git('switch', '-c', 'feature')
  git('commit', '--allow-empty', '-m', 'Develop feature')
  git('switch', 'main')
  git('commit', '--allow-empty', '-m', 'Update main')
  git('merge', '--no-ff', 'feature', '-m', 'Merge feature')
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\n/checkouts/\n/frontend/\n')
  git('worktree', 'add', '-b', 'backend', '--', backend)
  gitIn(backend, 'commit', '--allow-empty', '-m', 'Backend checkout commit')
  fs.writeFileSync(path.join(backend, 'backend-draft.txt'), 'backend changes')
  fs.mkdirSync(frontendRepo)
  gitIn(frontendRepo, 'init', '-b', 'frontend-main')
  gitIn(frontendRepo, 'commit', '--allow-empty', '-m', 'Independent frontend repository')

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
    const cdTo = folder => process.platform === 'win32'
      ? `Set-Location -LiteralPath '${folder.replace(/'/g, "''")}'`
      : `cd -- '${folder.replace(/'/g, "'\\''")}'`
    const cd = cdTo(nested)
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
    const mainOnlyHash = git('rev-parse', '--short', 'HEAD').trim()
    git('worktree', 'add', '-b', 'frontend', '--', frontend)
    gitIn(frontend, 'commit', '--allow-empty', '-m', 'Frontend checkout commit')
    await js(`document.querySelector('.workspace-browser-header [aria-label="새로 고침"]').click()`)
    check('refresh reads commits added while the panel was open', await until(`
      document.querySelector('.workspace-commit-subject')?.textContent === 'Refresh this commit'
    `))
    const picker = `document.querySelector('.workspace-git-picker button')`
    const branch = `document.querySelector('.workspace-branch')?.title`
    const subjects = `[...document.querySelectorAll('.workspace-commit-subject')].map(node => node.textContent)`
    const selectWorktree = async label => {
      await until(`!!${picker}`)
      await driver.click(...await driver.center(picker))
      const option = `[...document.querySelectorAll('[role=menuitemradio]')].find(node => node.textContent.trim() === ${JSON.stringify(label)})`
      if (!(await until(`!!${option}`))) throw new Error(`Git picker is missing ${label}`)
      await driver.click(...await driver.center(`(${option})`))
    }
    await selectWorktree('frontend · 워크트리')
    check('refresh adds the new external worktree without opening a terminal', await until(`
      ${branch} === 'frontend' && ${subjects}[0] === 'Frontend checkout commit' &&
      !${subjects}.includes('Backend checkout commit') && document.querySelectorAll('.local-terminal-pane').length === 1
    `))
    await selectWorktree('frontend · 하위 저장소')
    check('a nested repository with the same folder name has its own picker entry and history', await until(`
      ${branch} === 'frontend-main' && ${subjects}.join() === 'Independent frontend repository'
    `))
    await selectWorktree('checkouts/backend')
    check('the nested worktree shows its own HEAD, history and uncommitted changes', await until(`
      ${branch} === 'backend' && ${subjects}[0] === 'Backend checkout commit' &&
      !${subjects}.includes('Refresh this commit') && !!document.querySelector('[data-path="backend-draft.txt"]')
    `))
    const search = value => js(`(${SET})(document.querySelector('input[aria-label="Git 이력 검색"]'), ${JSON.stringify(value)})`)
    await search(mainOnlyHash)
    check('a hash outside the worktree history is not returned by search', await until(`
      document.querySelector('.workspace-note')?.textContent === '일치하는 커밋이 없습니다.'
    `))
    await search('Backend checkout')
    check('commit search reads the selected worktree', await until(`
      document.querySelector('.workspace-git-list[aria-label="Git 커밋 검색 결과"]') && ${subjects}.join() === 'Backend checkout commit'
    `))
    await selectWorktree('전체 브랜치')
    check('all branches restores the shared history', await until(`
      ${subjects}.includes('Refresh this commit') && ${subjects}.includes('Backend checkout commit') && ${subjects}.includes('Frontend checkout commit')
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
    await selectWorktree('frontend · 워크트리')
    await until(`${branch} === 'frontend' && ${subjects}[0] === 'Frontend checkout commit'`)
    await js(`${splits}[0].querySelector('.xterm-helper-textarea').focus()`)
    await send('Input.insertText', { text: cdTo(backend) })
    await driver.enter()
    check('cd into a nested worktree follows the terminal into its history', await until(`
      ${branch} === 'backend' && ${subjects}[0] === 'Backend checkout commit'
    `))
    await send('Input.insertText', { text: cdTo(frontendRepo) })
    await driver.enter()
    check('cd into an independent repository also follows it without dropping the project picker', await until(`
      ${branch} === 'frontend-main' && ${subjects}.join() === 'Independent frontend repository' && !!${picker}
    `))
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
