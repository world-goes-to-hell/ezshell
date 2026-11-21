// Run against a disposable Git repository and app profile.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { connect, createChecks, SET, unlock, openLocalProject } = require('../support/driver')

const { check, finish } = createChecks()

async function run() {
  const repo = path.join(process.env.E2E_PROFILE, 'sample repo')
  const plain = path.join(process.env.E2E_PROFILE, 'plain folder')
  fs.mkdirSync(repo)
  fs.mkdirSync(plain)
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })
  git('init', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  git('config', 'core.hooksPath', '.git/no-hooks')
  fs.writeFileSync(path.join(repo, 'note.txt'), 'original\n')
  git('add', 'note.txt')
  git('-c', 'user.name=ezShell Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Initial commit')
  fs.writeFileSync(path.join(repo, 'note.txt'), 'unsaved local change\n')

  const driver = await connect()
  try {
    const { js, until, center, menuPick } = driver
    await unlock(driver)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([repo, plain]))})`)

    const openDialog = async () => {
      await openLocalProject(driver)
      if (!(await until(`!!document.querySelector('.local-project-dialog')`))) throw new Error('local project dialog did not open')
    }
    const select = (id, value) => js(`(() => {
      const input = document.getElementById(${JSON.stringify(id)})
      input.value = ${JSON.stringify(value)}
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    const visiblePanes = `[...document.querySelectorAll('.local-terminal-pane')].filter(el => getComputedStyle(el).visibility === 'visible')`
    const paneHas = (fragment, count = 1) => until(`${visiblePanes}.filter(el => el.textContent.includes(${JSON.stringify(fragment)})).length === ${count}`, 20000)
    const submit = () => js(`document.querySelector('.local-project-dialog button[type=submit]').click()`)

    await openDialog()
    check('current directory is the default in a Git project', await until(`document.querySelector('#local-project-target')?.value === 'current'`))
    await submit()
    check('the shell is started in the original repository', await paneHas('sample repo'))
    check('opening the current folder creates no worktree', git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length === 1)

    await openDialog()
    await select('local-project-folder', plain)
    check('ordinary folders can open with no Git options', await until(`!document.querySelector('#local-project-target') && !!document.querySelector('.local-project-dialog button[type=submit]')`))
    await submit()
    check('the ordinary folder opens as a shell', await paneHas('plain folder'))

    await openDialog()
    await until(`!!document.querySelector('#local-project-target')`)
    await select('local-project-target', 'new')
    await js(`(${SET})(document.querySelector('#local-project-branch'), 'feature/check')`)
    await submit()
    const location = path.join(process.env.E2E_PROFILE, 'sample repo-feature-check')
    check('the new branch opens in its own directory', await paneHas('sample repo-feature-check'))
    check('the new checkout contains the committed version', fs.readFileSync(path.join(location, 'note.txt'), 'utf8') === 'original\n')
    check('the original branch and dirty changes are still present', git('branch', '--show-current').trim() === 'main' &&
      fs.readFileSync(path.join(repo, 'note.txt'), 'utf8') === 'unsaved local change\n')

    const point = await center(`${visiblePanes}[0]`)
    if (point) await menuPick(...point, '분할', '좌우 분할')
    check('the new split shell opens in the worktree too', await paneHas('sample repo-feature-check', 2))

    await openDialog()
    check('the worktree is available when opening the project again', await until(`
      [...(document.querySelector('#local-project-target')?.options ?? [])].some(option => option.value === ${JSON.stringify(location)})
    `))
    await select('local-project-target', location)
    await submit()
    check('the existing worktree reopens with a new shell', await paneHas('sample repo-feature-check'))
    check('reopening does not duplicate the worktree', git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length === 2)
  } finally {
    driver.close()
  }
}

run().then(finish).catch(error => {
  console.error(error)
  process.exitCode = 1
})
