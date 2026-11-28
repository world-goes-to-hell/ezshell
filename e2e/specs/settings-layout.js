// The settings window's layout (2026-11-27 user request): the categories in a column on the left of a wider
// dialog, only the content scrolling; a narrow window picks the category from a list at the top instead.
// Run by e2e/run.js (fresh profile, no server needed).
const { createChecks, connect, unlock, pageProblems } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { send, js, until, shot } = driver
  await send('Page.bringToFront')
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await unlock(driver)

  const openSettings = async () => {
    const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 }
    await js(`document.activeElement && document.activeElement.blur()`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma })
    return until(`!!document.querySelector('.settings-tabs-list')`, 5000)
  }
  const selectTab = label => js(`[...document.querySelectorAll('.settings-tabs-list > [role=tab]')]
    .find(tab => tab.textContent.trim() === ${JSON.stringify(label)})
    .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
  const visible = selector => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && el.getClientRects().length > 0 })()`

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false })
  if (!await openSettings()) throw new Error('settings did not open')
  await until(`!document.querySelector('.settings-modal')?.getAnimations().length`, 3000)

  const wide = await js(`(() => {
    // Layout sizes: the opening animation scales the dialog for a moment
    const dialog = { width: document.querySelector('.settings-modal').offsetWidth }
    const list = document.querySelector('.settings-tabs-list').getBoundingClientRect()
    const listWidth = document.querySelector('.settings-tabs-list').offsetWidth
    const tabs = [...document.querySelectorAll('.settings-tabs-list > [role=tab]')]
    const rects = tabs.map(tab => tab.getBoundingClientRect())
    const content = document.querySelector('.settings-tabs > .settings-tab-content:not([hidden])').getBoundingClientRect()
    return {
      width: dialog.width, listWidth, viewport: innerWidth, count: tabs.length,
      column: rects.every(rect => Math.abs(rect.left - rects[0].left) < 1) && rects.every((rect, i) => i === 0 || rect.top >= rects[i - 1].bottom - 1),
      labelsWhole: tabs.every(tab => tab.scrollWidth <= tab.clientWidth),
      contentRight: content.left >= list.right - 1,
      orientation: document.querySelector('.settings-tabs-list').getAttribute('aria-orientation')
    }
  })()`)
  check('the wide dialog is 980px with a 180px column of the eight categories, each name whole',
    wide.width === 980 && wide.listWidth === 180 && wide.count === 8 && wide.column && wide.labelsWhole && wide.contentRight, JSON.stringify(wide))
  check('the column is a vertical tab list and the narrow list is hidden', wide.orientation === 'vertical' && !(await js(visible('.settings-category-picker'))))
  await shot('settings-layout-wide')

  // Only the content scrolls: the column stays where it is (a lower window, so a long category overflows)
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 620, deviceScaleFactor: 1, mobile: false })
  let scrolled = null
  for (const label of ['원격 접속', '개발 도구', '백업', '터미널']) {
    await selectTab(label)
    await new Promise(resolve => setTimeout(resolve, 600))
    scrolled = await js(`(() => {
      // The category's own scroller (.settings-content), or the content box
      const tab = document.querySelector('.settings-tabs > .settings-tab-content:not([hidden])')
      const content = tab.querySelector('.settings-content') ?? tab
      if (content.scrollHeight <= content.clientHeight) return null
      const before = document.querySelector('.settings-tabs-list').getBoundingClientRect().top
      content.scrollTop = content.scrollHeight
      return { label: ${JSON.stringify(label)}, moved: content.scrollTop > 0, listStays: document.querySelector('.settings-tabs-list').getBoundingClientRect().top === before }
    })()`)
    if (scrolled) break
  }
  check('a long category scrolls on its own while the column stays', !!scrolled && scrolled.moved && scrolled.listStays, JSON.stringify(scrolled))
  await selectTab('키보드 단축키')
  check('the chosen category is marked in the column', await until(`document.querySelector('.settings-tabs-list [data-state=active]')?.textContent.trim() === '키보드 단축키'`, 3000))

  // A narrow window: the list at the top shows the category and picks another
  await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 760, deviceScaleFactor: 1, mobile: false })
  check('a narrow dialog hides the column and shows the list with the current category', await until(`
    !${visible('.settings-tabs-list')} && ${visible('.settings-category-picker')} &&
    document.querySelector('.settings-category-picker select').value === 'shortcuts'`, 3000))
  check('the content takes the dialog’s whole width', await js(`(() => {
    const dialog = document.querySelector('.settings-modal').getBoundingClientRect()
    const content = document.querySelector('.settings-tabs > .settings-tab-content:not([hidden])').getBoundingClientRect()
    return content.left - dialog.left < 2 && dialog.right - content.right < 2
  })()`))
  await js(`(() => { const select = document.querySelector('.settings-category-picker select'); select.value = 'terminal'; select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  check('picking from the list opens that category', await until(`
    document.querySelector('.settings-tabs > .settings-tab-content:not([hidden]) .settings-section-title')?.textContent.includes('글꼴 크기')`, 3000))
  await shot('settings-layout-narrow')

  await send('Emulation.clearDeviceMetricsOverride')
  const problems = await pageProblems(driver)
  check('no console errors', problems.length === 0, problems.join(' | '))
  finish()
})().catch(error => { console.error(error); process.exit(1) })
