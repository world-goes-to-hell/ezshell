// Saved SSH sessions grouped under a local project in the sidebar's local tree ("서버"), kept across
// a reload (lib/localProjectServers.ts). Run by e2e/run.js, which starts the test SSH server.
const fs = require('fs')
const path = require('path')
const { sleep, createChecks, connect, unlock, connectSsh, pickTabGroup, SET } = require('../support/driver')
const { check, finish } = createChecks()

const SESSION = 'e2e-project-server'

;(async () => {
  const driver = await connect()
  const { js, send, until, shot } = driver
  const port = Number(process.env.E2E_SSH_PORT)
  const folder = path.join(process.env.E2E_PROFILE, 'work app')
  fs.mkdirSync(folder, { recursive: true })
  const project = `document.querySelector('.local-project')`
  const serverRows = `[...document.querySelectorAll('.local-server')]`
  const tabs = `[...document.querySelectorAll('.terminal-tab')]`
  // A drop on the project card, carrying what a session row or a tab carries (text/plain)
  const dropOnProject = text => js(`(() => {
    const target = ${project}
    const data = new DataTransfer()
    data.setData('text/plain', ${JSON.stringify(text)})
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })()`)

  await unlock(driver)
  // The test server's host key is trusted once (this also leaves a quick connect tab open)
  check('a quick connect tab to the test server opens', await connectSsh(driver))
  const saved = await js(`window.electronAPI.saveSessions([{ id: '${SESSION}', name: '프로젝트 서버', host: '127.0.0.1', port: ${port}, username: 'tester', authType: 'password', password: 'x', icon: 'server' }])`)
  check('a saved session is written', saved?.success === true, JSON.stringify(saved))
  await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([folder]))})`)
  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('the work folder is in the local tree', await until(`!!${project}`, 15000))
  // The reload took the first quick connect tab away (SSH tabs are not taken back): one more for the checks below
  check('a quick connect tab opens again', await connectSsh(driver))

  await dropOnProject(`session:${SESSION}`)
  check('a session dropped on the project shows under it as a server', await until(`${serverRows}.length === 1 && ${serverRows}[0].textContent.includes('프로젝트 서버')`, 5000))
  check('with no tab open it is grey', await js(`!${serverRows}[0].querySelector('.local-server-dot').matches('.is-on, .is-off')`))

  await js(`${serverRows}[0].querySelector('.local-server-open').click()`)
  check('pressing the server connects it in a tab', await until(`${tabs}.some(t => t.textContent.includes('프로젝트 서버'))`, 20000))
  // 2026-11-20 user requests: the work's open SSH tab is listed in its worktree, and only there
  const workTabRow = name => `[...document.querySelectorAll('.local-worktree [data-work-tab-id]')].find(row => row.textContent.includes(${JSON.stringify(name)}))`
  check('the server tab is listed under the worktree in the sidebar, with a green dot', await until(`!!${workTabRow('프로젝트 서버')}?.querySelector('.local-terms-dot.is-on')`, 10000))
  check('and the server is no longer listed twice (the 서버 list keeps the ones to connect)', await until(`${serverRows}.length === 0`, 3000))
  await shot('ssh-project-servers-1-linked')
  // The folded rail: the linked server's tab counts under local work, the quick connect under sessions
  const railCount = group => `(document.querySelector('.rail-group[data-peek-target="${group}"] .rail-count.is-connected')?.textContent.trim() ?? '')`
  check('the folded rail counts the server tab under local work, not the session list',
    await until(`${railCount('local')} === '1' && ${railCount('sessions')} === '1'`, 5000),
    JSON.stringify({ local: await js(railCount('local')), sessions: await js(railCount('sessions')) }))
  // The server's tab is in the project's work group; the quick connect tab waits in 일반 (tab groups)
  check('the server tab is shown in its project\'s work group', await until(`document.querySelector('.tab-group-select-name')?.textContent === 'work app' && ${tabs}.length === 1`, 5000))
  await pickTabGroup(driver, '일반')
  check('the general group shows the quick connect tab', await until(`${tabs}.length === 1 && !${tabs}[0].textContent.includes('프로젝트 서버')`, 5000))
  const quick = await js(`${tabs}[0].dataset.tabId`)
  await js(`${workTabRow('프로젝트 서버')}.querySelector('.local-terms-open').click()`)
  check('pressing its row goes to that tab', await until(`${tabs}.length === 1 && ${tabs}[0].classList.contains('active') && ${tabs}[0].textContent.includes('프로젝트 서버')`, 5000))

  // A quick connect tab dragged onto the project: refused with the reason, and the tab stays in the window
  await pickTabGroup(driver, '일반')
  // Wait for the other group's tab to finish leaving the strip (its exit animation keeps it a moment)
  await until(`${tabs}.length === 1 && !!document.querySelector('.terminal-tab[data-tab-id="${quick}"]')`, 5000)
  const tabCount = await js(`${tabs}.length`)
  await js(`(() => {
    const tab = document.querySelector('.terminal-tab[data-tab-id="${quick}"]')
    const data = new DataTransfer()
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
    const target = ${project}
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }))
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
  })()`)
  check('a quick connect tab is refused with the reason', await until(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('저장한 세션만'))`, 5000))
  await sleep(800)
  check('and the dropped tab stays in the window (not popped out)', (await js(`${tabs}.length`)) === tabCount && await js(`!!document.querySelector('.terminal-tab[data-tab-id="${quick}"]')`),
    JSON.stringify(await js(`({ tabs: ${tabs}.map(t => t.dataset.tabId), group: document.querySelector('.tab-group-select-name')?.textContent, quick: ${JSON.stringify(quick)}, count: ${tabCount} })`)))
  check('the project still has the one server (its tab in the worktree)', await js(`!!${workTabRow('프로젝트 서버')} &&
    JSON.parse(localStorage.getItem('ezshell.localProjectServers') ?? '{}')[Object.keys(JSON.parse(localStorage.getItem('ezshell.localProjectServers') ?? '{}'))[0]]?.length === 1`))

  await send('Page.reload')
  await sleep(1500)
  await unlock(driver)
  check('after a reload the server is still under the project', await until(`${serverRows}.length === 1 && ${serverRows}[0].textContent.includes('프로젝트 서버')`, 15000))
  check('nothing connected by itself', (await js(`${tabs}.filter(t => t.textContent.includes('프로젝트 서버')).length`)) === 0)

  await js(`${serverRows}[0].querySelector('.local-server-unlink').click()`)
  check('the X takes it out of the project', await until(`${serverRows}.length === 0`, 3000))

  // The session's right-click menu links it again
  await js(`document.querySelector('[data-session-id="${SESSION}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 200 }))`)
  check('the session menu has the link entry', await until(`[...document.querySelectorAll('.context-menu-item')].some(i => i.textContent.includes('로컬 작업에 묶기'))`, 3000))
  await js(`[...document.querySelectorAll('.context-menu-item')].find(i => i.textContent.includes('로컬 작업에 묶기')).click()`)
  check('it lists the registered project', await until(`[...document.querySelectorAll('.folder-move-panel .context-menu-item')].some(i => i.textContent.includes('work app'))`, 8000))
  await js(`[...document.querySelectorAll('.folder-move-panel .context-menu-item')].find(i => i.textContent.includes('work app')).click()`)
  check('picking the project links the session again', await until(`${serverRows}.length === 1`, 3000))

  // 2026-11-20 user decision: a linked session opened from the session list is not the work's tab
  await js(`document.querySelector('.session-item[data-session-id="${SESSION}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`)
  // With general tabs only the work selector is not shown at all
  check('opened from the session list, the linked session is a general tab', await until(`(document.querySelector('.tab-group-select-name')?.textContent ?? '일반') === '일반' &&
    ${tabs}.some(t => t.classList.contains('active') && t.textContent.includes('프로젝트 서버'))`, 20000),
    JSON.stringify(await js(`({ group: document.querySelector('.tab-group-select-name')?.textContent, tabs: ${tabs}.map(t => t.textContent) })`)))
  check('it is not listed in the work, whose 서버 row stays to connect', await js(`!document.querySelector('.local-worktree [data-work-tab-id]') && ${serverRows}.length === 1 && !${serverRows}[0].querySelector('.local-server-dot.is-on')`))
  const fromList = await js(`${tabs}.find(t => t.classList.contains('active')).dataset.tabId`)
  await js(`document.querySelector('.terminal-tab[data-tab-id="${fromList}"] .tab-close, .terminal-tab[data-tab-id="${fromList}"] [aria-label*="닫기"]')?.click()`)
  await until(`!document.querySelector('.terminal-tab[data-tab-id="${fromList}"]')`, 5000)

  await js(`${serverRows}[0].querySelector('.local-server-open').click()`)
  const groupName = `document.querySelector('.tab-group-select-name')?.textContent`
  await until(`${groupName} === 'work app' && ${tabs}[0]?.querySelector('[data-tab-label]')?.textContent === '프로젝트 서버'`)
  const linkedTab = await js(`${tabs}[0].dataset.tabId`)
  const other = path.join(process.env.E2E_PROFILE, 'another work')
  fs.mkdirSync(other)
  await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([folder, other]))});
    window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
  const otherRow = `[...document.querySelectorAll('.local-worktree')].find(row => row.dataset.worktreePath === ${JSON.stringify(other)})`
  await until(`!!${otherRow}`)
  await js(`${otherRow}.querySelector('.local-worktree-open').click()`)
  await until(`${groupName} === 'another work' && ${tabs}.length === 1`)
  const localTab = await js(`${tabs}[0].dataset.tabId`)
  const namedTab = name => `${tabs}.find(tab => tab.querySelector('[data-tab-label]')?.textContent === ${JSON.stringify(name)})`
  const localRemains = `${groupName} === 'another work' && ${tabs}.some(tab => tab.dataset.tabId === ${JSON.stringify(localTab)})`
  const localServer = (folder, sessionId) => `[...document.querySelectorAll('.local-project')].find(project => project.dataset.projectFolder === ${JSON.stringify(folder)})
    ?.querySelector(${JSON.stringify(`.local-server[data-session-id="${sessionId}"]`)})`
  const sourceSession = `document.querySelector('.session-item[data-session-id="${SESSION}"]')`
  const openFromWork = async label => {
    await driver.click(...await driver.center(`document.querySelector('.terminal-tabs .new-tab-btn')`))
    const item = `[...document.querySelectorAll('.new-tab-menu-item')].find(item => item.textContent.trim() === ${JSON.stringify(label)})`
    if (!(await until(`!!${item}`))) throw new Error(`Missing new-tab menu action: ${label}`)
    await driver.click(...await driver.center(item))
  }
  await openFromWork('기존 세션 선택…')
  await until(`!!document.querySelector('.session-picker-item') && document.activeElement === document.querySelector('.session-picker-search input')`)
  await driver.enter()
  check('an existing session opens in the work whose tab menu picked it', await until(`
    ${localRemains} && ${namedTab('프로젝트 서버')}?.classList.contains('active') &&
    ${namedTab('프로젝트 서버')}.dataset.tabId !== ${JSON.stringify(linkedTab)}
  `))
  const pickedTab = await js(`${namedTab('프로젝트 서버')}?.dataset.tabId`)
  const assigned = localServer(other, SESSION)
  const otherProject = `[...document.querySelectorAll('.local-project')].find(project => project.dataset.projectFolder === ${JSON.stringify(other)})`
  check('the picked session\'s tab is listed in that work (current, connected) and the saved source row stays idle', await until(`
    !!${otherProject}?.querySelector(${JSON.stringify(`[data-work-tab-id="${pickedTab}"] .local-terms-row.is-current .local-terms-dot.is-on`)}) && !${assigned} &&
    ${sourceSession}?.getAttribute('aria-selected') === 'false' &&
    !${sourceSession}.querySelector('.session-tab-badge--connected')
  `))
  check('the local server assignment is saved under the work that opened it', await js(`
    Object.values(JSON.parse(localStorage.getItem('ezshell.localProjectServers') ?? '{}')).filter(ids => ids.includes(${JSON.stringify(SESSION)})).length === 2
  `))

  for (const [name, save] of [['새 저장 세션', true], ['저장하지 않은 세션', false]]) {
    await openFromWork('새 세션…')
    await until(`!!document.querySelector('input[placeholder="My Server"]')`)
    await js(`(() => {
      const set = ${SET}
      const form = document.querySelector('input[placeholder="My Server"]').closest('form')
      set(form.querySelector('input[placeholder="My Server"]'), ${JSON.stringify(name)})
      set(form.querySelector('input[placeholder="192.168.1.1"]'), '127.0.0.1')
      set(form.querySelector('input[type=number]'), '${port}')
      set(form.querySelector('input[placeholder="root"]'), 'tester')
      set(form.querySelector('input[placeholder="••••••••"]'), 'x')
      const save = form.querySelector('.checkbox-group input')
      if (save.checked !== ${save}) save.click()
    })()`)
    await js(`document.querySelector('input[placeholder="My Server"]').closest('form').requestSubmit()`)
    check(`${name} stays in the work alongside its local terminal`, await until(`
      ${localRemains} && ${namedTab(name)}?.classList.contains('active')
    `))
    if (save) {
      check('a new saved connection is listed in that work as the current tab', await until(`
        [...${otherProject}.querySelectorAll('[data-work-tab-id] .local-terms-row.is-current')].some(row => row.querySelector('.local-terms-name').textContent === ${JSON.stringify(name)})
      `))
    }
  }
  await js(`document.querySelector(${JSON.stringify(`[data-work-tab-id="${linkedTab}"] .local-terms-open`)}).click()`)
  check('the original saved session tab is still in its own work', await until(`
    ${groupName} === 'work app' && ${tabs}.length === 1 && ${tabs}[0].dataset.tabId === ${JSON.stringify(linkedTab)}
  `))
  await pickTabGroup(driver, 'another work')
  check('switching back finds the three SSH tabs in the work that opened them', await until(`
    ${localRemains} && ${tabs}.length === 4 && ${namedTab('프로젝트 서버')}?.dataset.tabId === ${JSON.stringify(pickedTab)} &&
    Boolean(${namedTab('새 저장 세션')} && ${namedTab('저장하지 않은 세션')})
  `), JSON.stringify(await js(`({ group: ${groupName}, tabs: ${tabs}.map(tab => [tab.dataset.tabId, tab.querySelector('[data-tab-label]')?.textContent]) })`)))

  finish()
})().catch(error => { console.error(error); process.exit(1) })
