// The sidebar's local work tree: registered work folders → their Git worktrees → the local terminals
// open in each, then the other local terminals. Folding is remembered. Past agent sessions are not
// listed in the tree (the agent history panel shows them). Run by e2e/run.js (fresh profile, no
// server needed). Makes a small Git repository with one extra worktree in the profile.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { sleep, createChecks, connect, unlock } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { send, js, until, shot } = driver
  const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`
  const profile = process.env.E2E_PROFILE
  const registerProjects = (...folders) => js(`
    localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify(folders))})
    window.dispatchEvent(new Event('ezshell:local-projects-changed'))
  `)

  // A repository with a commit and a second worktree on branch "feature"
  const repo = path.join(profile, 'work app')
  const feature = path.join(profile, 'work app-feature')
  fs.mkdirSync(repo, { recursive: true })
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true })
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), 'demo\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-m', 'init')
  git(repo, 'worktree', 'add', '-b', 'feature', feature)

  await unlock(driver)
  check('without folders or local terminals only the local work actions are shown', await js(`
    !!${q('.local-terms-btn[aria-label="새 로컬 터미널"]')} &&
    !!${q('.local-terms-btn[aria-label="작업 폴더 추가"]')} &&
    !${q('.local-terms-scroll')} && !${q('.local-terms-divider')}
  `))

  // Registered the way the 로컬 작업 dialog does it
  await registerProjects(repo)
  const worktreeRow = (dir) => `[...document.querySelectorAll('.local-worktree')].find(el => el.dataset.worktreePath.toLowerCase() === ${JSON.stringify(dir.toLowerCase())})`
  check('the registered folder shows up with its two worktrees', await until(`${q('.local-project-name')}?.textContent === 'work app' && document.querySelectorAll('.local-worktree').length === 2`, 15000),
    await js(`${q('.local-terms')}?.textContent`))
  check('the main checkout is tagged and each shows its branch', await js(`${worktreeRow(repo)}.textContent.includes('기본') && ${worktreeRow(repo)}.textContent.includes('main') && ${worktreeRow(feature)}.textContent.includes('feature') && !${worktreeRow(feature)}.textContent.includes('기본')`))
  check('no worktree has an open terminal yet', await js(`!document.querySelector('.local-worktree-dot.is-on')`))

  check('no past agent sessions are listed in the tree', await js(`!document.querySelector('.local-history, .local-history-row')`))

  // A single tab shares the worktree's own row.
  await js(`${worktreeRow(feature)}.querySelector('.local-worktree-open').click()`)
  check('clicking a worktree opens a local terminal tab', await until(`document.querySelectorAll('.terminal-tab').length === 1`, 20000))
  check('the worktree row shows the tab status and close button without a repeated row', await until(`
    ${worktreeRow(feature)}.dataset.localSessionId === document.querySelector('.terminal-tab.active')?.dataset.tabId &&
    ${worktreeRow(feature)}.classList.contains('is-current') &&
    !!${worktreeRow(feature)}.querySelector('.local-worktree-dot.is-on') &&
    !!${worktreeRow(feature)}.querySelector('.local-worktree-row > .local-terms-close') &&
    !${worktreeRow(feature)}.querySelector('.local-terms-item, .local-worktree-fold')
  `, 10000))
  check('the tab is named after the project and branch', await js(`document.querySelector('.terminal-tab.active')?.textContent.includes('work app · feature')`), await js(`document.querySelector('.terminal-tab.active')?.textContent`))
  await js(`${worktreeRow(feature)}.querySelector('.local-worktree-open').click()`)
  await sleep(800)
  check('clicking it again goes to that tab instead of opening another', (await js(`document.querySelectorAll('.terminal-tab').length`)) === 1)

  // A plain local terminal (home folder) is listed apart
  await js(`${q('.local-terms-btn[aria-label="새 로컬 터미널"]')}.click()`)
  check('a terminal outside the worktrees goes under "다른 로컬 터미널"', await until(`document.querySelectorAll('.terminal-tab').length === 2 && ${q('.local-terms-group')}?.textContent === '다른 로컬 터미널' && document.querySelectorAll('.local-terms-scroll > .local-terms-list > .local-terms-item').length === 1`, 20000))
  await shot('local-workspace-1')

  const featureSession = `${worktreeRow(feature)}?.dataset.localSessionId`
  const featureId = JSON.stringify(await js(featureSession))
  const otherSession = `${q('.local-terms-scroll > .local-terms-list > .local-terms-item')}?.dataset.localSessionId`
  const otherId = JSON.stringify(await js(otherSession))
  const closeFeature = `${worktreeRow(feature)}.querySelector('.local-worktree-row > .local-terms-close')`
  const question = q('.confirm-dialog')
  const cancel = q('.confirm-dialog .btn-secondary')
  const confirm = q('.confirm-dialog .btn-danger')
  await js(`${closeFeature}.click()`)
  check('the worktree tab close warns that every session in the tab will end', await until(`
    ${q('.confirm-dialog-message')}?.textContent.includes('이 탭에 열려 있는 세션이 모두 종료됩니다.') &&
    ${confirm}?.textContent === '모두 종료' && document.activeElement === ${cancel} && ${featureSession} === ${featureId}
  `))
  await driver.enter()
  check('cancel keeps the worktree tab open', await until(`!${question} && ${featureSession} === ${featureId}`))
  await js(`${closeFeature}.click()`)
  await until(`!!${confirm}`)
  await js(`${confirm}.click()`)
  check('confirm closes the worktree tab and leaves the other tab open', await until(`
    !${featureSession} && !${closeFeature} && ${otherSession} === ${otherId}
  `))
  await js(`${worktreeRow(feature)}.querySelector('.local-worktree-open').click()`)
  check('the worktree can be opened again', await until(`${featureSession} && ${featureSession} !== ${featureId}`))

  // No half-height cap: the pane may grow until the session list keeps about three rows
  check('the pane is not capped at half of the list area', await js(`getComputedStyle(${q('.local-terms')}).maxHeight !== '50%'`), await js(`getComputedStyle(${q('.local-terms')}).maxHeight`))

  const toggleSidebar = () => js(`${q('.sidebar-toggle')}.click()`)
  const sessionTarget = q('[data-peek-target="sessions"]')
  const localTarget = q('[data-peek-target="local"]')
  const foldedSidebar = q('.sidebar.rail:not(.peek-open)')
  const mainLeft = `${q('#main-content')}.getBoundingClientRect().left`
  await driver.move(430, 235)
  await js(`${q('.local-terms-toggle')}.click()`)
  const storedPane = await js(`localStorage.getItem('sidebarLocalPane')`)
  await toggleSidebar()
  check('the folded rail gives sessions and local work equal halves', await until(`(() => {
    const sessions = ${sessionTarget}.getBoundingClientRect()
    const local = ${localTarget}.getBoundingClientRect()
    return Boolean(${foldedSidebar}) && sessions.top < local.top &&
      Math.abs(sessions.height - local.height) < 1 && Math.abs(sessions.bottom - local.top) < 1
  })()`))
  const foldedLeft = await js(mainLeft)
  await driver.move(...await driver.center(localTarget))
  check('the lower half previews the full local tree even if the docked tree was collapsed', await until(`
    ${q('.sidebar.peek-open[data-peek-section="local"]')} && ${q('.local-terms.is-full .local-worktree')} &&
    ${q('.local-terms')}.offsetHeight === ${q('.sidebar-lists')}.offsetHeight &&
    getComputedStyle(${q('.sidebar-lists > .session-list-empty')}).display === 'none' &&
    ${mainLeft} === ${foldedLeft}
  `))
  await until(`${q('.sidebar-panel')}.offsetWidth >= 270`)
  await driver.move(170, 245)
  await sleep(380)
  check('the local preview stays open when the pointer enters its panel', await js(`Boolean(${q('.sidebar.peek-open[data-peek-section="local"]')})`))
  await driver.move(430, 235)
  check('leaving the local preview folds it', await until(`Boolean(${foldedSidebar})`))

  await driver.move(...await driver.center(sessionTarget))
  check('the upper half gives the session list the list area', await until(`
    ${q('.sidebar.peek-open[data-peek-section="sessions"]')} &&
    ${q('.sidebar-lists > .session-list-empty')}.offsetHeight === ${q('.sidebar-lists')}.offsetHeight &&
    getComputedStyle(${q('.local-terms')}).display === 'none' && ${mainLeft} === ${foldedLeft}
  `))
  const switchButton = q('.sidebar-peek-switch')
  await until(`${q('.sidebar-panel')}.offsetWidth >= 270`)
  await driver.click(...await driver.center(switchButton))
  check('the bottom switch opens local work directly from the session preview', await until(`
    ${q('.sidebar.rail.peek-open[data-peek-section="local"]')} && ${q('.local-terms.is-full .local-worktree')} &&
    ${switchButton}.textContent.trim() === '세션 목록으로 전환' && ${mainLeft} === ${foldedLeft}
  `))
  await driver.enter()
  check('the same switch returns to sessions and retains keyboard focus', await until(`
    ${q('.sidebar.rail.peek-open[data-peek-section="sessions"]')} &&
    ${switchButton}.textContent.trim() === '로컬 작업으로 전환' && document.activeElement === ${switchButton}
  `))
  await driver.move(430, 235)
  await until(`Boolean(${foldedSidebar})`)
  await js(`${localTarget}.focus()`)
  await driver.enter()
  check('activating the rail from the keyboard focuses the preview', await until(`
    ${q('.sidebar.peek-open[data-peek-section="local"]')} && document.activeElement === ${q('.sidebar-toggle')}
  `))
  await toggleSidebar()
  check('pinning restores both lists and the saved local collapse preference', await until(`
    !${q('.sidebar.rail')} && !${switchButton} && ${q('.local-terms.is-collapsed')} && !${q('.local-terms.is-full')} &&
    ${q('.sidebar-lists > .session-list-empty')}.offsetHeight > 0 &&
    localStorage.getItem('sidebarLocalPane') === ${JSON.stringify(storedPane)}
  `))
  await js(`${q('.local-terms-toggle')}.click()`)

  // Folding a project is remembered across a reload
  await js(`${q('.local-project-row')}.click()`)
  check('folding the project hides its worktrees', await until(`${q('.local-project-row')}.getAttribute('aria-expanded') === 'false' && !document.querySelector('.local-worktree')`))
  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('the folded project stays folded after a reload', await until(`${q('.local-project-row')}?.getAttribute('aria-expanded') === 'false'`, 15000))
  await js(`${q('.local-project-row')}.click()`)
  check('and opens again', await until(`document.querySelectorAll('.local-worktree').length === 2`))

  const otherProject = path.join(profile, 'work api')
  fs.mkdirSync(otherProject)
  const projectCard = folder => `[...document.querySelectorAll('.local-project')].find(card => card.dataset.projectFolder === ${JSON.stringify(folder)})`
  const mainCard = projectCard(repo)
  const secondCard = projectCard(otherProject)
  await registerProjects(repo, otherProject)
  if (!await until(`!!${secondCard}?.querySelector('.local-worktree-open')`, 15000)) throw new Error('Second project did not load')
  const boundaries = await js(`(() => {
    const cards = [${mainCard}, ${secondCard}]
    const borders = cards.map(card => getComputedStyle(card))
    const heads = cards.map(card => getComputedStyle(card.querySelector('.local-project-head')).backgroundColor)
    return { colors: borders.map(style => style.borderInlineStartColor), widths: borders.map(style => style.borderInlineStartWidth), heads,
      gap: cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().bottom }
  })()`)
  check('adjacent projects have separated frames and their own header tint', boundaries.gap >= 8 &&
    boundaries.widths.every(width => width === '3px') && boundaries.colors[0] !== boundaries.colors[1] &&
    boundaries.heads[0] !== boundaries.heads[1], JSON.stringify(boundaries))
  await shot('local-workspace-projects')
  await js(`${secondCard}.querySelector('.local-project-row').click()`)
  check('folding one project keeps its header and leaves the neighbor open', await until(`
    ${secondCard}.querySelector('.local-project-row').getAttribute('aria-expanded') === 'false' &&
    !${secondCard}.querySelector('.local-worktrees') && ${mainCard}.querySelectorAll('.local-worktree').length === 2
  `))
  await registerProjects(otherProject, repo)
  check('project colors stay with their folders after reordering', await until(`
    ${q('.local-project')} === ${secondCard} &&
    getComputedStyle(${mainCard}).borderInlineStartColor === ${JSON.stringify(boundaries.colors[0])} &&
    getComputedStyle(${secondCard}).borderInlineStartColor === ${JSON.stringify(boundaries.colors[1])}
  `))

  // Taking the project off the list: a second registered folder of the same repository goes with it
  await registerProjects(repo, feature)
  await sleep(1500)
  check('a worktree registered as well adds no second project', await js(`document.querySelectorAll('.local-project').length === 1`))
  const tabsBefore = await js(`document.querySelectorAll('.terminal-tab').length`)
  const registrationBefore = await js(`localStorage.getItem('ezshell.localProjects')`)
  await js(`${q('.local-project-remove')}.click()`)
  check('removing a local work asks first and names the project', await until(`
    ${question}?.textContent.includes('로컬 작업 목록에서 빼기') &&
    ${q('.confirm-dialog-message')}?.textContent.includes('work app') &&
    document.activeElement === ${cancel} &&
    localStorage.getItem('ezshell.localProjects') === ${JSON.stringify(registrationBefore)}
  `))
  await js(`${cancel}.click()`)
  check('cancel leaves the registration and both worktrees in place', await until(`
    !${question} && document.querySelectorAll('.local-worktree').length === 2 &&
    localStorage.getItem('ezshell.localProjects') === ${JSON.stringify(registrationBefore)}
  `))
  await js(`${q('.local-project-remove')}.click()`)
  await until(`!!${confirm}`)
  await js(`${confirm}.click()`)
  check('confirming takes the project and its worktrees off the tree', await until(`!document.querySelector('.local-project') && !document.querySelector('.local-worktree')`))
  check('both registered folders are gone from the list', await js(`localStorage.getItem('ezshell.localProjects') === '[]'`), await js(`localStorage.getItem('ezshell.localProjects')`))
  check('the project files are still on disk', fs.existsSync(path.join(repo, 'README.md')) && fs.existsSync(path.join(feature, 'README.md')))
  check('the open local terminals stay', await js(`document.querySelectorAll('.terminal-tab').length === ${tabsBefore}`), `${tabsBefore} → ${await js(`document.querySelectorAll('.terminal-tab').length`)}`)

  finish()
})().catch((error) => { console.error(error); process.exit(1) })
