// A browser tab takes the name of the page it shows (its <title>), the host when the page has none.
const http = require('node:http')
const { connect, createChecks, selectThemeTab, SET, unlock } = require('../support/driver')

const { check, finish } = createChecks()

async function run() {
  const longTitle = '길게 표시되는 브라우저 페이지 제목 '.repeat(8) + '제목 끝'
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (request.url.startsWith('/untitled')) {
      response.end('<meta charset=utf-8><p>제목 없음</p>')
      return
    }
    const title = request.url === '/long' ? longTitle : '검토 화면 — 첫 페이지'
    response.end(`<meta charset=utf-8><title>${title}</title><p>본문</p>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const host = new URL(origin).host
  const main = await connect()
  try {
    await unlock(main)
    const active = `document.querySelector('.terminal-tab.active[data-tab-id^="browser:"]')`
    async function openBrowserTab() {
      const previous = await main.js(`${active}?.dataset.tabId ?? null`)
      const plus = `[...document.querySelectorAll('.new-tab-btn')].find(button => button.offsetParent)`
      if (!(await main.until(`!!${plus}`))) throw new Error('no plus button')
      await main.click(...await main.center(plus))
      const item = `[...document.querySelectorAll('.new-tab-menu-item')].find(item => item.textContent.trim() === '브라우저 열기')`
      if (!(await main.until(`!!${item}`))) throw new Error('the plus menu has no browser item')
      await main.click(...await main.center(item))
      if (!(await main.until(`${active}?.dataset.tabId && ${active}.dataset.tabId !== ${JSON.stringify(previous)}`))) {
        throw new Error('the browser tab did not open')
      }
      return main.js(`${active}.dataset.tabId`)
    }
    const stateOf = id => `window.electronAPI.browserReviewState(${JSON.stringify(id)})`
    const control = (id, selector) => `document.querySelector('[data-browser-tab-id="${id}"]')?.querySelector(${JSON.stringify(selector)})`
    const closeTab = id => main.js(`document.querySelector('.terminal-tab[data-tab-id="${id}"] .tab-close').click()`)
    const navigate = (id, address) => main.js(`window.electronAPI.browserReviewAction(${JSON.stringify(id)}, { type: 'navigate', address: ${JSON.stringify(address)} })`)
    const id = await openBrowserTab()
    const tabText = `(document.querySelector('.terminal-tab[data-tab-id="${id}"]')?.textContent ?? '')`

    check('a new browser tab starts with the default name', await main.until(`${tabText}.includes('브라우저')`))

    await navigate(id, origin + '/')
    check('the tab takes the page title', await main.until(`${tabText}.includes('검토 화면 — 첫 페이지')`, 10000))

    const titleState = `window.electronAPI.browserReviewState(${JSON.stringify(id)}).then(state => state.title)`
    check('main reports the title with the tab state',
      await main.until(`${titleState}.then(title => title === '검토 화면 — 첫 페이지')`), await main.js(titleState))

    await navigate(id, origin + '/untitled')
    check('a page without a title shows its host', await main.until(`${tabText}.includes(${JSON.stringify(host)}) && !${tabText}.includes('첫 페이지')`, 10000))

    await main.js(`window.electronAPI.browserReviewAction(${JSON.stringify(id)}, { type: 'back' })`)
    check('going back shows the earlier page title again', await main.until(`${tabText}.includes('첫 페이지')`, 10000))

    const regularTab = id => `document.querySelector('.terminal-tab[data-tab-id="${id}"]')`
    const tabLabel = `${regularTab(id)}?.querySelector('[data-tab-label]')`
    const hasWidth = (tab, width) => `Math.abs((${tab}?.getBoundingClientRect().width ?? 0) - ${width}) < 2`
    await navigate(id, origin + '/long')
    check('a long page title is clipped within the default 240 px browser tab', await main.until(`
      ${tabLabel}?.textContent === ${JSON.stringify(longTitle)} && ${hasWidth(regularTab(id), 240)} &&
      ${tabLabel}.scrollWidth > ${tabLabel}.clientWidth && getComputedStyle(${tabLabel}).textOverflow === 'ellipsis'
    `))
    await main.move(...await main.center(tabLabel))
    check('hover shows the full title', await main.until(`document.querySelector('.browser-tab-title-tooltip.is-visible')?.textContent === ${JSON.stringify(longTitle)}`))
    await main.move(10, 10)

    await main.js(`document.querySelector('.title-bar-btn[title="설정"]').click()`)
    await selectThemeTab(main, '브라우저 탭')
    const widthSetting = `document.querySelector('#browser-tab-width')`
    await main.until(`!!${widthSetting}`)
    await main.js(`${widthSetting}.focus()`)
    const home = { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }
    await main.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...home })
    await main.send('Input.dispatchKeyEvent', { type: 'keyUp', ...home })
    check('changing the maximum width applies to the open tab and is saved', await main.until(`
      ${widthSetting}?.value === '120' && ${hasWidth(regularTab(id), 120)} &&
      JSON.parse(localStorage.getItem('ui-store')).state.browserTabMaxWidth === 120
    `))
    await main.js(`document.querySelector('.settings-modal .modal-close-btn').click()`)
    await main.until(`!document.querySelector('.settings-modal')`)

    // The folded sidebar opened by hovering slides over the tab: the page (a native view above the
    // app) narrows to give way instead of covering it (reported 2026-11-20)
    const page = await connect(target => target.url.startsWith(origin))
    try {
      const pageWidth = () => page.js('window.innerWidth')
      const fullWidth = await pageWidth()
      await main.js(`document.querySelector('.sidebar-toggle').click()`)
      await main.until(`!!document.querySelector('.sidebar.rail:not(.peek-open)')`)
      await new Promise(r => setTimeout(r, 400))
      const foldedWidth = await pageWidth()
      await main.move(...await main.center(`document.querySelector('[data-peek-target="sessions"]')`))
      await main.until(`!!document.querySelector('.sidebar.rail.peek-open') && document.querySelector('.sidebar-panel').offsetWidth >= 270`)
      // The panel may still be sliding open: read its edge again with the page width
      const panelEdge = () => main.js(`document.querySelector('.sidebar-panel').getBoundingClientRect().right`)
      const viewLeft = await main.js(`document.querySelector('[data-browser-tab-id="${id}"] .browser-review-viewport').getBoundingClientRect().left`)
      let panelRight = await panelEdge()
      let peekWidth = await pageWidth()
      for (let i = 0; i < 20 && Math.abs(peekWidth - (foldedWidth - (panelRight - viewLeft))) > 2; i++) {
        await new Promise(r => setTimeout(r, 150))
        panelRight = await panelEdge()
        peekWidth = await pageWidth()
      }
      check('the opened sidebar narrows the page to the part it leaves uncovered',
        Math.abs(peekWidth - (foldedWidth - (panelRight - viewLeft))) <= 2, JSON.stringify({ fullWidth, foldedWidth, peekWidth, panelRight, viewLeft }))
      await main.move(900, 500)
      await main.until(`!!document.querySelector('.sidebar.rail:not(.peek-open)')`)
      let backWidth = await pageWidth()
      for (let i = 0; i < 20 && backWidth !== foldedWidth; i++) {
        await new Promise(r => setTimeout(r, 150))
        backWidth = await pageWidth()
      }
      check('folding it again gives the page its width back', backWidth === foldedWidth, JSON.stringify({ foldedWidth, backWidth }))
      await main.js(`document.querySelector('.sidebar-toggle')?.click()`)
    } finally {
      page.close()
    }

    // The page's developer tools, in a window of their own
    const button = `document.querySelector('[data-browser-tab-id="${id}"] .browser-review-devtools')`
    const devToolsOpen = `window.electronAPI.browserReviewState(${JSON.stringify(id)}).then(state => state.devToolsOpen)`
    const devToolsTargets = async () => {
      try { return (await (await fetch(process.env.E2E_CDP + '/json')).json()).filter(t => t.url.startsWith('devtools://')).length } catch { return -1 }
    }
    check('the toolbar has a developer tools button', await main.js(`!!${button} && !${button}.disabled && ${button}.getAttribute('aria-pressed') === 'false'`))
    if (process.env.EZSHELL_TEST_HIDDEN_WINDOWS === '1') {
      await main.js(`${button}.click()`)
      check('the hidden test app never opens a detached developer tools window',
        !await main.js(devToolsOpen) && await devToolsTargets() === 0)
      await closeTab(id)
    } else {
      await main.js(`${button}.click()`)
      check('it opens the page\'s developer tools and shows as pressed', await main.until(`${devToolsOpen}.then(open => open && ${button}.getAttribute('aria-pressed') === 'true')`, 10000))
      check('in a window of their own', await (async () => { for (let i = 0; i < 30; i++) { if (await devToolsTargets() > 0) return true; await new Promise(r => setTimeout(r, 300)) } return false })())
      await main.js(`${button}.click()`)
      check('pressing it again closes them', await main.until(`${devToolsOpen}.then(open => !open && ${button}.getAttribute('aria-pressed') === 'false')`, 10000))

      // CDP key events do not reach before-input-event, so the test uses the toolbar.
      await main.js(`${button}.click()`)
      await main.until(devToolsOpen, 10000)
      await closeTab(id)
      check('closing the tab closes its developer tools window', await (async () => { for (let i = 0; i < 30; i++) { if (await devToolsTargets() === 0) return true; await new Promise(r => setTimeout(r, 300)) } return false })())
    }

    const savedUrl = origin + '/?view=demo#section'
    const savedId = await openBrowserTab()
    const star = id => control(id, '.browser-review-bookmark')
    const listButton = id => control(id, '.browser-review-bookmarks-toggle')
    const entry = id => control(id, '.browser-review-bookmark-open')
    const toggleList = async id => main.click(...await main.center(listButton(id)))
    const loaded = id => `${stateOf(id)}.then(state => state?.url === ${JSON.stringify(savedUrl)} && !state.loading && !!state.title)`
    check('an empty tab cannot bookmark a page', await main.until(`${star(savedId)}?.disabled === true`))
    await navigate(savedId, savedUrl)
    await main.until(`${star(savedId)}?.disabled === false && ${loaded(savedId)}`)
    await main.js(`(${SET})(${control(savedId, 'input[aria-label="웹 주소"]')}, 'https://unsaved.example')`)
    await main.click(...await main.center(star(savedId)))
    check('starring saves the loaded page while the address is being edited', await main.until(`${star(savedId)}?.getAttribute('aria-pressed') === 'true'`))

    const otherId = await openBrowserTab()
    await main.until(`!!${listButton(otherId)}`)
    await toggleList(otherId)
    check('a new browser tab shares the saved title and exact URL', await main.until(`
      ${entry(otherId)}?.textContent.includes('검토 화면 — 첫 페이지') && ${entry(otherId)}?.title === ${JSON.stringify(savedUrl)}
    `))
    await main.click(...await main.center(entry(otherId)))
    check('clicking a bookmark loads it in the current tab and marks the star', await main.until(`
      ${star(otherId)}?.getAttribute('aria-pressed') === 'true' && !${entry(otherId)} && ${loaded(otherId)}
    `))
    await closeTab(otherId)
    await closeTab(savedId)
    await main.send('Page.reload')
    await unlock(main)
    const restoredId = await openBrowserTab()
    await main.until(`!!${listButton(restoredId)}`)
    await toggleList(restoredId)
    check('bookmarks survive a renderer reload', await main.until(`${entry(restoredId)}?.title === ${JSON.stringify(savedUrl)}`))
    const remove = control(restoredId, '.browser-review-bookmark-remove')
    await main.click(...await main.center(remove))
    check('the remove button deletes the bookmark without opening its page', await main.until(`
      ${control(restoredId, '.browser-review-bookmarks p')}?.textContent.includes('저장된 즐겨찾기가 없습니다') &&
      ${stateOf(restoredId)}.then(state => state?.url === '')
    `))
    await navigate(restoredId, origin + '/long')
    check('the chosen maximum browser tab width survives a reload', await main.until(`
      ${regularTab(restoredId)}?.querySelector('[data-tab-label]').textContent === ${JSON.stringify(longTitle)} && ${hasWidth(regularTab(restoredId), 120)}
    `))
    await openBrowserTab()
    await main.js(`(() => {
      const tab = ${regularTab(restoredId)}
      const dt = new DataTransfer()
      tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      window.browserWidthTestDrag = { tab, dt }
    })()`)
    await main.js(`(() => {
      const area = document.querySelector('.terminal-area')
      const rect = area.getBoundingClientRect()
      area.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.browserWidthTestDrag.dt,
        clientX: rect.right - 15, clientY: rect.top + rect.height / 2 }))
    })()`)
    await main.until(`!!document.querySelector('.drop-zone-right.active')`)
    await main.js(`window.browserWidthTestDrag.tab.dispatchEvent(new DragEvent('dragend', { bubbles: true }))`)
    const splitTab = `document.querySelector('.split-pane-tab-item[data-tab-id="${restoredId}"]')`
    check('the browser tab honors the same width in a split', await main.until(`
      ${hasWidth(splitTab, 120)} && ${splitTab}?.title === ${JSON.stringify(longTitle)}
    `))
  } finally {
    server.close()
    main.close()
  }
}

run().then(finish, error => { console.error(error); process.exit(1) })
