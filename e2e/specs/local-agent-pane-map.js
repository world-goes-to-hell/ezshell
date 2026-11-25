const fs = require('fs')
const path = require('path')
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

  // A working agent's cell shows the border trace the terminal pane shows (styles/app/agent-work-trace.css)
  const worker = expected.find(id => id.startsWith('codex-'))
  const statusFile = path.join(process.env.E2E_PROFILE, `${worker}-program-status`)
  const cell = `document.querySelector('.pane-map-cell[data-agent-id="${worker}"]')`
  const trace = `getComputedStyle(${cell}, '::after')`
  check('an idle agent\'s cell has no trace', await until(`${cell}?.dataset.agentWork === 'idle' && ${trace}.opacity === '0'`))
  // A prompt first, as a user starts a turn (local-agent-messages does the same)
  await js(`window.electronAPI.agentMessagesSnapshot().then(state => {
    const shellId = state.agents.find(agent => agent.id === ${JSON.stringify(worker)}).shellId
    window.electronAPI.localShellWrite(shellId, 'start work')
    window.electronAPI.localShellWrite(shellId, '\\r')
  })`)
  fs.writeFileSync(statusFile, 'state=working:app=codex')
  check('a working agent\'s cell runs the trace around its border', await until(`
    ${cell}?.dataset.agentWork === 'working' && ${trace}.opacity === '1' && ${trace}.animationPlayState === 'running'
  `, 10000))
  await driver.shot('local-agent-pane-map-working')
  fs.writeFileSync(statusFile, 'state=idle:app=codex')
  check('the trace goes when the agent rests', await until(`${cell}?.dataset.agentWork === 'idle' && ${trace}.opacity === '0'`, 10000))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
