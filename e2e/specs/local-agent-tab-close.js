const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, unlock, openLocalAgent } = require('../support/driver')

;(async () => {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  const { js, until, send } = driver
  const { check, finish } = createChecks()
  const profile = process.env.E2E_PROFILE
  const activeTab = `document.querySelector('.terminal-tab.active')`
  const dialog = `document.querySelector('.confirm-dialog')`
  const cancel = `document.querySelector('.confirm-dialog .btn-secondary')`
  const confirm = `document.querySelector('.confirm-dialog .btn-danger')`
  const closeActiveTab = () => js(`${activeTab}.querySelector('.tab-close').click()`)

  await unlock(driver)
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await openLocalAgent(driver, undefined, profile)
  await until(`!!${activeTab}`)
  const targetId = JSON.stringify(await js(`${activeTab}.dataset.tabId`))
  await openLocalAgent(driver, 'claude', profile)
  check('a Claude session opens in a second tab', await until(`
    ${activeTab}?.dataset.tabId !== ${targetId} && document.body.textContent.includes('fixture ready: claude-1')
  `, 30000))
  const agentShell = JSON.stringify(await js(`${activeTab}.dataset.tabId`))

  await js(`${activeTab}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 450, clientY: 80 }))`)
  const merge = `[...document.querySelectorAll('.tab-context-menu .menu-item')].find(item => item.textContent.startsWith('칸으로 병합: '))`
  await until(`!!${merge}`)
  await js(`${merge}.click()`)
  const agentPane = `[...document.querySelectorAll('.local-terminal-pane')].find(pane => pane.dataset.localShellId === ${agentShell} && pane.dataset.localTabId === ${targetId})`
  check('the agent moves into a split pane without ending its session', await until(`
    ${activeTab}?.dataset.tabId === ${targetId} && Boolean(${agentPane})
  `))

  const statusFile = path.join(profile, 'claude-1-program-status')
  fs.writeFileSync(statusFile, 'state=idle:app=claude')
  await until(`window.electronAPI.agentMessagesSnapshot().then(state =>
    state.agents.some(agent => agent.shellId === ${agentShell} && agent.active && agent.status === 'idle'))`)
  await closeActiveTab()
  check('an agent waiting for input still gets a close confirmation', await until(`
    ${dialog}?.textContent.includes('실행 중인 에이전트 세션') && document.activeElement === ${cancel}
  `))
  await driver.enter()
  await until(`!${dialog}`)

  fs.writeFileSync(statusFile, 'state=working:app=claude')
  await until(`window.electronAPI.localShellHasWorkingAgent([${agentShell}])`)
  await closeActiveTab()
  check('the tab X warns about the working split pane and focuses Cancel', await until(`
    ${dialog}?.textContent.includes('작업 중인 에이전트 세션') && document.activeElement === ${cancel} && Boolean(${agentPane})
  `))
  await driver.enter()
  check('cancel keeps the tab and its working agent', await until(`
    !${dialog} && ${activeTab}?.dataset.tabId === ${targetId} && Boolean(${agentPane}) &&
    window.electronAPI.localShellHasWorkingAgent([${agentShell}])
  `))

  await closeActiveTab()
  await until(`Boolean(${confirm})`)
  await js(`${confirm}.click()`)
  check('confirmation closes the tab and both local shells', await until(`
    !${activeTab} && window.electronAPI.localShellList().then(shells =>
      shells.every(shell => shell.id !== ${targetId} && shell.id !== ${agentShell}))
  `))

  await openLocalAgent(driver, undefined, profile)
  await until(`Boolean(${activeTab})`)
  await closeActiveTab()
  check('a plain terminal tab closes directly', await until(`!${activeTab} && !${dialog}`))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
