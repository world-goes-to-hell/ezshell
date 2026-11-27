const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE
const project = path.join(profile, 'shop-msa')
const catalog = path.join(project, 'services', 'catalog')
const parent = path.join(profile, 'git-parent')
const source = path.join(profile, 'source')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe', encoding: 'utf8' }).trim()

function commit(cwd, filename) {
  fs.writeFileSync(path.join(cwd, filename), filename)
  git(cwd, 'add', '--', filename)
  git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', filename)
}

function fixture() {
  fs.mkdirSync(path.dirname(catalog), { recursive: true })
  const remote = path.join(profile, 'remote.git')
  git(profile, 'init', '--bare', '-b', 'main', remote)
  git(profile, 'clone', remote, source)
  commit(source, 'initial')
  git(source, 'switch', '-c', 'feature/catalog')
  git(source, 'push', '-u', 'origin', 'feature/catalog')
  git(source, 'push', 'origin', 'main')
  git(source, 'push', 'origin', 'main:refs/heads/topic/next')
  git(path.dirname(catalog), 'clone', '-b', 'feature/catalog', remote, catalog)
  git(catalog, 'branch', 'main')
  git(project, 'clone', remote, 'orders')
  git(project, 'clone', remote, 'payments')
  fs.writeFileSync(path.join(project, 'orders', 'draft'), 'local only')
  commit(source, 'incoming')
  git(source, 'push')
  git(catalog, 'fetch')
  fs.mkdirSync(parent)
  git(parent, 'init', '-b', 'main')
  commit(parent, 'parent-readme')
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', remote, 'child')
  return git(source, 'rev-parse', 'HEAD')
}

