// The workspace panel opens what it lists (docs/plan/2026-11-19-workspace-files-and-git-details.md):
// folders expand in place, a file opens in the file window and saves to disk, the file window compares
// with Git HEAD, the Git tab lists the uncommitted changes and a commit's files with their diffs.
// Folders outside the open local shell's folder and repository are refused.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, unlock, findPage, pages, pageProblems, sleep, SET } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const repo = path.join(process.env.E2E_PROFILE, 'files repo')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'README.md'), '# Hello\n\n- **item** <script>alert(1)</script>\n')
  fs.writeFileSync(path.join(repo, 'application.properties'), '# comment\nserver.port=8080\n')
  fs.writeFileSync(path.join(repo, 'src', 'app.txt'), 'one\n')
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Files Test', '-c', 'user.email=files@example.invalid', ...args], { cwd: repo, stdio: 'pipe', windowsHide: true, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('add', '.')
  git('commit', '-m', 'Create files')
  fs.writeFileSync(path.join(repo, 'src', 'app.txt'), 'one\ntwo\n')
  git('commit', '-am', 'Add a second line', '-m', 'Historical detail [second]')
  const oldCommit = git('rev-parse', 'HEAD').trim()
  // Keep both original commits outside the initial 100 rows, without changing their file tree.
  const timestamp = Math.floor(Date.now() / 1000) + 1
  const history = Array.from({ length: 101 }, (_, index) => {
    const subject = `Recent commit ${index + 1}`
    return ['commit refs/heads/main', `committer Recent Fixture <recent@example.invalid> ${timestamp + index} +0000`,
      `data ${subject.length}`, subject, ...(index === 0 ? [`from ${oldCommit}`] : []), ''].join('\n')
  }).join('\n')
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: `${history}\n`, windowsHide: true })

  const driver = await connect()
  const { js, until } = driver
  const setSearch = (label, query) => js(`(${SET})(document.querySelector('input[aria-label="${label}"]'), ${JSON.stringify(query)})`)
  const clearSearch = () => js(`document.querySelector('.workspace-search button').click()`)
  const fileMenu = `Array.from(document.querySelectorAll('.terminal-menu-item'), item => item.textContent.trim()).join(',')`
  const rightClickFile = async (selector) => {
    await js(`(${selector}).scrollIntoView({ block: 'nearest' })`)
    await driver.click(...await driver.center(selector), 'right')
    return until(`${fileMenu} === '파일 탐색기로 열기,ezShell로 열기'`, 5000)
  }
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
    check('the tree lists the folder and the file at the top', await until(`!!${row('src')} && !!${row('README.md')}`, 15000))
    await js(`${row('src')}.click()`)
    check('a folder expands in place', await until(`!!${row('app.txt')} && ${row('src')}.getAttribute('aria-expanded') === 'true'`, 8000))
    check('a file in the tree offers the explorer and ezShell actions', await rightClickFile(row('app.txt')))
    await driver.click(...await driver.center(row('src')))
    await until(`!document.querySelector('.terminal-menu')`)
    await setSearch('파일·폴더 검색', 'SRC\\APP.TXT')
    const fileMatch = `document.querySelector('.workspace-tree-results button[title="src/app.txt"]')`
    check('file search finds a file in a collapsed folder by its case-insensitive path', await until(`
      ${fileMatch}?.querySelector('.workspace-tree-result-path')?.textContent === 'src'
    `))

    await setSearch('파일·폴더 검색', 'fresh-search.txt')
    await until(`document.querySelector('.workspace-note')?.textContent.includes('일치하는 파일·폴더가 없습니다.')`)
    const freshFile = path.join(repo, 'src', 'fresh-search.txt')
    fs.writeFileSync(freshFile, 'new')
    await js(`document.querySelector('.workspace-browser-header [aria-label="새로 고침"]').click()`)
    check('refresh indexes newly created files for the current search', await until(`
      !!document.querySelector('.workspace-tree-results button[title="src/fresh-search.txt"]')
    `))
    fs.unlinkSync(freshFile)
    await setSearch('파일·폴더 검색', 'SRC\\APP.TXT')
    await until(`!!${fileMatch}`)

    // ---- The file window: edit and save ----
    check('a file search result offers the same actions', await rightClickFile(fileMatch))
    await driver.pick('ezShell로 열기')
    await clearSearch()
    check('clearing file search returns to the same tree', await until(`!${fileMatch} && ${row('src')}?.getAttribute('aria-expanded') === 'false'`))
    await js(`${row('src')}.click()`)
    const target = await findPage(t => t.url.includes('remoteFileMode'), 15000)
    check('a file search result opens in the file window', !!target)
    if (target) {
      const page = await connect(t => t.id === target.id)
      check('the editor shows the file', await page.until(`(document.querySelector('.cm-content')?.textContent || '').includes('two')`, 15000))
      await page.send('Page.bringToFront')
      await page.js(`document.querySelector('.cm-content').focus()`)
      await page.type('EDITED ')
      await page.js(`[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').startsWith('저장'))?.click()`)
      const review = `document.querySelector('.remote-file-save-dialog')`
      const confirm = `document.querySelector('.remote-file-save-dialog .btn-primary')`
      const appFile = path.join(repo, 'src', 'app.txt')
      check('the save review describes a local write', await page.until(`
        ${review}?.querySelector('.modal-title').textContent.trim() === '로컬 파일에 저장' &&
        ${review}.querySelector('.remote-file-dialog-text').textContent.includes('로컬 파일에 저장합니다.') &&
        ${confirm}.textContent.trim() === '저장'`, 8000))

      fs.appendFileSync(appFile, 'changed outside the editor\n')
      await page.js(`${confirm}.click()`)
      const conflict = `document.querySelector('.remote-file-dialog:has(.remote-file-dialog-actions)')`
      check('the save conflict describes the local file on disk', await page.until(`
        ${conflict}?.querySelector('.modal-title').textContent.trim() === '로컬 파일이 바뀌었습니다' &&
        ${conflict}.querySelector('.remote-file-dialog-text').textContent.includes('디스크의 최신 내용')`, 8000))
      await page.js(`${conflict}.querySelector('.btn-primary').click()`)
      await page.until(`!!${confirm} && !${confirm}.disabled`, 8000)
      await page.js(`${confirm}.click()`)
      const saved = await (async () => { for (let i = 0; i < 40; i++) { if (fs.readFileSync(appFile, 'utf8').includes('EDITED')) return true; await sleep(200) } return false })()
      check('saving writes the file on disk', saved, fs.readFileSync(appFile, 'utf8'))
      await page.js(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Git 이력 비교')?.click()`)
      check('the comparison list offers the file at Git HEAD', await page.until(`[...document.querySelectorAll('.remote-backup-item')].some(i => i.classList.contains('is-server') && !!i.querySelector('.is-git'))`, 8000))

      const selected = `document.querySelector('.remote-file-tab-select[aria-selected="true"] .remote-file-tab-name')?.textContent`
      const visibleEditor = `document.querySelector('.remote-file-pane:not([hidden]) .cm-content')`
      const cursorLabel = `[...document.querySelectorAll('.remote-file-pane:not([hidden]) .remote-file-status span')].find(span => span.textContent.startsWith('줄 '))?.textContent`
      const tab = name => `[...document.querySelectorAll('.remote-file-tab-select')].find(t => t.querySelector('.remote-file-tab-name').textContent === ${JSON.stringify(name)})`
      await js(`${row('application.properties')}.click()`)
      check('opening a second file adds a tab to the same window', await page.until(`${selected} === 'application.properties' && !!${tab('app.txt')}`) &&
        (await pages()).filter(p => p.url.includes('remoteFileMode')).length === 1)
      await js(`${row('app.txt')}.click()`)
      check('reopening a file selects its existing tab', await page.until(`${selected} === 'app.txt' && document.querySelectorAll('.remote-file-tab-select').length === 2`))

      await page.send('Page.bringToFront')
      await page.js(`${visibleEditor}.focus()`)
      await page.send('Input.insertText', { text: 'UNSAVED ' })
      check('the edited tab shows an unsaved marker', await page.until(`!!${tab('app.txt')}.querySelector('.remote-file-tab-dirty')`))
      const cursorBeforeDetach = await page.js(cursorLabel)

      const dragTab = async (down) => {
        const [x, y] = await page.center(tab('app.txt'))
        const endX = down ? x : x + 22
        const endY = down ? y + 85 : y
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endX, y: endY, buttons: 1 })
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left', clickCount: 1 })
      }
      await dragTab(false)
      check('dragging within the bar keeps the file in its tab', await page.js(`!!${tab('app.txt')}`) &&
        (await pages()).filter(p => p.url.includes('remoteFileMode')).length === 1)
      await dragTab(true)
      const detached = await findPage(p => p.url.includes('remoteFileMode') && p.id !== target.id, 8000)
      check('dropping a tab away from the bar opens a new window', !!detached && await page.until(`!${tab('app.txt')} && ${selected} === 'application.properties'`))
      if (detached) {
        const detachedPage = await connect(p => p.id === detached.id)
        check('the detached editor preserves the unsaved text', await detachedPage.until(`(${visibleEditor}?.textContent ?? '').includes('UNSAVED')`) &&
          !fs.readFileSync(path.join(repo, 'src', 'app.txt'), 'utf8').includes('UNSAVED'))
        check('the caret stays at the same place', Boolean(cursorBeforeDetach) && await detachedPage.js(`${cursorLabel} === ${JSON.stringify(cursorBeforeDetach)}`))
        await detachedPage.send('Page.bringToFront')
        await detachedPage.js(`${visibleEditor}.focus()`)
        const undo = { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: process.platform === 'darwin' ? 4 : 2 }
        await detachedPage.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...undo })
        await detachedPage.send('Input.dispatchKeyEvent', { type: 'keyUp', ...undo })
        check('undo still works on the transferred edit', await detachedPage.until(`(${visibleEditor}?.textContent ?? '').includes('EDITED') && !${visibleEditor}.textContent.includes('UNSAVED')`))
        detachedPage.close()
        try { await fetch(`${process.env.E2E_CDP}/json/close/${detached.id}`) } catch { /* gone */ }
      }
      const problems = await pageProblems(page)
      check('the file window has no console errors or CSP refusals', problems.length === 0, problems.join(' || '))
      page.close()
      try { await fetch(`${process.env.E2E_CDP}/json/close/${target.id}`) } catch { /* gone */ }
    }

    // ---- Markdown: the plain editor or the document ----
    const openFile = async (name) => {
      const before = new Set((await (await fetch(`${process.env.E2E_CDP}/json`)).json()).map(t => t.id))
      await js(`${row(name)}.click()`)
      const found = await findPage(t => t.url.includes('remoteFileMode') && !before.has(t.id), 15000)
      return found ? { target: found, page: await connect(t => t.id === found.id) } : null
    }
    const closeFile = async (opened) => {
      opened.page.close()
      try { await fetch(`${process.env.E2E_CDP}/json/close/${opened.target.id}`) } catch { /* gone */ }
    }
    const readme = await openFile('README.md')
    check('a Markdown file opens with the plain/Markdown switch', !!readme && await readme.page.until(`!!document.querySelector('.remote-view-switch') && (document.querySelector('.cm-content')?.textContent || '').includes('# Hello')`, 15000))
    if (readme) {
      await readme.page.js(`[...document.querySelectorAll('.remote-view-option')].find(b => b.textContent.includes('마크다운')).click()`)
      check('the Markdown view shows the document, raw HTML as text', await readme.page.until(`document.querySelector('.markdown-body h1')?.textContent === 'Hello' && !!document.querySelector('.markdown-body strong') && !document.querySelector('.markdown-body script') && document.querySelector('.markdown-body').textContent.includes('<script>')`, 5000))
      // Side by side: both shown, the document follows the typing, the divider sets and keeps the width
      await readme.page.js(`document.querySelector('.remote-view-option[data-mode="split"]').click()`)
      check('side by side shows the editor and the document', await readme.page.until(`!document.querySelector('.remote-edit-pane').hidden && !!document.querySelector('.markdown-preview .markdown-body h1') && !!document.querySelector('.markdown-split-divider')`, 5000))
      await readme.page.send('Page.bringToFront')
      const activeMode = `document.querySelector('.remote-view-option[aria-pressed="true"]')`
      await readme.page.move(...await readme.page.center(activeMode))
      const modeColors = await readme.page.js(`(() => {
        const root = document.documentElement
        const theme = root.getAttribute('data-theme')
        const button = ${activeMode}
        try {
          return ['ayu-mirage', 'minimal-dark'].map(id => {
            root.setAttribute('data-theme', id)
            return [getComputedStyle(button).color, getComputedStyle(button.querySelector('svg')).color]
          })
        } finally {
          if (theme === null) root.removeAttribute('data-theme')
          else root.setAttribute('data-theme', theme)
        }
      })()`)
      check('the selected Markdown label and icon use the theme foreground, including on hover',
        modeColors[0].every(color => color === 'rgb(22, 24, 28)') && modeColors[1].every(color => color === 'rgb(255, 255, 255)'), JSON.stringify(modeColors))
      await readme.page.js(`(() => { const view = document.querySelector('.cm-content'); view.focus(); const s = getSelection(); s.selectAllChildren(view); s.collapseToEnd() })()`)
      await readme.page.enter()
      await readme.page.type('## Typed')
      check('side by side, the document follows the typing', await readme.page.until(`[...document.querySelectorAll('.markdown-body h2')].some(h => h.textContent === 'Typed')`, 5000))
      const before = await readme.page.js(`document.querySelector('.remote-edit-pane').getBoundingClientRect().width / document.querySelector('.remote-file-body').getBoundingClientRect().width`)
      const at = await readme.page.js(`(() => { const d = document.querySelector('.markdown-split-divider').getBoundingClientRect(); const b = document.querySelector('.remote-file-body').getBoundingClientRect(); return { x: d.left + d.width / 2, y: d.top + d.height / 2, to: b.left + b.width * 0.3 } })()`)
      await readme.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 })
      for (const step of [0.25, 0.5, 0.75, 1]) await readme.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x + (at.to - at.x) * step, y: at.y, buttons: 1 })
      await readme.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.to, y: at.y, button: 'left', clickCount: 1 })
      const splitRatio = `document.querySelector('.remote-edit-pane').getBoundingClientRect().width / document.querySelector('.remote-file-body').getBoundingClientRect().width`
      await readme.page.until(`Math.abs((${splitRatio}) - 0.3) < 0.05`, 3000)
      const after = await readme.page.js(splitRatio)
      const stored = await readme.page.js(`localStorage.getItem('remoteMarkdownSplit')`)
      check('dragging the divider narrows the editor and is remembered', Math.abs(before - 0.5) < 0.05 && Math.abs(after - 0.3) < 0.05 && Math.abs(Number(stored) - 0.3) < 0.05, JSON.stringify({ before, after, stored }))

      await readme.page.js(`[...document.querySelectorAll('.remote-view-option')].find(b => b.textContent.includes('일반')).click()`)
      check('back to the plain view shows the editor', await readme.page.until(`!document.querySelector('.markdown-preview') && !document.querySelector('.remote-edit-pane').hidden`, 5000))
      const problems = await pageProblems(readme.page)
      check('the Markdown view has no console errors or CSP refusals', problems.length === 0, problems.join(' || '))
      await closeFile(readme)
    }

    // ---- A .properties file: comment, key and value in different colours ----
    const props = await openFile('application.properties')
    if (props) {
      await props.page.until(`(document.querySelector('.cm-content')?.textContent || '').includes('server.port')`, 15000)
      const colours = await props.page.js(`(() => {
        const colour = text => { const span = [...document.querySelectorAll('.cm-content span')].find(s => s.textContent.trim() === text); return span ? getComputedStyle(span).color : null }
        return [colour('# comment'), colour('server.port'), colour('8080')]
      })()`)
      check('a .properties file colours its comment, key and value differently', colours.every(Boolean) && new Set(colours).size === 3, JSON.stringify(colours))
      await closeFile(props)
    } else {
      check('a .properties file opens', false)
    }

    // ---- Git: the uncommitted change and a commit's files ----
    await js(`document.querySelector('#workspace-tab-git').click()`)
    const gitFile = `[...document.querySelectorAll('.workspace-uncommitted .workspace-git-file-toggle')].find(b => b.textContent.includes('app.txt'))`
    check('the uncommitted changes list the edited file', await until(`!!${gitFile} && !!document.querySelector('.workspace-uncommitted .workspace-git-file[data-path="src/app.txt"] .workspace-git-mark[data-kind="modified"]')`, 15000))
    check('as a folder tree with line counts', await until(`(() => {
      const folder = document.querySelector('.workspace-uncommitted .workspace-git-folder[data-path="src"]')
      const lines = document.querySelector('.workspace-uncommitted .workspace-git-file[data-path="src/app.txt"] .workspace-git-lines')
      return !!folder && folder.querySelector('.workspace-git-folder-count')?.textContent === '1' && /^\\+\\d/.test(lines?.textContent || '')
    })()`, 8000), await js(`document.querySelector('.workspace-uncommitted')?.textContent ?? null`))
    await driver.shot('local-workspace-files-uncommitted')
    await js(`${gitFile}.click()`)
    check('its diff against HEAD shows the added text', await until(`[...document.querySelectorAll('.workspace-uncommitted .workspace-diff-line.is-add')].some(l => l.textContent.includes('EDITED'))`, 8000))

    // Opening a changed file from the list starts the comparison with the last commit at once
    const idsBefore = new Set((await (await fetch(`${process.env.E2E_CDP}/json`)).json()).map(t => t.id))
    check('an uncommitted file offers the same actions', await rightClickFile(gitFile))
    await driver.pick('ezShell로 열기')
    const compareTarget = await findPage(t => t.url.includes('remoteFileMode') && !idsBefore.has(t.id), 15000)
    check('ezShell opens a changed file from its menu', !!compareTarget)
    if (compareTarget) {
      const comparePage = await connect(t => t.id === compareTarget.id)
      check('which starts out comparing with the last commit', await comparePage.until(`!!document.querySelector('.remote-compare') &&
        document.querySelector('.remote-compare-pick select')?.value === 'server:HEAD' &&
        (document.querySelector('.remote-compare')?.textContent || '').includes('EDITED')`, 15000))
      comparePage.close()
      try { await fetch(`${process.env.E2E_CDP}/json/close/${compareTarget.id}`) } catch { /* gone */ }
    }

    const commit = `[...document.querySelectorAll('.workspace-git-detail')].find(b => b.textContent.includes('Add a second line'))`
    check('an older commit is outside the initial log', await until(`document.querySelectorAll('.workspace-git-list .workspace-git-detail').length === 100 && !${commit}`))
    await setSearch('Git 이력 검색', '[second]')
    check('Git search finds older commits by literal text in the message body', await until(`!!${commit} && document.querySelectorAll('.workspace-git-list .workspace-git-detail').length === 1`))
    await setSearch('Git 이력 검색', 'FILES TEST')
    check('Git search finds commits by author', await until(`!!${commit} && document.querySelectorAll('.workspace-git-list .workspace-git-detail').length === 2`))
    await setSearch('Git 이력 검색', oldCommit.slice(0, 9).toUpperCase())
    check('Git search finds a commit by abbreviated hash', await until(`!!${commit} && document.querySelectorAll('.workspace-git-list .workspace-git-detail').length === 1`))
    await js(`${commit}.click()`)
    const commitFile = `[...document.querySelectorAll('.workspace-git-files.is-commit .workspace-git-file-toggle')].find(b => b.textContent.includes('app.txt'))`
    check('opening a commit lists the files it changed', await until(`!!${commitFile}`, 8000))
    await js(`${commitFile}.click()`)
    check('a commit file shows its diff', await until(`[...document.querySelectorAll('.workspace-git-files.is-commit .workspace-diff-line.is-add')].some(l => l.textContent.trim() === '+two')`, 8000))
    await clearSearch()
    check('clearing Git search restores the commit graph', await until(`!!document.querySelector('.workspace-git-graph') && !${commit}`))

    // ---- Folders main does not know are refused ----
    const outside = JSON.stringify(os.tmpdir())
    const refused = await js(`Promise.all([
      window.electronAPI.workspaceDirectoryList(${outside}),
      window.electronAPI.workspaceDirectorySearch(${outside}, 'app'),
      window.electronAPI.workspaceGitSearch(${outside}, 'app'),
      window.electronAPI.localFileOpen(${JSON.stringify(repo)}, '../outside.txt', 'edit'),
      window.electronAPI.workspaceGitDiff(${JSON.stringify(repo)}, 'src/app.txt', 'HEAD; whoami')
    ]).then(results => results.map(r => r.success))`)
    check('a folder outside the shell\'s, a climbing path and a bad commit are refused', JSON.stringify(refused) === '[false,false,false,false,false]', JSON.stringify(refused))
    await driver.shot('local-workspace-files')
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
