const { connect, createChecks, openLocalAgent, unlock } = require('../support/driver')

;(async () => {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }

  const driver = await connect()
  const { js, until, send } = driver
  const { check, finish } = createChecks()
  const tabs = `[...document.querySelectorAll('.terminal-tab')]`
  const agents = `window.electronAPI.agentMessagesSnapshot().then(state => state.agents.filter(agent => agent.active && agent.mcpConnected))`
  await unlock(driver)
  await send('Page.bringToFront')

  for (const kind of ['claude', 'codex', 'claude', 'codex', 'claude']) {
    await openLocalAgent(driver, kind, process.env.E2E_PROFILE)
  }
  check('five agents each connect in their own terminal', await until(`
    ${tabs}.length === 5 && (${agents}).then(items => new Set(items.map(item => item.shellId)).size === 5)
  `, 30000))
  const [target, ...sources] = await js(`${tabs}.map(tab => tab.dataset.tabId)`)
  const expected = (await js(agents)).map(agent => agent.id).sort()

  for (const id of sources) {
    const tab = `${tabs}.find(tab => tab.dataset.tabId === ${JSON.stringify(id)})`
    await js(`${tab}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 450, clientY: 80 }))`)
    const merge = `[...document.querySelectorAll('.tab-context-menu .menu-item')].find(item =>
      item.textContent.startsWith('칸으로 병합: ') && item.textContent.endsWith('(1번째 탭)'))`
    await until(`Boolean(${merge})`)
    await js(`${merge}.click()`)
    if (!(await until(`!${tab}`))) throw new Error(`Could not move ${id} into ${target}`)
  }

  const badge = `document.querySelector('[data-local-session-id="${target}"] .local-terms-panes')`
  await until(`${badge}?.textContent === '5세션'`)
  await js(`${badge}.click()`)
  check('the layout map identifies the agent in every one of the five panes', await until(`
    JSON.stringify([...document.querySelectorAll('.pane-map-cell[data-agent-id]')].map(cell => cell.dataset.agentId).sort()) ===
      ${JSON.stringify(JSON.stringify(expected))} &&
    document.querySelectorAll('.pane-map-cell .local-agent-provider').length === 5
  `))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
