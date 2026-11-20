// A browser tab takes the name of the page it shows (its <title>), the host when the page has none.
const http = require('node:http')
const { connect, createChecks, unlock } = require('../support/driver')

const { check, finish } = createChecks()

async function run() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (request.url.startsWith('/untitled')) {
      response.end('<meta charset=utf-8><p>제목 없음</p>')
      return
    }
    response.end('<meta charset=utf-8><title>검토 화면 — 첫 페이지</title><p>본문</p>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const host = new URL(origin).host
  const main = await connect()
  try {
    await unlock(main)
    const plus = `[...document.querySelectorAll('.new-tab-btn')].find(button => button.offsetParent)`
    if (!(await main.until(`!!${plus}`))) throw new Error('no plus button')
    await main.click(...await main.center(plus))
    const item = `[...document.querySelectorAll('.new-tab-menu-item')].find(item => item.textContent.trim() === '브라우저 열기')`
    if (!(await main.until(`!!${item}`))) throw new Error('the plus menu has no browser item')
    await main.click(...await main.center(item))
    const active = `document.querySelector('.terminal-tab.active[data-tab-id^="browser:"]')`
    if (!(await main.until(`!!${active}`))) throw new Error('the browser tab did not open')
    const id = await main.js(`${active}.dataset.tabId`)
    const tabText = `(document.querySelector('.terminal-tab[data-tab-id="${id}"]')?.textContent ?? '')`
    const navigate = address => main.js(`window.electronAPI.browserReviewAction(${JSON.stringify(id)}, { type: 'navigate', address: ${JSON.stringify(address)} })`)

    check('a new browser tab starts with the default name', await main.until(`${tabText}.includes('브라우저')`))

    await navigate(origin + '/')
    check('the tab takes the page title', await main.until(`${tabText}.includes('검토 화면 — 첫 페이지')`, 10000))

    const titleState = `window.electronAPI.browserReviewState(${JSON.stringify(id)}).then(state => state.title)`
    check('main reports the title with the tab state',
      await main.until(`${titleState}.then(title => title === '검토 화면 — 첫 페이지')`), await main.js(titleState))

    await navigate(origin + '/untitled')
    check('a page without a title shows its host', await main.until(`${tabText}.includes(${JSON.stringify(host)}) && !${tabText}.includes('첫 페이지')`, 10000))

    await main.js(`window.electronAPI.browserReviewAction(${JSON.stringify(id)}, { type: 'back' })`)
    check('going back shows the earlier page title again', await main.until(`${tabText}.includes('첫 페이지')`, 10000))

    // The page's developer tools, in a window of their own
    const button = `document.querySelector('[data-browser-tab-id="${id}"] .browser-review-devtools')`
    const devToolsOpen = `window.electronAPI.browserReviewState(${JSON.stringify(id)}).then(state => state.devToolsOpen)`
    const devToolsTargets = async () => {
      try { return (await (await fetch(process.env.E2E_CDP + '/json')).json()).filter(t => t.url.startsWith('devtools://')).length } catch { return -1 }
    }
    check('the toolbar has a developer tools button', await main.js(`!!${button} && !${button}.disabled && ${button}.getAttribute('aria-pressed') === 'false'`))
    await main.js(`${button}.click()`)
    check('it opens the page\'s developer tools and shows as pressed', await main.until(`${devToolsOpen}.then(open => open && ${button}.getAttribute('aria-pressed') === 'true')`, 10000))
    check('in a window of their own', await (async () => { for (let i = 0; i < 30; i++) { if (await devToolsTargets() > 0) return true; await new Promise(r => setTimeout(r, 300)) } return false })())
    await main.js(`${button}.click()`)
    check('pressing it again closes them', await main.until(`${devToolsOpen}.then(open => !open && ${button}.getAttribute('aria-pressed') === 'false')`, 10000))

    // F12 / Ctrl+Shift+I in the page are not checked here: keys sent over CDP never reach before-input-event
    // (tried with a bare Electron script: CDP keys are not seen, sendInputEvent like real keys is seen as keyDown:F12)

    // Closing the tab takes its developer tools window along
    await main.js(`${button}.click()`)
    await main.until(devToolsOpen, 10000)
    await main.js(`document.querySelector('.terminal-tab[data-tab-id="${id}"] .tab-close').click()`)
    check('closing the tab closes its developer tools window', await (async () => { for (let i = 0; i < 30; i++) { if (await devToolsTargets() === 0) return true; await new Promise(r => setTimeout(r, 300)) } return false })())
  } finally {
    server.close()
    main.close()
  }
}

run().then(finish, error => { console.error(error); process.exit(1) })
