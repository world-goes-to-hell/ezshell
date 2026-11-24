const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, openLocalAgent, sleep, unlock } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  if (process.platform !== 'win32' || process.env.E2E_APP) {
    console.log('SKIP local agent fixture needs the Windows development build')
    return
  }
  const driver = await connect()
  const { send, js, until, center, click, move } = driver
  const syncKey = async (key, windowsVirtualKeyCode) => {
    const options = { key, code: key, windowsVirtualKeyCode }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...options })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...options })
  }
  const tab = () => syncKey('Tab', 9)
  const esc = () => syncKey('Escape', 27)
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`
  const dialog = q('.work-overview')
  const row = id => q(`.work-overview-agent[data-agent-id="${id}"]`)
  const pane = id => `${q(`[aria-label="${id} 메시지함"]`)}?.closest('[data-local-shell-id]')`
  const preview = q('.work-overview-preview-host')
  const activeTab = `${q('.terminal-tab.active')}?.dataset.tabId`
  const profile = process.env.E2E_PROFILE
  const service = path.join(profile, 'service')
  const tools = path.join(profile, 'tools')
  fs.mkdirSync(service)
  fs.mkdirSync(tools)

  await unlock(driver)
  await send('Page.bringToFront')
  await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([service, tools]))});
    window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
  await openLocalAgent(driver, 'codex', service)
  if (!(await until(`!!${pane('codex-1')}`))) throw new Error('Codex fixture did not open')
  const codexTab = await js(`${pane('codex-1')}.dataset.localTabId`)
  await openLocalAgent(driver, 'claude', tools)
  if (!(await until(`${pane('claude-2')}?.dataset.localTabId === ${activeTab} && !!${activeTab}`))) throw new Error('Claude fixture did not open')
  const claudeTab = await js(activeTab)
  const originalSize = await js('[outerWidth, outerHeight, screenX, screenY].join()')
  const codexShell = await js(`${pane('codex-1')}.dataset.localShellId`)
  fs.writeFileSync(path.join(profile, 'codex-1-program-status'), 'state=blocked:app=codex:kind=question:msg=VGVzdA==')
  fs.writeFileSync(path.join(profile, 'claude-2-program-status'), 'state=working:app=claude-code')

  await tab()
  check('a single Tab does not open the work overview', await js(`!${dialog}`))
  await sleep(380)
  await tab()
  await tab()
  check('double Tab shows both workspaces and the live agent states', await until(`
    ${row('codex-1')}?.closest('.work-overview-project').querySelector('h3').textContent === 'service' &&
    ${row('claude-2')}?.closest('.work-overview-project').querySelector('h3').textContent === 'tools' &&
    ${row('codex-1')}?.dataset.status === 'blocked' && ${row('claude-2')}?.dataset.status === 'working' &&
    getComputedStyle(${q('.work-overview-backdrop')}).backdropFilter === 'blur(14px)'
  `), await js(`${dialog}?.textContent`))
  check('the overview fills the monitor and lays out projects as cards', await until(`
    Math.abs(outerWidth - screen.width) <= 2 && Math.abs(outerHeight - screen.height) <= 2 &&
    ${q('.work-overview-grid')}.children.length === 2 &&
    getComputedStyle(${q('.work-overview-grid')}).gridTemplateColumns.split(' ').length > 1
  `), await js('JSON.stringify({ current: [outerWidth, outerHeight], display: [screen.width, screen.height] })'))

  const project = id => `${row(id)}?.closest('.work-overview-project')`
  await click(...await center(`${project('codex-1')}?.querySelector('h3')`))
  check('clicking inside a project card keeps the overview open', await js(`!!${dialog}`))
  const gap = await js(`(() => {
    const first = ${project('codex-1')}.getBoundingClientRect()
    const second = ${project('claude-2')}.getBoundingClientRect()
    return [(first.right + second.left) / 2, first.top + first.height / 2]
  })()`)
  await click(...gap)
  check('clicking the empty space between cards closes the overview and restores the window', await until(`
    !${dialog} && [outerWidth, outerHeight, screenX, screenY].join() === ${JSON.stringify(originalSize)}
  `))
  await tab()
  await tab()
  if (!(await until(`!!${row('codex-1')}`))) throw new Error('The overview did not reopen after clicking the background')

  await js(`window.overviewTestPane = ${pane('codex-1')}`)
  await move(...await center(row('codex-1')))
  check('hover shows the real Codex shell while Claude remains the active tab', await until(`
    ${preview}?.contains(${pane('codex-1')}) && ${activeTab} === ${JSON.stringify(claudeTab)}
  `))
  // Most of the screen's height (2026-11-24 user request: 460px showed only a few lines)
  const previewHeight = await js(`(() => {
    const box = document.querySelector('.work-overview-preview').getBoundingClientRect()
    return { height: Math.round(box.height), top: Math.round(box.top), bottom: Math.round(box.bottom), viewport: innerHeight }
  })()`)
  check('the preview takes most of the screen height and stays on screen',
    previewHeight.height >= Math.min(Math.round(previewHeight.viewport * 0.8), previewHeight.viewport - 40) - 2 &&
    previewHeight.top >= 0 && previewHeight.bottom <= previewHeight.viewport, JSON.stringify(previewHeight))
  await driver.shot('local-work-overview')
  const screen = `${pane('codex-1')}?.querySelector('.xterm-screen')`
  await move(...await center(q('.work-overview-preview .work-overview-header')))
  await move(...await center(screen))
  await sleep(2700)
  const stillPreviewing = await js(`${preview}?.contains(${pane('codex-1')}) === true`)
  check('moving from the preview header into the terminal keeps it open without a click', stillPreviewing)
  if (!stillPreviewing) throw new Error('The preview closed while the pointer was inside the terminal')
  await click(...await center(screen))
  const inputPath = path.join(profile, codexShell.replace(':', '-') + '-input')
  const readInput = () => fs.existsSync(inputPath) ? fs.readFileSync(inputPath, 'utf8') : ''
  const offset = readInput().length
  await send('Input.insertText', { text: 'preview answer' })
  await driver.enter()
  for (let attempt = 0; attempt < 20 && !readInput().slice(offset).includes('preview answer\r'); attempt++) await sleep(100)
  check('typing and Enter in the temporary view reach the selected shell', readInput().slice(offset).includes('preview answer\r'))
  check('interacting with the preview keeps the other workspace active', await js(`${activeTab} === ${JSON.stringify(claudeTab)}`))
  const background = await js('[innerWidth / 2, innerHeight - 24]')
  await move(...background)
  await sleep(650)
  check('leaving the preview keeps it open while its input has focus', await js(`
    ${preview}?.contains(document.activeElement) && ${preview}.contains(${pane('codex-1')})
  `))

  await esc()
  check('Escape returns the same terminal node to its regular tab and back to the list', await until(`
    ${dialog} && !${preview} && window.overviewTestPane === ${pane('codex-1')} && ${pane('codex-1')}?.closest('.terminal-wrapper') &&
    document.activeElement === ${row('codex-1')} && ${activeTab} === ${JSON.stringify(claudeTab)}
  `))
  await move(...await center(row('codex-1')))
  await until(`${preview}?.contains(${pane('codex-1')})`)
  await move(...await center(screen))
  await move(...background)
  check('leaving an unfocused terminal preview returns to the list', await until(`${dialog} && !${preview}`))
  await click(...await center(row('codex-1')))
  check('click switches workspaces and focuses the selected agent', await until(`
    !${dialog} && ${activeTab} === ${JSON.stringify(codexTab)} && ${pane('codex-1')}?.contains(document.activeElement)
  `))
  check('closing the overview restores the original window bounds', await until(`
    [outerWidth, outerHeight, screenX, screenY].join() === ${JSON.stringify(originalSize)}
  `))

  const [x, y] = await center(screen)
  await driver.menuPick(x, y, '분할', '좌우 분할')
  const splitPanes = `[...${pane('codex-1')}.parentElement.querySelectorAll('.local-terminal-pane[data-local-shell-id]')]`
  check('the agent tab has two panes before previewing', await until(`${splitPanes}.length === 2`))
  await tab()
  await tab()
  if (!(await until(`!!${row('codex-1')}`))) throw new Error('The overview did not reopen')
  await move(...await center(row('codex-1')))
  check('preview isolates the selected pane in a split tab', await until(`
    ${preview}?.contains(${pane('codex-1')}) &&
    ${splitPanes}.filter(pane => pane.checkVisibility()).length === 1 && ${pane('codex-1')}.checkVisibility()
  `), await js(`JSON.stringify({ inPreview: !!${preview}?.contains(${pane('codex-1')}), preview: !!document.querySelector('.work-overview-preview'), panes: ${splitPanes}.map(p => [p.dataset.localShellId, p.checkVisibility(), getComputedStyle(p).display, Math.round(p.getBoundingClientRect().height)]) })`))
  await click(...await js('[innerWidth / 2, innerHeight - 24]'))
  check('clicking the blank background with a preview open closes the overview and restores both panes', await until(`
    !${dialog} && ${splitPanes}.every(pane => pane.checkVisibility())
  `))

  await openLocalAgent(driver, undefined, service)
  if (!(await until(`!!${activeTab} && ${activeTab} !== ${JSON.stringify(codexTab)}`))) throw new Error('Second service tab did not open')
  const secondTab = await js(activeTab)
  await js(`(() => {
    const tab = document.querySelector('.terminal-tab.active')
    const dataTransfer = new DataTransfer()
    tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    window.overviewTestDrag = { tab, dataTransfer }
  })()`)
  await sleep(250)
  const dropAtEdge = type => js(`(() => {
    const { dataTransfer } = window.overviewTestDrag
    const rect = document.querySelector('.terminal-area').getBoundingClientRect()
    const clientX = rect.right - 15
    const clientY = rect.top + rect.height / 2
    const target = document.elementFromPoint(clientX, clientY)
    target.dispatchEvent(new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }))
  })()`)
  await dropAtEdge('dragover')
  if (!(await until(`!!${q('.drop-zone-right.active')}`, 3000))) throw new Error('The right edge did not become a drop target')
  await dropAtEdge('drop')
  await js(`(() => {
    const { tab, dataTransfer } = window.overviewTestDrag
    tab.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
  })()`)
  const activeScreenTab = `${q('.split-pane.active-pane .split-pane-tab-item.active')}?.dataset.tabId`
  check('the second terminal is focused in the work’s split-screen layout', await until(`${activeScreenTab} === ${JSON.stringify(secondTab)}`))
  await tab()
  await tab()
  await until(`!!${row('claude-2')}`)
  await js(`${row('claude-2')}.click()`)
  await until(`${activeTab} === ${JSON.stringify(claudeTab)}`)
  await tab()
  await tab()
  await until(`!!${row('codex-1')}`)
  await js(`${row('codex-1')}.click()`)
  check('jumping back restores the screens and focuses the chosen agent’s tab', await until(`
    !${dialog} && document.querySelectorAll('.split-pane[data-screen]').length === 2 &&
    ${activeScreenTab} === ${JSON.stringify(codexTab)} && ${pane('codex-1')}.contains(document.activeElement)
  `))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
