// Saved SSH sessions grouped under a local project in the sidebar's local tree ("서버"), kept across
// a reload (lib/localProjectServers.ts). Run by e2e/run.js, which starts the test SSH server.
const fs = require('fs')
const path = require('path')
const { sleep, createChecks, connect, unlock, connectSsh, pickTabGroup } = require('../support/driver')
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
  check('and its dot turns green', await until(`!!${serverRows}[0]?.querySelector('.local-server-dot.is-on')`, 10000))
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
  await js(`${serverRows}[0].querySelector('.local-server-open').click()`)
  check('pressing it again goes to that tab instead of connecting again', await until(`${tabs}.length === 1 && ${tabs}[0].classList.contains('active') && ${tabs}[0].textContent.includes('프로젝트 서버')`, 5000))

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
  check('the list still has the one server', await js(`${serverRows}.length === 1`))

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

  finish()
})().catch(error => { console.error(error); process.exit(1) })
