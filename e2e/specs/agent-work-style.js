// 에이전트 작업 중 표시 (설정 > 테마 > 창 효과, lib/agentWorkStyle.ts): four looks for a working agent's pane,
// each previewed on its own card whatever the app's choice (style queries on --agent-work-style), the
// costly one says so, and a choice applies to the app's working panes and is kept.
const { connect, createChecks, selectThemeTab, unlock, pageProblems } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { send, js, until, shot } = driver
  try {
    await unlock(driver)
    const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 }
    await js(`document.activeElement && document.activeElement.blur()`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma })
    await selectThemeTab(driver, '창 효과')
    const cards = `[...document.querySelectorAll('.agent-work-styles .agent-work-style')]`
    check('the window effects tab offers four looks, 안쪽 번짐 chosen by default', await until(`${cards}.length === 4 &&
      ${cards}.map(card => card.querySelector('.agent-work-style-name').textContent).join('|') === '안쪽 번짐|테두리 깜빡임|도는 빛|움직이지 않음' &&
      document.querySelector('.agent-work-style[aria-checked="true"]')?.dataset.style === 'glow'`, 8000),
      await js(`${cards}.map(card => card.textContent).join(' / ')`))
    check('each look tells its CPU use, the light running around the border warns', await js(`${cards}.every(card => /CPU/.test(card.querySelector('.agent-work-style-cpu').textContent)) &&
      document.querySelector('.agent-work-style[data-style="trace"] .agent-work-style-cpu').dataset.cost === 'high' &&
      document.querySelector('.agent-work-style[data-style="trace"] .agent-work-style-cpu').textContent.includes('CPU 많이')`))

    const lookOf = selector => `(() => { const s = getComputedStyle(${selector}, '::after'); return { animation: s.animationName, shadow: s.boxShadow !== 'none', border: s.borderTopStyle, mask: s.maskImage !== 'none' } })()`
    const previews = await js(`Object.fromEntries(${cards}.map(card => [card.dataset.style, ${lookOf("card.querySelector('.agent-work-preview')")}]))`)
    check('every card previews its own look', previews.glow?.animation === 'agent-work-breathe' && previews.glow.shadow &&
      previews.pulse?.animation === 'agent-work-pulse' && previews.pulse.border === 'solid' && !previews.pulse.shadow &&
      previews.trace?.animation === 'local-agent-trace' && previews.trace.mask &&
      previews.static?.animation === 'none' && previews.static.border === 'solid', JSON.stringify(previews))
    await shot('agent-work-style-settings')

    // A working element of the app (outside the settings) follows the choice
    await js(`(() => { const pane = document.createElement('div'); pane.id = 'work-probe'; pane.dataset.agentWork = 'working'; document.body.append(pane) })()`)
    const probe = `document.getElementById('work-probe')`
    check('the app shows 안쪽 번짐 before anything is chosen', (await js(lookOf(probe))).animation === 'agent-work-breathe')
    await js(`document.querySelector('.agent-work-style[data-style="pulse"]').click()`)
    check('choosing 테두리 깜빡임 applies it to the app and keeps it', await until(`document.documentElement.dataset.agentWorkStyle === 'pulse' &&
      localStorage.getItem('agent-work-style') === 'pulse' && document.querySelector('.agent-work-style[aria-checked="true"]')?.dataset.style === 'pulse'`) &&
      (await js(lookOf(probe))).animation === 'agent-work-pulse')
    const stillPreviews = await js(`Object.fromEntries(${cards}.map(card => [card.dataset.style, ${lookOf("card.querySelector('.agent-work-preview')")}.animation]))`)
    check('the cards keep previewing their own look whatever the app uses', stillPreviews.glow === 'agent-work-breathe' && stillPreviews.trace === 'local-agent-trace', JSON.stringify(stillPreviews))
    await js(`document.querySelector('.agent-work-style[data-style="static"]').click()`)
    check('움직이지 않음 leaves the app with nothing moving', await until(`document.documentElement.dataset.agentWorkStyle === 'static'`) && (await js(lookOf(probe))).animation === 'none')
    await js(`document.querySelector('.agent-work-style[data-style="glow"]').click()`)
    await js(`${probe}.remove()`)
    const problems = await pageProblems(driver)
    check('no console errors', problems.length === 0, JSON.stringify(problems))
  } catch (error) {
    check(`no error: ${error.message}`, false)
  } finally {
    driver.close()
    finish()
  }
})()