;(async () => {
  const updated = fixture()
  const driver = await connect()
  const { js, until, shot, type, enter } = driver
  const card = `document.querySelector('.local-project[data-project-folder=' + CSS.escape(${JSON.stringify(project)}) + ']')`
  const section = `${card}?.querySelector('.nested-repositories')`
  const row = name => `${section}?.querySelector('[data-nested-repo="${name}"]')`
  const menuItem = label => `[...document.querySelectorAll('.terminal-menu [role="menuitem"]')].find(item => item.textContent.trim() === ${JSON.stringify(label)})`
  try {
    await unlock(driver)
    const saved = await js(`window.electronAPI.runPresetsSave(${JSON.stringify(project)}, ${JSON.stringify({
      kind: 'custom', name: '카탈로그 실행', relative: 'services/catalog', command: 'node --version'
    })})`)
    if (!saved?.preset) throw new Error(`Could not create the preset: ${JSON.stringify(saved)}`)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([project, parent]))})
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    const preset = `${card}?.querySelector('[data-run-preset="${saved.preset.id}"]')`
    const chip = kind => `${preset}?.querySelector('[data-kind="${kind}"]')`
    check('plain parent shows common branch and count without a worktree header', await until(
      `${card}?.querySelector('.nested-repository-summary')?.textContent === 'main3개↓1개'
        && ${card}?.querySelector('.nested-repository-summary .nested-repository-behind')?.title === '받을 커밋이 있는 저장소 1개'
        && !${card}?.querySelector('.local-worktree-row')`))
    check('Git parent keeps its worktree and recognizes its submodule', await until(
      `[...document.querySelectorAll('.local-project')].some(card => card.dataset.projectFolder === ${JSON.stringify(parent)}
        && card.querySelector('.local-worktree-row') && card.querySelector('.nested-repositories-toggle')?.textContent.includes('1개'))`))
    check('the preset name and actions have their own line above the folder and Git details', await until(
      `(() => {
        const line = ${preset}?.querySelector('.run-preset-main')
        const name = line?.querySelector('.run-preset-name')
        const details = ${preset}?.querySelector('.run-preset-details')
        const folder = details?.querySelector('.run-preset-folder')
        const branch = ${chip('branch')}
        const incoming = ${chip('behind')}
        return name?.textContent === '카탈로그 실행' && name.scrollWidth === name.clientWidth
          && !!line.querySelector('[data-action="start"]') && !!line.querySelector('[aria-label="카탈로그 실행 더 보기"]')
          && details?.contains(branch) && details.contains(incoming) && folder?.textContent === 'services/catalog/'
          && details.getBoundingClientRect().top >= line.getBoundingClientRect().bottom
          && branch.title === 'feature/catalog' && incoming.textContent === '↓1'
          && incoming.getBoundingClientRect().right <= ${preset}.getBoundingClientRect().right
      })()`))
    await js(`${section}.querySelector('.nested-repositories-toggle').click()`)
    const trustSwitch = `${section}?.querySelector('[role="switch"]')`
    const remoteCheck = `[...${section}.querySelectorAll('button')].find(button => button.textContent.trim() === '원격 확인')`
    check('new projects start with automatic remote checks off', await until(`${trustSwitch}?.checked === false && !!${remoteCheck}`))
    check('different filter hides clean matching repositories and includes dirty ones', await until(
      `!!${row('services/catalog')} && ${row('orders')}?.textContent.includes('수정 1') && !${row('payments')}`))
    await shot('local-nested-repos-before')
    await js(`${row('services/catalog')}.querySelector('.nested-repository-more').click()`)
    if (!await until(`!!${menuItem('기동 설정…')}`)) throw new Error('Missing repository context menu')
    await js(`${menuItem('기동 설정…')}.click()`)
    check('configuration dialog opens at the nested repository', await until(
      `[...document.querySelectorAll('.run-preset-dialog input')].some(input => input.value.replace(/\\\\/g, '/') === 'services/catalog')`))
    await js(`[...document.querySelectorAll('.run-preset-dialog button')].find(button => button.textContent === '취소')?.click()`)
    await js(`${chip('behind')}.click()`)
    check('clicking the incoming chip fast-forwards only its repository', await until(
      `${row('services/catalog')}?.querySelector('[data-result="received"]')?.textContent === '받음 1' && !${chip('behind')}`))
    check('pull advanced HEAD to the remote commit and kept other worktrees intact',
      git(catalog, 'rev-parse', 'HEAD') === updated && fs.existsSync(path.join(project, 'orders', 'draft')))
    await shot('local-nested-repos-after')

    commit(source, 'manual-fetch')
    git(source, 'push')
    const manualHead = git(source, 'rev-parse', 'HEAD')
    await js(`${remoteCheck}.click()`)
    check('manual remote check updates an untrusted project without updating HEAD',
      await until(`${chip('behind')}?.textContent === '↓1'`) && git(catalog, 'rev-parse', 'HEAD') === updated)
    commit(source, 'automatic-fetch')
    git(source, 'push')
    const autoHead = git(source, 'rev-parse', 'HEAD')
    const automatic = `window.electronAPI.localNestedRepositoriesStatus(${JSON.stringify({
      project, roots: [project], fetch: true, excluded: [project, parent], trusted: true
    })})`
    const forged = await js(automatic)
    check('a renderer trust claim cannot trigger automatic fetch',
      forged.success && !forged.trusted && git(catalog, 'rev-parse', '@{upstream}') === manualHead)
    await js(`${trustSwitch}.click()`)
    const declined = await until(`${trustSwitch} && !${trustSwitch}.checked && !${trustSwitch}.disabled`)
    check('declining the native trust confirmation leaves automatic checks off',
      declined && fs.existsSync(path.join(profile, 'nested-trust-prompt.txt')))
    fs.writeFileSync(path.join(profile, 'accept-nested-trust'), '')
    await js(`${trustSwitch}.click()`)
    check('accepting the native trust confirmation enables the project switch', await until(`${trustSwitch}?.checked === true`))
    await js(`window.dispatchEvent(new Event('focus'))`)
    check('confirmed project refreshes the current upstream on focus',
      await until(`${chip('behind')}?.textContent === '↓2'`) && git(catalog, 'rev-parse', '@{upstream}') === autoHead)
    check('project badge counts repositories while the nested repository row counts commits', await until(
      `${card}?.querySelector('.nested-repository-summary .nested-repository-behind')?.textContent === '↓1개'
        && ${row('services/catalog')}?.querySelector('.nested-repository-behind')?.textContent === '↓2'`))
    await shot('local-nested-repos-trusted')

    git(path.join(project, 'payments'), 'config', '--local', 'remote.origin.uploadpack', 'git-upload-pack')
    await js(`window.dispatchEvent(new Event('focus'))`)
    check('refresh keeps unsafe settings visible and clears the finished pull status', await until(
      `${row('payments')}?.textContent.includes('저장소 설정 확인 필요')
        && !${row('services/catalog')}?.querySelector('[data-result="received"]')`))

    const branchDialog = 'document.querySelector(".nested-branch-dialog")'
    const branch = name => `${branchDialog}?.querySelector('[data-branch="${name}"]')`
    await js(`[...${section}.querySelectorAll('.nested-repository-filter button')].find(button =>
      button.textContent === '전체').click()`)
    await js(`${row('services/catalog')}.querySelector('.nested-repository-more').click()`)
    if (!await until(`!!${menuItem('브랜치 바꾸기…')}`)) throw new Error('Missing branch switch item')
    await js(`${menuItem('브랜치 바꾸기…')}.click()`)
    check('the branch dialog shows the current branch and a remote-only branch', await until(
      `${branch('feature/catalog')}?.textContent.includes('현재') && ${branch('topic/next')}?.textContent.includes('원격')`))
    await shot('local-nested-repos-branches')
    await js(`${branchDialog}.querySelector('input').focus()`)
    await type('main')
    await enter()
    check('filter and Enter switch branches and refresh the repository and project summary', await until(
      `!${branchDialog} && ${row('services/catalog')}?.querySelector('.nested-repository-ref')?.textContent.trim() === 'main'
        && ${card}?.querySelector('.nested-repository-summary .nested-repository-branch')?.textContent === 'main'`)
      && git(catalog, 'branch', '--show-current') === 'main')

    await js(`${row('services/catalog')}.querySelector('.nested-repository-open').click()`)
    const hasShell = name => `(() => {
      const tab = [...document.querySelectorAll('.terminal-tab[data-tab-id^="local:"]')].find(tab =>
        tab.querySelector('[data-tab-label]')?.textContent === ${JSON.stringify(name)})
      return !!tab && [...${card}.querySelectorAll('.local-terms-item')].some(item =>
        item.dataset.localSessionId === tab.dataset.tabId && item.querySelector('.local-terms-name')?.textContent === ${JSON.stringify(name)})
    })()`
    check('a nested repository row names its terminal for the repository folder in the tab and sidebar', await until(hasShell('catalog · main')))
    await js(`${row('orders')}.querySelector('.nested-repository-more').click()`)
    if (!await until(`!!${menuItem('로컬 터미널 열기')}`)) throw new Error('Missing repository terminal item')
    await js(`${menuItem('로컬 터미널 열기')}.click()`)
    check('another repository on the same branch has its own title when opened via the menu',
      await until(`${hasShell('orders · main')} && ${hasShell('catalog · main')}`))

    fs.appendFileSync(path.join(catalog, 'initial'), '\nlocal change')
    await js(`${row('services/catalog')}.querySelector('.nested-repository-ref').click()`)
    if (!await until(`!!${branch('feature/catalog')}`)) throw new Error('Branch label did not open the branch dialog')
    await js(`${branch('feature/catalog')}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
    check('switching on a dirty worktree is blocked and leaves the current branch intact', await until(
      `${branchDialog}?.querySelector('[role="alert"]')?.textContent.includes('수정하거나 스테이징한 파일')`)
      && git(catalog, 'branch', '--show-current') === 'main')
    await js(`[...${branchDialog}.querySelectorAll('button')].find(button => button.textContent === '취소').click()`)

    // Remote addresses (2026-11-27 user request): a pull refused for an http:// remote is fixed from its row
    const orders = path.join(project, 'orders')
    const remoteRepo = path.join(profile, 'remote.git')
    const httpUrl = 'http://git.example.invalid/team/orders.git'
    fs.rmSync(path.join(orders, 'draft'))
    git(orders, 'remote', 'set-url', 'origin', httpUrl)
    await js(`${row('orders')}.querySelector('.nested-repository-more').click()`)
    if (!await until(`!!${menuItem('최신으로 받기')}`)) throw new Error('Missing repository pull item')
    await js(`${menuItem('최신으로 받기')}.click()`)
    const remoteAction = `${row('orders')}?.querySelector('.nested-repository-result-action')`
    check('a pull refused for an http:// remote offers to change the address', await until(
      `${row('orders')}?.querySelector('[data-result="failed"]')?.textContent.includes('HTTPS, SSH') && !!${remoteAction}`))
    await js(`${remoteAction}.click()`)
    const remoteDialog = 'document.querySelector(".nested-remote-dialog")'
    const origin = `${remoteDialog}?.querySelector('[data-remote="origin"]')`
    const addForm = `${remoteDialog}?.querySelector('.nested-remote-add')`
    const backup = `${remoteDialog}?.querySelector('[data-remote="backup"]')`
    const button = (scope, label) => `[...(${scope}?.querySelectorAll('button') ?? [])].find(button =>
      button.textContent.trim() === ${JSON.stringify(label)})`
    check('the remote dialog shows the address and why fetching refuses it', await until(
      `${origin}?.querySelector('input')?.value === ${JSON.stringify(httpUrl)} && ${origin}.textContent.includes('받을 수 없음')`))
    await shot('local-nested-repos-remotes')
    await js(`${button(origin, 'HTTPS 로 바꾸기')}.click()`)
    const httpsUrl = httpUrl.replace('http://', 'https://')
    check('HTTPS 로 바꾸기 fills in the https address', await until(`${origin}.querySelector('input').value === ${JSON.stringify(httpsUrl)}`))
    await js(`${button(origin, '저장')}.click()`)
    check('saving writes the address and clears the refusal in the dialog and the row', await until(
      `${origin}?.textContent.includes('저장했습니다') && !${origin}.textContent.includes('받을 수 없음')
        && !!${row('orders')} && !${row('orders')}.querySelector('[data-result="failed"]')`)
      && git(orders, 'config', 'remote.origin.url') === httpsUrl)

    const fill = async (label, text) => {
      await js(`(() => { const input = ${addForm}.querySelector('[aria-label="${label}"]'); input.focus(); input.select() })()`)
      await type(text)
    }
    await fill('새 원격 이름', 'secret')
    await fill('새 원격 주소', 'https://user:pw@git.example.invalid/team/orders.git')
    await js(`${button(addForm, '추가')}.click()`)
    check('an address with a password is refused', await until(`${addForm}?.textContent.includes('비밀번호가 든 주소')`)
      && !git(orders, 'remote').split(/\r?\n/).includes('secret'))
    await fill('새 원격 이름', 'backup')
    await fill('새 원격 주소', remoteRepo)
    await js(`${button(addForm, '연결 확인')}.click()`)
    check('the connection check reaches a remote on this PC before adding it', await until(`${addForm}?.textContent.includes('연결됨 · 브랜치')`, 15000))
    await js(`${button(addForm, '추가')}.click()`)
    check('a remote can be added', await until(`!!${backup}`) && git(orders, 'config', 'remote.backup.url') === remoteRepo)
    await js(`${button(backup, '삭제')}.click()`)
    check('removing a remote asks for a second press', await until(`!!${button(backup, '한 번 더 누르면 지웁니다')}`)
      && git(orders, 'remote').split(/\r?\n/).includes('backup'))
    await js(`${button(backup, '한 번 더 누르면 지웁니다')}.click()`)
    check('the second press removes the remote', await until(`!${backup}`) && git(orders, 'remote') === 'origin')
    await js(`${button(remoteDialog, '닫기')}.click()`)
    if (!await until(`!${remoteDialog}`)) throw new Error('The remote dialog did not close')

    await js(`${row('services/catalog')}.querySelector('.nested-repository-more').click()`)
    if (!await until(`!!${menuItem('따로 로컬 작업으로 올리기')}`)) throw new Error('Missing repository promotion')
    await js(`${menuItem('따로 로컬 작업으로 올리기')}.click()`)
    check('explicit registration removes the repository from its parent list', await until(
      `!${row('services/catalog')} && [...document.querySelectorAll('.local-project')].some(card =>
        card.dataset.projectFolder === ${JSON.stringify(catalog)} && card.querySelector('.local-worktree-row'))`))
    // Promotion also refreshes the other registered roots. Wait for their Git reads before the runner
    // force-stops the app, so a Windows Git child cannot hold the app's CDP socket open.
    const refreshed = await js(`Promise.all(${JSON.stringify([catalog, project, parent])}.map(folder =>
      window.electronAPI.localNestedRepositoriesStatus({
        project: folder, roots: [folder], fetch: false, excluded: ${JSON.stringify([catalog, project, parent])}
      })))`)
    check('promoted and parent projects can refresh independently', refreshed.every(result => result.success))
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
