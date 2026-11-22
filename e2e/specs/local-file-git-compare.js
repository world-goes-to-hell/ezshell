const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, unlock } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const repo = path.join(process.env.E2E_PROFILE, 'git-compare')
  const name = 'sample.txt'
  const oldName = 'original name.txt'
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Git Compare', '-c', 'user.email=compare@example.invalid', ...args], {
    cwd: repo, encoding: 'utf8', stdio: 'pipe', windowsHide: true
  })
  git('init', '-b', 'main')
  fs.writeFileSync(path.join(repo, oldName), 'first snapshot\n')
  git('add', oldName)
  git('commit', '-m', 'Add original')
  const first = git('rev-parse', 'HEAD').trim()
  git('mv', oldName, name)
  git('commit', '-m', 'Rename file')
  fs.writeFileSync(path.join(repo, name), 'committed version\n')
  git('add', name)
  git('commit', '-m', 'Update file')
  const latest = git('rev-parse', 'HEAD').trim()
  fs.writeFileSync(path.join(repo, 'another.txt'), 'unrelated\n')
  git('add', 'another.txt')
  git('commit', '-m', 'Unrelated commit')
  fs.writeFileSync(path.join(repo, name), 'working version\n')

  const main = await connect()
  let file
  try {
    await unlock(main)
    await main.js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([repo]))})
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    const worktree = 'document.querySelector(".local-worktree-open")'
    if (!(await main.until(`!!${worktree}`))) throw new Error('the fixture worktree was not listed')
    await main.js(`${worktree}.click()`)
    if (!(await main.until('!!document.querySelector(".local-terminal-host .xterm-helper-textarea")'))) {
      throw new Error('the fixture shell did not open')
    }
    const result = await main.js(`window.electronAPI.localFileOpen(${JSON.stringify(repo)}, ${JSON.stringify(name)}, 'edit', 'Git 비교')`)
    if (!result?.success) throw new Error('the fixture file did not open: ' + JSON.stringify(result))
    file = await connect(target => target.url.includes('remoteFileMode=true'))
    const toggle = `document.querySelector('button[aria-label="Git 이력 비교"]')`
    if (!(await file.until(`!!${toggle}`))) throw new Error('the Git comparison action was not available')

    const shortcutHelp = `document.querySelector('button[aria-label="단축키 설명 보기"]')`
    const shortcutList = `document.querySelector('.remote-file-shortcut-tooltip')`
    check('the editor footer keeps the shortcuts behind one button', await file.js(`!!${shortcutHelp} && !${shortcutList}`))
    await file.send('Page.bringToFront')
    const helpAt = await file.center(shortcutHelp)
    if (!helpAt) throw new Error('the shortcuts button was not available')
    await file.move(...helpAt)
    check('hovering opens the editor shortcuts above the footer', await file.until(`
      ${shortcutList}?.querySelectorAll('kbd').length === 4
      && ${shortcutList}.getBoundingClientRect().bottom < ${shortcutHelp}.getBoundingClientRect().top
    `))
    await file.move(24, 80)
    check('the shortcut list closes when the pointer leaves', await file.until(`!${shortcutList}`))
    await file.js(`${shortcutHelp}.focus()`)
    check('keyboard focus also reveals the shortcut list', await file.until(`!!${shortcutList}`))
    await file.js(`${toggle}.focus()`)

    await file.js(`${toggle}.click()`)
    const panel = `document.querySelector('.remote-backup-panel[aria-label="Git 비교"]')`
    const rows = `[...(${panel}?.querySelectorAll('button.backup-entry.is-git') ?? [])]`
    const head = `${rows}[0]`
    check('HEAD is followed by every commit that changed the file, including its previous name', await file.until(`(() => {
      const description = ${panel}?.querySelector('.remote-backup-header .backup-git-description')
      const rows = ${rows}
      return !!description && !description.closest('button, [role=button]')
        && rows.length === 4 && rows[0].querySelector('.backup-head-label')?.textContent === 'HEAD'
        && rows.slice(1).map(row => row.querySelector('.backup-git-subject')?.textContent).join(',') === 'Update file,Rename file,Add original'
    })()`))
    await file.shot('local-file-git-compare')
    await file.js(`${head}.click()`)
    check('clicking HEAD previews the committed version', await file.until(`
      ${head}?.classList.contains('is-selected')
      && (${panel}.querySelector('.remote-backup-preview .remote-backup-text')?.textContent ?? '').includes('committed version')
    `))
    await file.js(`${rows}[3].click()`)
    check('a commit from before the rename previews its original content', await file.until(`
      ${rows}[3].classList.contains('is-selected') &&
      ${panel}.querySelector('.remote-backup-text').textContent === 'first snapshot\\n'
    `))
    check('the preview buttons have the same size and line up', await file.js(`(() => {
      const [compare, restore] = [...document.querySelectorAll('.backup-preview-actions > button')]
        .map(button => button.getBoundingClientRect())
      return !!compare && !!restore && compare.width > 0 && compare.height > 0
        && compare.width === restore.width && compare.height === restore.height && compare.top === restore.top
    })()`))
    await file.js(`document.querySelector('.backup-compare-btn').click()`)
    const sides = `[...document.querySelectorAll('.remote-compare-host .cm-content')].map(side => side.textContent)`
    const picker = `document.querySelector('.remote-compare-pick select')`
    check('the historical snapshot compares against the current working copy', await file.until(`
      ${picker}?.value === ${JSON.stringify('server:' + first)} &&
      ${sides}[0]?.includes('first snapshot') && ${sides}[1]?.includes('working version')
    `))
    const previousHeader = `document.querySelector('.remote-compare-head.is-previous')`
    const currentHeader = `document.querySelector('.remote-compare-head.is-current')`
    check('the two sides have distinct headings, backgrounds, and editor labels', await file.js(`(() => {
      const previous = ${previousHeader}.querySelector('h3')
      const current = ${currentHeader}.querySelector('h3')
      const [leftEditor, rightEditor] = document.querySelectorAll('.remote-compare-host .cm-content')
      return previous.textContent.trim() === '이전 버전' && current.textContent.trim() === '현재 내용'
        && ${previousHeader}.textContent.includes('Add original') && ${previousHeader}.textContent.includes('읽기 전용')
        && ${currentHeader}.textContent.includes('저장됨')
        && getComputedStyle(${previousHeader}).backgroundColor !== getComputedStyle(${currentHeader}).backgroundColor
        && leftEditor.getAttribute('aria-labelledby') === previous.id && rightEditor.getAttribute('aria-labelledby') === current.id
    })()`))
    await file.js(`document.querySelectorAll('.remote-compare-host .cm-content')[1].focus()`)
    await file.send('Input.insertText', { text: 'draft ' })
    check('editing the current side marks its header as unsaved', await file.until(`
      ${currentHeader}.querySelector('.remote-compare-head-state.is-dirty')?.textContent === '저장하지 않은 변경'
      && ${sides}[0]?.includes('first snapshot') && ${sides}[1]?.includes('draft ')
    `))
    await file.js(`(() => {
      const select = ${picker}
      select.value = ${JSON.stringify('server:' + latest)}
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    check('the comparison can switch to another commit without closing', await file.until(`
      ${sides}[0]?.includes('committed version') && ${sides}[1]?.includes('working version')
    `))
    const close = `document.querySelector('.remote-compare-close')`
    check('compare has a prominent close button', await file.until(`(() => {
      const button = ${close}
      return !!button && button.matches('.btn-primary') && button.getBoundingClientRect().height >= 29
        && getComputedStyle(button).backgroundColor !== getComputedStyle(button.parentElement).backgroundColor
    })()`))
    await file.js(`${close}.click()`)
    check('closing the comparison returns to the editor', await file.until(`!${close} && !document.querySelector('.remote-edit-pane').hidden`))
  } finally {
    file?.close()
    main.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
