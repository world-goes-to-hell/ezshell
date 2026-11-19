// The usage of an agent ezShell launched, in the app's status bar instead of the terminal
// (src/ipc/agentUsageReport.js). The fake Claude of e2e/support/localAgentApp.js runs the real status
// line script with input shaped like Claude Code's.
const fs = require('fs')
const path = require('path')
const { connect, createChecks, sleep, unlock, openLocalProject } = require('../support/driver')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE
const file = name => path.join(profile, name)
const read = name => fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8') : ''

async function waitFor(test, tries = 160) {
  for (let index = 0; index < tries; index++) {
    const value = await test()
    if (value) return value
    await sleep(75)
  }
  return null
}

/** Runs a command inside the fake agent's environment (EZSHELL_* of that launch) */
async function inAgent(agent, command) {
  fs.writeFileSync(file(agent + '-command'), command)
  const raw = await waitFor(() => read(agent + '-result'))
  if (!raw) throw new Error('agent command did not finish')
  fs.unlinkSync(file(agent + '-result'))
  return JSON.parse(raw)
}

;(async () => {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  const { js, until, send, shot } = driver
  // The usage row shown below the terminal in front (hidden tabs stay laid out but invisible)
  const status = `[...document.querySelectorAll('.agent-pane-usage')].find(el => getComputedStyle(el).visibility === 'visible')`
  await unlock(driver)
  await send('Page.bringToFront')
  await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([profile]))})`)

  const openAgent = async (kind, id) => {
    await openLocalProject(driver)
    await until(`!!document.querySelector('#local-project-agent')`)
    await js(`(() => {
      const select = document.querySelector('#local-project-agent')
      select.value = ${JSON.stringify(kind)}
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await js(`document.querySelector('.local-project-dialog button[type=submit]').click()`)
    return until(`document.body.textContent.includes('fixture ready: ${id}')`, 30000)
  }

  check('a Codex and a Claude open in local tabs', await openAgent('codex', 'codex-1') && await openAgent('claude', 'claude-2'))
  check('nothing is shown before an agent reports', await js(`!${status}`))

  const resets = Math.floor(Date.now() / 1000) + 130 * 60
  fs.writeFileSync(file('status.json'), JSON.stringify({
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    effort: { level: 'high' },
    context_window: { used_percentage: 38, context_window_size: 1000000 },
    rate_limits: { five_hour: { used_percentage: 92, resets_at: resets }, seven_day: { used_percentage: 41, resets_at: resets + 86400 * 3 } },
    transcript_path: 'C:\\not\\sent.jsonl'
  }))
  const result = await inAgent('claude-2', `"%EZSHELL_TEST_AGENT_EXE%" "%EZSHELL_AGENT_USAGE_SCRIPT%" < "${file('status.json')}"`)
  check('the status line script prints only a color reset (no row in the terminal)', result.exit === 0 && result.stdout === '\u001b[0m', JSON.stringify(result))

  check('below the Claude terminal, its model and windows are shown', await until(`(() => {
    const el = ${status}
    return !!el && el.textContent.includes('Opus 5.5') && el.textContent.includes('5H') && el.textContent.includes('92%') && el.textContent.includes('7D') && el.textContent.includes('41%') && el.textContent.includes('CTX') && el.textContent.includes('38%')
  })()`, 8000), await js(`${status}?.textContent ?? ''`))
  check('the time left of the 5-hour window is shown', await js(`/2h\\d\\dm|2h0\\dm|2h1\\dm/.test(${status}.textContent)`), await js(`${status}.textContent`))
  check('the model and effort form one group before the usage meters', await js(`(() => {
    const row = ${status}
    const identity = row.querySelector('.agent-usage-identity')
    return identity?.querySelector('.agent-usage-model')?.textContent === 'Opus 5.5' &&
      identity.querySelector('.agent-usage-effort')?.textContent === 'high' &&
      identity.nextElementSibling?.matches('.agent-usage-meters')
  })()`))
  check('effort stays visible at narrow split sizes and the tooltip keeps every metric', await js(`(() => {
    const row = ${status}
    const effort = row.querySelector('.agent-usage-effort')
    row.style.width = '180px'
    const chip = effort.getBoundingClientRect()
    const bounds = row.getBoundingClientRect()
    const fits = chip.left >= bounds.left && chip.right <= bounds.right &&
      row.scrollWidth <= row.clientWidth + 1 && row.title.includes('7일 41%')
    row.style.removeProperty('width')
    return fits
  })()`))
  await shot('local-agent-usage-effort')
  check('above 90% the window turns red', await js(`!!${status}.querySelector('.agent-usage-meter.is-high')`))
  check('no path reached the window', await js(`!document.body.innerHTML.includes('sent.jsonl')`))

  // The Codex tab in front: it has not reported, so the bar is empty
  // Tabs are named after the folder only: the Codex tab was opened first, the Claude tab second
  await js(`document.querySelectorAll('.terminal-tab')[0]?.click()`)
  check('below the Codex terminal (no report) there is nothing', await until(`!${status}`, 5000))
  await js(`document.querySelectorAll('.terminal-tab')[1]?.click()`)
  check('back on the Claude tab it shows again', await until(`!!${status}`, 5000))
  check('the row sits right below the Claude terminal, inside its pane', await js(`(() => {
    const row = ${status}
    const pane = row.closest('.local-terminal-pane')
    const host = pane?.querySelector('.local-terminal-host')
    const gap = host && row.getBoundingClientRect().top - host.getBoundingClientRect().bottom
    return !!host && Math.abs(gap - 4) <= 0.25 && row.getBoundingClientRect().height <= 24
  })()`))

  const terminalGap = `(() => {
    const row = ${status}
    const screen = row?.previousElementSibling?.querySelector('.xterm-screen')
    return screen?.offsetHeight ? row.getBoundingClientRect().top - screen.getBoundingClientRect().bottom : null
  })()`
  check('the last terminal row clears the usage bar by at least four pixels', await until(`${terminalGap} >= 3.75`), await js(terminalGap))
  const beforeResize = await js('innerHeight')
  await js('window.resizeTo(outerWidth, outerHeight - 17)')
  check('resizing the window keeps the terminal text above the usage bar', await until(`
    innerHeight < ${beforeResize} && ${terminalGap} >= 3.75
  `), await js(terminalGap))

  // Shift+Enter in the agent's terminal adds a line: ESC + Enter goes to the shell, not a lone Enter
  const shellId = await js(`[...document.querySelectorAll('.local-terminal-pane[data-local-shell-id]')].find(p => getComputedStyle(p).visibility === 'visible')?.dataset.localShellId`)
  const inputFile = path.join(profile, String(shellId).replace(':', '-') + '-input')
  const before = fs.existsSync(inputFile) ? fs.readFileSync(inputFile, 'utf8').length : 0
  await js(`[...document.querySelectorAll('.local-terminal-pane[data-local-shell-id]')].find(p => p.dataset.localShellId === ${JSON.stringify(shellId)}).querySelector('.xterm-helper-textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 })
  await sleep(500)
  // Focusing the pane sends a focus report (ESC [ I) first: not part of the key
  const sent = (fs.existsSync(inputFile) ? fs.readFileSync(inputFile, 'utf8').slice(before) : '').split('\x1b[I').join('').split('\x1b[O').join('')
  check('Shift+Enter sends ESC + Enter to an agent (a new line, not the prompt)', sent === '\x1b\r', JSON.stringify(sent))

  // The agent ends: its usage goes away
  fs.writeFileSync(file('claude-2-exit-code'), '0')
  check('when the agent ends the row goes away', await until(`!${status}`, 10000))

  finish()
})().catch(error => { console.error(error); process.exit(1) })
