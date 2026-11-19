const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { connect, createChecks, openLocalProject, pages, SET, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const profile = process.env.E2E_PROFILE

async function run() {
  if (process.env.E2E_APP || process.platform !== 'win32') {
    console.log('SKIP browser review needs the Windows agent fixture')
    return
  }
  const label = '1990년생 (37세) 다음 단계에 표시될 긴 항목 텍스트입니다.'
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const metadata = request.url.startsWith('/next') ? '' : `<script>
      document.querySelector('#age-table').__vueParentComponent = { type: { __name: 'AgeTable', __file: 'src/components/AgeTable.vue' } }
    </script>`
    response.end(`<meta charset=utf-8><section id="age-table">
      <button id="save-button" class="age-row highlight" onclick="document.body.dataset.clicked = 1">${label}</button>
    </section><a id="next" href="/next">다음</a>${metadata}`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const main = await connect()
  let page
  try {
    await unlock(main)
    check('the plus menu is available before starting an agent', await main.js(`!!document.querySelector('.new-tab-btn')`))
    await main.js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([profile]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    await openLocalProject(main)
    await main.until(`!!document.querySelector('#local-project-agent')`)
    await main.js(`(() => {
      const select = document.querySelector('#local-project-agent')
      select.value = 'codex'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      document.querySelector('.local-project-dialog button[type=submit]').click()
    })()`)
    if (!(await main.until(`window.electronAPI.agentMessagesSnapshot().then(state => state.agents.some(agent => agent.mcpConnected))`))) {
      throw new Error('the Codex fixture did not connect')
    }
    async function openBrowserTab() {
      const active = `document.querySelector('.terminal-tab.active[data-tab-id^="browser:"]')`
      const previousId = await main.js(`${active}?.dataset.tabId ?? null`)
      const plus = await main.center(`[...document.querySelectorAll('.new-tab-btn')].find(button => button.offsetParent)`)
      await main.click(...plus)
      const menu = `[...document.querySelectorAll('.new-tab-menu-item')].find(item => item.textContent.trim() === '브라우저 열기')`
      if (!(await main.until(`!!${menu}`))) throw new Error('the plus menu has no browser item')
      await main.click(...await main.center(menu))
      if (!(await main.until(`${active}?.dataset.tabId && ${active}.dataset.tabId !== ${JSON.stringify(previousId)}`))) {
        throw new Error('the browser tab did not open')
      }
      return main.js(`${active}.dataset.tabId`)
    }
    const id = await openBrowserTab()
    const state = `window.electronAPI.browserReviewState(${JSON.stringify(id)})`
    const browser = main
    const root = `document.querySelector('[data-browser-tab-id="${id}"]')`
    check('browser controls open in the main tab strip beside the local terminal',
      await browser.until(`!!${root} && !!document.querySelector('.terminal-tab[data-tab-id^="local:"]')`)
      && !(await pages()).some(target => target.url.includes('browserReviewMode=')))
    check('the address bar rejects privileged schemes', await browser.js(`window.electronAPI.browserReviewAction(${JSON.stringify(id)}, {
      type: 'navigate', address: 'file:///C:/Windows/'
    }).then(result => !result.success)`))
    await browser.until(`!!document.querySelector('[aria-label="웹 주소"]')`)
    await browser.js(`(${SET})(document.querySelector('[aria-label="웹 주소"]'), ${JSON.stringify(origin + '/?private=token')})`)
    await browser.js(`document.querySelector('.browser-review-address button').click()`)
    page = await connect(target => target.url.startsWith(origin))
    check('web content has no ezShell API', await page.js(`typeof window.electronAPI === 'undefined' && typeof require === 'undefined'`))
    const pick = `document.querySelector('.browser-review-pick')`
    await browser.until(`!${pick}.disabled`)
    await browser.js(`${pick}.click()`)
    await browser.until(`${pick}.getAttribute('aria-pressed') === 'true'`)
    await page.click(...await page.center(`document.querySelector('#save-button')`))
    if (!(await browser.until(`document.querySelector('.browser-review-selection code')?.textContent === '#save-button'`))) {
      throw new Error('the page button was not selected')
    }
    check('picking captures the selector without clicking the site button', await page.js(`!document.body.dataset.clicked`))
    check('the selection shows the Vue component and classes before sending', await browser.js(`
      ${root}.querySelector('.browser-review-component').textContent === 'AgeTable'
      && ${root}.querySelector('.browser-review-component').title === 'src/components/AgeTable.vue'
      && ${root}.querySelector('.browser-review-selection').textContent.includes('age-row highlight')
    `))
    check('selection alone sends no mail', await main.js(`window.electronAPI.agentMessagesSnapshot().then(state => state.messages.length === 0)`))
    const selectionId = await browser.js(`${state}.then(state => state.selection.id)`)
    await main.js(`(async () => {
      const { agents } = await window.electronAPI.agentMessagesSnapshot()
      const { shellId } = agents.find(agent => agent.id === 'codex-1')
      window.electronAPI.localShellWrite(shellId, 'fixture task')
      window.electronAPI.localShellWrite(shellId, '\\r')
    })()`)
    fs.writeFileSync(path.join(profile, 'codex-1-program-status'), 'state=working:app=codex')
    check('a working agent remains selectable', await browser.until(`[...document.querySelectorAll('#browser-review-agent option')].some(
      option => option.value === 'codex-1' && option.textContent.includes('작업 중'))`))
    await browser.js(`(() => {
      const select = document.querySelector('#browser-review-agent')
      select.value = 'codex-1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const draft = document.querySelector('#browser-review-draft')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(draft, '버튼 문구를 변경해 주세요.')
      draft.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await browser.js(`document.querySelector('.browser-review-send').click()`)
    check('the request is sent from the UI', await browser.until(`document.querySelector('.browser-review-feedback')?.textContent.includes('codex-1')`))
    const requestPath = path.join(profile, 'codex-1-mcp-request')
    const responsePath = path.join(profile, 'codex-1-mcp-response')
    fs.writeFileSync(requestPath, JSON.stringify({ name: 'read_inbox', arguments: {} }))
    for (let attempt = 0; attempt < 40 && !fs.existsSync(responsePath); attempt++) await sleep(150)
    const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'))
    const { messages } = JSON.parse(response.content[0].text)
    check('the connected agent can read the exact element and the request in its MCP inbox',
      messages.length === 1 && messages[0].from === 'user' && messages[0].to === 'codex-1'
      && messages[0].text.includes('#save-button') && messages[0].text.includes('버튼 문구를 변경해 주세요.')
      && !messages[0].text.includes('private=token'))
    const data = JSON.parse(messages[0].text.slice(messages[0].text.indexOf('\n{') + 1))
    check('the request carries Vue component and file, first 30 characters and exact class tokens',
      data.component === 'AgeTable' && data.componentFile === 'src/components/AgeTable.vue'
      && data.text === Array.from(label).slice(0, 30).join('')
      && JSON.stringify(data.classes) === JSON.stringify(['age-row', 'highlight']))
    await page.click(...await page.center(`document.querySelector('#next')`))
    check('navigation clears the selected element', await browser.until(`${state}.then(state => state.url.endsWith('/next') && !state.selection)`))
    check('the browser rejects a request against the previous page', await browser.js(`window.electronAPI.browserReviewAction(${JSON.stringify(id)}, {
      type: 'send', agentId: 'codex-1', text: 'stale', selectionId: ${JSON.stringify(selectionId)}
    }).then(result => !result.success)`))
    await browser.until(`!${pick}.disabled`)
    await browser.js(`${pick}.click()`)
    await browser.until(`${pick}.getAttribute('aria-pressed') === 'true'`)
    await page.click(...await page.center(`document.querySelector('#save-button')`))
    check('pages without Vue metadata still return the text and classes', await browser.until(`${state}.then(state =>
      state.selection?.text.startsWith('1990년생') && state.selection?.classes.includes('age-row') && !state.selection.component
    )`))
    const back = `document.querySelector('[aria-label="뒤로"]')`
    await browser.until(`!${back}.disabled`)
    await browser.js(`${back}.click()`)
    check('browser history works across page links', await browser.until(`${state}.then(state => state.url.includes('private=token') && !state.loading)`))
    const otherId = await openBrowserTab()
    const otherRoot = `document.querySelector('[data-browser-tab-id="${otherId}"]')`
    check('a second browser tab starts with its own address', otherId !== id && await browser.until(`
      ${otherRoot}?.querySelector('[aria-label="웹 주소"]').value === ''
      && getComputedStyle(${root}).visibility === 'hidden'
    `))
    await browser.js(`document.querySelector('[data-tab-id="${otherId}"] .tab-close').click()`)
    await browser.until(`!document.querySelector('[data-tab-id="${otherId}"]')`)
    await browser.js(`document.querySelector('[data-tab-id="${id}"]').click()`)
    check('returning to the first browser tab preserves its page', await browser.until(`
      ${root}.querySelector('[aria-label="웹 주소"]').value.includes('private=token')
      && getComputedStyle(${root}).visibility === 'visible'
    `))
    await browser.js(`document.querySelector('[data-tab-id="${id}"] .tab-close').click()`)
    check('closing the tab releases its browser session', await browser.until(`${state}.then(state => state === null)`))
  } finally {
    main.close()
    page?.close()
    server.close()
  }
}

run().then(finish).catch(error => { console.error(error); process.exit(1) })
