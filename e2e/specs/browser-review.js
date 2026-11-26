const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { connect, createChecks, openLocalAgent, pages, SET, sleep, unlock } = require('../support/driver')

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
    if (request.url.startsWith('/login')) {
      const action = request.url.includes('foreign') ? 'https://other.example/login' : '/login'
      response.end(`<meta charset=utf-8><form action="${action}" method="post" onsubmit="event.preventDefault(); document.body.dataset.submitted = 'yes'">
        <input id="username" type="email" autocomplete="username">
        <input id="password" type="password" autocomplete="current-password">
        <button>로그인</button>
      </form>`)
      return
    }
    const metadata = request.url.startsWith('/next') ? '' : `<script>
      document.querySelector('#age-table').__vueParentComponent = { type: { __name: 'AgeTable', __file: 'src/components/AgeTable.vue' } }
    </script>`
    response.end(`<meta charset=utf-8><section id="age-table">
      <button id="save-button" class="age-row highlight" onclick="document.body.dataset.clicked = 1">${label}</button>
    </section><a id="next" href="/next">다음</a> <a id="blank" href="/opened" target="_blank">새 창으로</a>${metadata}`)
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
    await openLocalAgent(main, 'codex', profile)
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
    const tools = `${root}.querySelector('.browser-review-tools-toggle')`
    const tool = `${root}.querySelector('.browser-review-tool-toggle')`
    const compose = `${root}.querySelector('.browser-review-compose')`
    const recipient = `${compose}.querySelector('.browser-review-agent')`
    const projectChoice = `${compose}.querySelector('.browser-review-project')`
    const editor = `${compose}.querySelector('textarea')`
    const sendRequest = `${compose}.querySelector('.browser-review-send')`
    const previews = `[...${compose}.querySelectorAll('.browser-review-attachments img')].map(img => img.naturalWidth).join(',')`
    const pasteScreenshot = () => browser.js(`(() => {
      const data = new DataTransfer()
      data.items.add(new File([], 'screenshot.png', { type: 'image/png' }))
      ${editor}.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    })()`)
    const history = root => `${root}.querySelector('.browser-review-history')`
    const rows = `${history(root)}.querySelectorAll('[data-request-id]')`
    const requestStatus = row => `${row}.querySelector('.browser-review-history-status').dataset.status`
    const fillRequest = text => browser.js(`(() => {
      const draft = ${editor}
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(draft, ${JSON.stringify(text)})
      draft.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    const fullViewport = `Math.abs(${root}.querySelector('.browser-review-viewport').clientWidth - ${root}.clientWidth) <= 1`
    check('browser controls open in the main tab strip beside the local terminal',
      await browser.until(`!!${root} && !!document.querySelector('.terminal-tab[data-tab-id^="local:"]')`)
      && !(await pages()).some(target => target.url.includes('browserReviewMode=')))
    check('a new browser fills the available width and offers only an icon for tools', await browser.until(`
      ${fullViewport} && !${compose} && !${tool} &&
      ${tools}.textContent.trim() === '' && ${tools}.hasAttribute('aria-label') && ${tools}.getAttribute('aria-expanded') === 'false'
    `))
    check('the address bar rejects privileged schemes', await browser.js(`window.electronAPI.browserReviewAction(${JSON.stringify(id)}, {
      type: 'navigate', address: 'file:///C:/Windows/'
    }).then(result => !result.success)`))

    const chromeRoot = path.join(profile, 'browser-import-local', 'Google', 'Chrome', 'User Data')
    const bookmarkUrl = origin + '/imported-bookmark'
    const historyUrl = origin + '/imported-history'
    const workProfile = path.join(chromeRoot, 'Profile 1')
    const bookmark = { type: 'url', name: '업무 링크', url: bookmarkUrl }
    fs.writeFileSync(path.join(workProfile, 'Bookmarks'), JSON.stringify({ roots: {
      bookmark_bar: { type: 'folder', name: '북마크바', children: [
        { type: 'folder', name: '업무 묶음', children: [
          { type: 'folder', name: '시스템', children: [bookmark, bookmark, { type: 'url', name: '차단된 링크', url: 'javascript:alert(1)' }] },
        ] },
        bookmark,
      ] },
      other: { type: 'folder', name: '기타 북마크', children: [] },
    } }))
    const historyFile = path.join(workProfile, 'History')
    const historyDb = new DatabaseSync(historyFile)
    const visitedAt = BigInt(Date.now() + 11_644_473_600_000) * 1000n
    historyDb.exec('PRAGMA journal_mode = TRUNCATE; CREATE TABLE urls (url TEXT, title TEXT, last_visit_time INTEGER, hidden INTEGER, visit_count INTEGER)')
    const addVisit = historyDb.prepare('INSERT INTO urls VALUES (?, ?, ?, ?, 1)')
    addVisit.run(historyUrl, '업무 방문 기록', visitedAt, 0)
    addVisit.run(origin + '/hidden', '숨겨진 방문 기록', visitedAt, 1)
    historyDb.exec('BEGIN EXCLUSIVE')
    try {
      const savedPages = `${root}.querySelector('.browser-review-bookmarks')`
      const savedButton = label => `[...${savedPages}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`
      const folderButtons = `[...${savedPages}.querySelectorAll('.browser-bookmark-folder')]`
      const folderButton = title => `${folderButtons}.find(button => button.querySelector('span')?.textContent === ${JSON.stringify(title)})`
      const openFolder = title => main.js(`${folderButton(title)}.click()`)
      const bookmarkRows = `${savedPages}.querySelectorAll('.browser-bookmark-row[data-kind="page"]')`
      const checkBox = label => `${savedPages}.querySelector('input[aria-label="${label}"]')`
      const searchBookmarks = value => main.js(`(${SET})(${savedPages}.querySelector('input[type=search]'), ${JSON.stringify(value)})`)
      const importer = "document.querySelector('.browser-data-import')"
      const importButton = label => `[...${importer}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`
      const openImport = async () => {
        await main.js(`${savedButton('가져오기')}.click()`)
        if (!await main.until(`!!${importer}?.querySelector('.browser-data-profile select')`)) throw new Error('the browser importer did not detect fixture profiles')
        await main.js(`(() => {
          const select = ${importer}.querySelector('.browser-data-profile select')
          select.value = [...select.options].find(option => option.textContent === '업무').value
          select.dispatchEvent(new Event('change', { bubbles: true }))
        })()`)
      }
      await main.js(`${root}.querySelector('.browser-review-bookmarks-toggle').click()`)
      await openImport()
      await main.js(`${importButton('가져오기')}.click()`)
      check('selecting a profile imports bookmarks and committed history while the source holds a SQLite lock', await main.until(`
        ${importer}.querySelector('.browser-data-result')?.textContent === '즐겨찾기 2개 추가 · 방문 기록 1개 추가'
      `))
      await main.js(`${importButton('완료')}.click()`)
      check('the source folders retain their order at the root', await main.until(`
        ${folderButtons}.map(button => button.querySelector('span')?.textContent).join('/') === '북마크바/기타 북마크' &&
        !${savedPages}.textContent.includes('업무 링크')
      `))
      await openFolder('기타 북마크')
      check('an empty folder can be expanded in place', await main.until(`${folderButton('기타 북마크')}.textContent.includes('빈 폴더')`))
      await openFolder('북마크바')
      await openFolder('업무 묶음')
      await openFolder('시스템')
      check('multiple folders can stay open with nested bookmarks on the same list', await main.until(`
        ${folderButtons}.map(button => button.querySelector('span')?.textContent).join('/') === '북마크바/업무 묶음/시스템/기타 북마크' &&
        ${folderButtons}.every(button => button.getAttribute('aria-expanded') === 'true') && ${bookmarkRows}.length === 2 &&
        [...${bookmarkRows}].every(row => row.querySelector('.browser-review-bookmark-open small').textContent === ${JSON.stringify(bookmarkUrl)}) &&
        !${savedPages}.textContent.includes('차단된 링크')
      `))
      await main.shot('browser-review-bookmark-folders')
      const toggleBookmarks = `${root}.querySelector('.browser-review-bookmarks-toggle')`
      await main.js(`${toggleBookmarks}.click()`)
      await main.until(`!${savedPages}`)
      await main.js(`${toggleBookmarks}.click()`)
      check('reopening saved pages restores expanded folders in the tab', await main.until(`
        ${folderButton('시스템')}?.getAttribute('aria-expanded') === 'true' && ${bookmarkRows}.length === 2
      `))
      await openFolder('북마크바')
      await searchBookmarks('업무 링크')
      check('search finds matching pages inside collapsed folders and shows their folder path', await main.until(`
        ${bookmarkRows}.length === 2 && ${folderButton('시스템')}?.getAttribute('aria-expanded') === 'true' && !${folderButton('기타 북마크')}
      `))
      await main.js(`${savedButton('선택')}.click()`)
      await main.js(`${checkBox('검색 결과 전체 선택')}.click()`)
      check('selecting all matches selects both links without the folders that only show their paths', await main.until(`
        !${checkBox('북마크바 폴더 선택')} && ${savedButton('선택 삭제 (2)')}?.disabled === false
      `))
      await main.js(`${savedButton('선택 취소')}.click()`)
      await searchBookmarks('')
      check('clearing search restores the previous open and closed folders', await main.until(`
        ${folderButton('북마크바')}?.getAttribute('aria-expanded') === 'false' && ${folderButton('기타 북마크')}?.getAttribute('aria-expanded') === 'true'
      `))
      await main.js(`${savedButton('방문 기록')}.click()`)
      check('hidden visits are excluded from the imported history view', await main.until(`
        ${savedPages}.querySelectorAll('li').length === 1 && ${savedPages}.querySelector('li').textContent.includes('업무 방문 기록') &&
        ${savedPages}.querySelector('time')?.dateTime === ${JSON.stringify(new Date(Number(visitedAt / 1000n) - 11_644_473_600_000).toISOString())}
      `))
      await openImport()
      await main.js(`${importButton('가져오기')}.click()`)
      check('a second import does not add duplicates', await main.until(`
        ${importer}.querySelector('.browser-data-result')?.textContent === '즐겨찾기 0개 추가 · 방문 기록 0개 추가'
      `))
      await main.js(`${importButton('비밀번호 가져오기')}.click()`)
      const passwordPanel = "document.querySelector('.browser-login-dialog:not(.browser-data-import)')"
      check('password export opens with the same source profile selected', await main.until(`
        !${importer} && ${passwordPanel}?.querySelector('.browser-login-import select')?.selectedOptions[0]?.textContent === 'Google Chrome · 업무'
      `))
      await main.js(`[...${passwordPanel}.querySelectorAll('button')].find(button => button.textContent.trim() === '닫기').click()`)
      await main.js(`${savedButton('즐겨찾기')}.click()`)
      await openFolder('북마크바')
      await main.js(`${savedButton('선택')}.click()`)
      await main.js(`${checkBox('북마크바 폴더 선택')}.click()`)
      await main.js(`${bookmarkRows}[1].querySelector('input[type=checkbox]').click()`)
      await main.js(`${checkBox('기타 북마크 폴더 선택')}.click()`)
      check('unchecking a link keeps its containing folder and updates the partial selection', await main.until(`
        ${checkBox('북마크바 폴더 선택')}.indeterminate && ${savedButton('선택 삭제 (4)')}?.disabled === false
      `))
      await main.shot('browser-review-bookmarks-bulk')
      const confirmDelete = `document.querySelector('.confirm-dialog .btn-danger')`
      await main.js(`${savedButton('선택 삭제 (4)')}.click()`)
      check('bulk deletion asks for confirmation with page and folder counts', await main.until(`
        !!${confirmDelete} && document.querySelector('.confirm-dialog-message')?.textContent.includes('즐겨찾기 1개 및 폴더 3개')
      `))
      await main.js(`document.querySelector('.confirm-dialog .btn-secondary').click()`)
      check('cancel keeps the bookmarks and checkboxes', await main.until(`!${confirmDelete} && ${bookmarkRows}.length === 2 && !!${savedButton('선택 삭제 (4)')}`))
      await main.js(`${savedButton('선택 삭제 (4)')}.click()`)
      await main.until(`!!${confirmDelete}`)
      await main.js(`${confirmDelete}.click()`)
      check('bulk deletion keeps the unchecked copy of a URL and removes selected folders', await main.until(`
        ${bookmarkRows}.length === 1 && !!${folderButton('북마크바')} && !${folderButton('업무 묶음')} && !${folderButton('기타 북마크')}
      `))
      await openFolder('북마크바')
      await main.js(`${savedButton('선택')}.click()`)
      await main.js(`${checkBox('전체 선택')}.click()`)
      await main.js(`${savedButton('선택 삭제 (2)')}.click()`)
      await main.until(`!!${confirmDelete}`)
      await main.js(`${confirmDelete}.click()`)
      check('select all can clear every bookmark including links in collapsed folders', await main.until(`
        ${savedPages}.textContent.includes('저장된 즐겨찾기가 없습니다.') && !${savedPages}.querySelector('li')
      `) && fs.readFileSync(path.join(workProfile, 'Bookmarks'), 'utf8').includes('업무 링크'))
      await main.js(`${savedButton('방문 기록')}.click()`)
      await main.js(`${savedPages}.querySelector('.browser-review-bookmark-open').click()`)
      check('an imported visit opens normally in the browser tab', await main.until(`${state}.then(state => state.url === ${JSON.stringify(historyUrl)} && !state.loading)`))
    } finally { historyDb.close() }

    await browser.until(`!!document.querySelector('[aria-label="웹 주소"]')`)
    await browser.js(`(${SET})(document.querySelector('[aria-label="웹 주소"]'), ${JSON.stringify(origin + '/?private=token')})`)
    await browser.js(`document.querySelector('.browser-review-address button').click()`)
    page = await connect(target => target.url.startsWith(origin))
    check('web content has no ezShell API', await page.js(`typeof window.electronAPI === 'undefined' && typeof require === 'undefined'`))
    await browser.until(`${state}.then(state => state.url && !state.loading)`)
    const pageWidth = await page.js('window.innerWidth')
    await browser.js(`${tools}.click()`)
    check('the tools icon opens a list with the picker accordion folded', await browser.until(`
      ${tools}.getAttribute('aria-expanded') === 'true' &&
      ${tool}?.getAttribute('aria-expanded') === 'false' && !${compose}
    `) && await page.until(`window.innerWidth < ${pageWidth}`))
    await browser.js(`${tool}.click()`)
    const pick = `${root}.querySelector('.browser-review-pick')`
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
    check('a working agent remains selectable', await browser.until(`[...${recipient}.options].some(
      option => option.value === 'codex-1' && option.textContent.includes('작업 중'))`))
    // 2026-11-26 user request: the project first, then its agents (names like backend alone were ambiguous)
    check('the only project is chosen first, named with its parent folder, and its only agent with it', await browser.until(`
      ${projectChoice}?.selectedOptions[0]?.textContent === ${JSON.stringify(`${path.basename(path.dirname(profile))} / ${path.basename(profile)}`)}
      && ${recipient}.value === 'codex-1'
    `), await browser.js(`(${projectChoice}?.selectedOptions[0]?.textContent ?? 'no project select') + ' / ' + ${recipient}.value`))
    await browser.js(`(() => {
      const select = ${recipient}
      select.value = 'codex-1'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await fillRequest('버튼 문구를 변경해 주세요.')
    await browser.js(`${compose}.querySelector('.browser-review-add-image').click()`)
    check('the file picker adds multiple image previews', await browser.until(`${previews} === '36,52'`))
    await browser.js(`${compose}.querySelector('.browser-review-attachments button').click()`)
    check('removing a file leaves the other preview', await browser.until(`${previews} === '52'`))
    await pasteScreenshot()
    check('pasting a screenshot adds it beside the file and keeps the request text', await browser.until(`
      ${previews} === '52,1' && ${editor}.value === '버튼 문구를 변경해 주세요.'
    `))
    await browser.js(`${tools}.click()`)
    check('closing tools gives the full width back to the live page', await browser.until(`${fullViewport} && !${compose}`)
      && await page.until(`window.innerWidth === ${pageWidth}`))
    await browser.js(`${tools}.click()`)
    await browser.until(`!!${tool} && ${tool}.getAttribute('aria-expanded') === 'false'`)
    await browser.js(`${tool}.click()`)
    check('reopening the picker keeps the selected element, draft text and images', await browser.until(`
      ${root}.querySelector('.browser-review-selection code')?.textContent === '#save-button' &&
      ${editor}.value === '버튼 문구를 변경해 주세요.' && ${recipient}.value === 'codex-1' &&
      ${previews} === '52,1' && ${pick}.getAttribute('aria-pressed') === 'false'
    `))
    await browser.until(`${compose}.getAnimations().every(animation => animation.playState !== 'running')`)
    await browser.shot('browser-review-attachments')
    check('the browser rejects unattached image references', await browser.js(`window.electronAPI.browserReviewAction(${JSON.stringify(id)}, {
      type: 'send', agentId: 'codex-1', text: '잘못된 첨부', selectionId: ${JSON.stringify(selectionId)},
      imageIds: ${JSON.stringify(['C:\\not-attached.png'])}
    }).then(result => !result.success)`))
    await browser.js(`${sendRequest}.click()`)
    check('the request is sent from the UI', await browser.until(`document.querySelector('.browser-review-feedback')?.textContent.includes('codex-1')`))
    check('the sent request clears the draft and shows the attachment count and status in history', await browser.until(`
      ${previews} === '' && ${editor}.value === '' &&
      ${rows}.length === 1 && ${rows}[0].textContent.includes('codex-1') &&
      ${rows}[0].querySelector('summary').textContent.includes('버튼 문구를 변경해 주세요.') &&
      ${rows}[0].querySelector('summary').textContent.includes('이미지 2장') &&
      ${requestStatus(`${rows}[0]`)} === 'waiting'
    `))
    async function mcp(name, args = {}, agent = 'codex-1') {
      const requestPath = path.join(profile, agent + '-mcp-request')
      const responsePath = path.join(profile, agent + '-mcp-response')
      fs.writeFileSync(requestPath, JSON.stringify({ name, arguments: args }))
      for (let attempt = 0; attempt < 40 && !fs.existsSync(responsePath); attempt++) await sleep(150)
      const response = JSON.parse(fs.readFileSync(responsePath, 'utf8'))
      fs.unlinkSync(responsePath)
      if (response.error || response.isError) throw new Error(response.error || response.content[0].text)
      return JSON.parse(response.content[0].text)
    }
    const { messages } = await mcp('read_inbox')
    check('the connected agent can read the exact element and the request in its MCP inbox',
      messages.length === 1 && messages[0].from === 'user' && messages[0].to === 'codex-1'
      && messages[0].text.includes('#save-button') && messages[0].text.includes('버튼 문구를 변경해 주세요.')
      && messages[0].text.includes('reply_to_message') && messages[0].text.includes('completed')
      && !messages[0].text.includes('private=token'))
    const imageFiles = messages[0].text.split('\n').filter(line => path.isAbsolute(line) && line.endsWith('.png'))
    check('the MCP request references only the two attached and readable images', imageFiles.length === 2
      && imageFiles.every(file => fs.existsSync(file))
      && imageFiles.map(file => fs.readFileSync(file).readUInt32BE(16)).join(',') === '52,1')
    const data = JSON.parse(messages[0].text.slice(messages[0].text.indexOf('\n{') + 1))
    check('the request carries Vue component and file, first 30 characters and exact class tokens',
      data.component === 'AgeTable' && data.componentFile === 'src/components/AgeTable.vue'
      && data.text === Array.from(label).slice(0, 30).join('')
      && JSON.stringify(data.classes) === JSON.stringify(['age-row', 'highlight']))
    const first = `${history(root)}.querySelector('[data-request-id="${messages[0].id}"]')`
    check('reading the request updates its history entry', await browser.until(`${requestStatus(first)} === 'seen'`))
    await fillRequest('버튼 간격을 넓혀 주세요.')
    await browser.js(`document.querySelector('.browser-review-send').click()`)
    check('the newest request appears first with its own status', await browser.until(`
      ${rows}.length === 2 && ${rows}[0].textContent.includes('버튼 간격을 넓혀 주세요.') &&
      ${requestStatus(`${rows}[0]`)} === 'waiting'
    `))
    await mcp('reply_to_message', { message_id: messages[0].id, text: '요청 내용을 확인했습니다.' })
    check('a reply without a status counts as a reply only', await browser.until(`${requestStatus(first)} === 'replied'`))
    await mcp('reply_to_message', { message_id: messages[0].id, status: 'deferred', text: '문구 확정을 기다리고 있습니다.' })
    await browser.js(`${first}.querySelector('summary').click()`)
    check('a deferred reply updates only the matching request and shows its reason', await browser.until(`
      ${requestStatus(first)} === 'deferred' && ${requestStatus(`${rows}[0]`)} === 'waiting' &&
      ${first}.querySelector('details').open && ${first}.querySelector('.browser-review-history-reply').textContent.includes('문구 확정을 기다리고 있습니다.')
    `))
    await mcp('reply_to_message', { message_id: messages[0].id, status: 'completed', text: '버튼 문구를 변경했습니다.' })
    check('a later completed reply updates the same entry and keeps it expanded', await browser.until(`
      ${rows}.length === 2 && ${requestStatus(first)} === 'completed' && ${first}.querySelector('details').open &&
      ${first}.querySelector('.browser-review-history-reply').textContent.includes('버튼 문구를 변경했습니다.')
    `))
    await page.click(...await page.center(`document.querySelector('#next')`))
    check('navigation clears the selected element', await browser.until(`${state}.then(state => state.url.endsWith('/next') && !state.selection)`))
    check('navigation keeps sent requests and strips the original URL query from history', await browser.js(`
      ${rows}.length === 2 && ${requestStatus(first)} === 'completed' && !${first}.textContent.includes('private=token')
    `))
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
    await pasteScreenshot()
    check('a screenshot can be sent with the selection and an empty text field', await browser.until(`
      ${previews} === '1' && ${editor}.value === '' && !${sendRequest}.disabled
    `))
    await browser.js(`${sendRequest}.click()`)
    check('an image-only request gets a readable description in history', await browser.until(`
      ${rows}.length === 3 && ${rows}[0].textContent.includes('첨부 이미지를 참고해 선택한 요소를 확인해 주세요.') &&
      ${rows}[0].textContent.includes('이미지 1장')
    `))
    await browser.js(`${pick}.click()`)
    await browser.until(`${pick}.getAttribute('aria-pressed') === 'true'`)
    await browser.js(`${tool}.click()`)
    check('folding the picker stops intercepting page clicks', await browser.until(`
      !${compose} && ${state}.then(state => !state.picking)
    `))
    await page.click(...await page.center(`document.querySelector('#save-button')`))
    check('the original button works again after the picker is folded', await page.until(`document.body.dataset.clicked === '1'`))
    const back = `document.querySelector('[aria-label="뒤로"]')`
    await browser.until(`!${back}.disabled`)
    await browser.js(`${back}.click()`)
    check('browser history works across page links', await browser.until(`${state}.then(state => state.url.includes('private=token') && !state.loading)`))
    const otherId = await openBrowserTab()
    const otherRoot = `document.querySelector('[data-browser-tab-id="${otherId}"]')`
    check('a second browser tab starts with its own address', otherId !== id && await browser.until(`
      ${otherRoot}?.querySelector('[aria-label="웹 주소"]').value === ''
      && ${otherRoot}?.querySelector('.browser-review-tools-toggle').getAttribute('aria-expanded') === 'false'
      && getComputedStyle(${root}).visibility === 'hidden'
    `))
    await browser.js(`${otherRoot}.querySelector('.browser-review-tools-toggle').click()`)
    await browser.js(`${otherRoot}.querySelector('.browser-review-tool-toggle').click()`)
    check('another browser tab can see the same request history', await browser.until(`
      ${history(otherRoot)}?.querySelector('[data-status="completed"]') &&
      ${history(otherRoot)}.querySelectorAll('[data-request-id]').length === 3
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

    const address = origin + '/plain/' + 'wrapped'.repeat(22)
    await main.js(`document.querySelector('.terminal-tab[data-tab-id^="local:"]').click()`)
    fs.writeFileSync(path.join(profile, 'codex-1-draft'), address)
    const row = `[...document.querySelectorAll('.local-terminal-host .xterm-rows > div')]
      .find(line => line.textContent.includes(${JSON.stringify(origin)}))`
    if (!(await main.until(`!!${row}`, 8000))) throw new Error('the terminal did not draw the test URL')
    const point = await main.js(`(() => {
      const r = ${row}.getBoundingClientRect()
      return [r.left + 56, r.top + r.height / 2]
    })()`)
    await main.click(...point)
    const linkMenu = `[...document.querySelectorAll('.terminal-menu-item')].find(item => item.textContent.trim() === 'ezShell 브라우저에서 열기')`
    check('a wrapped text URL opens the web link menu', await main.until(`!!${linkMenu}`, 5000))
    await main.pick('ezShell 브라우저에서 열기')
    check('the native browser navigates to the full terminal URL', await main.until(`(() => {
      const tab = document.querySelector('.terminal-tab.active[data-tab-id^="browser:"]')
      return tab && window.electronAPI.browserReviewState(tab.dataset.tabId).then(state => state.url === ${JSON.stringify(address)} && !state.loading)
    })()`))

    const loginModal = "document.querySelector('.browser-login-dialog')"
    const loginTab = await openBrowserTab()
    const loginRoot = `document.querySelector('[data-browser-tab-id="${loginTab}"]')`
    async function navigateLogin(id, suffix = '') {
      const url = origin + '/login' + suffix
      await main.js(`window.electronAPI.browserReviewAction(${JSON.stringify(id)}, {type: 'navigate', address: ${JSON.stringify(url)}})`)
      await main.until(`window.electronAPI.browserReviewState(${JSON.stringify(id)}).then(state => state.url === ${JSON.stringify(url)} && !state.loading && state.loginOrigin)`)
      return connect(target => target.url === url)
    }
    const loginPage = await navigateLogin(loginTab)
    try {
      await loginPage.js("document.cookie = 'temporary_fixture=1; path=/; max-age=86400'")
      // 2026-11-26 user report: a login was forgotten after a restart. Logins stay unless turned off
      check('logins stay by default', await main.js(`window.electronAPI.browserReviewLogins(${JSON.stringify(loginTab)}, {type: 'list'})
        .then(result => result.rememberSession === true && result.sessionPersistent === true)`))
      const settings = `${loginRoot}.querySelector('.browser-review-logins')`
      await main.js(`${settings}.click()`)
      const modalButton = label => `[...${loginModal}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(label)})`
      await main.until(`!!${loginModal} && !${modalButton('이 사이트 계정 추가')}.disabled`)
      check('the login import and add account buttons have the same size and alignment', await main.js(`(() => {
        const a = ${modalButton('다른 브라우저에서 가져오기')}.getBoundingClientRect()
        const b = ${modalButton('이 사이트 계정 추가')}.getBoundingClientRect()
        return a.top === b.top && a.height === b.height && Math.abs(a.width - b.width) < 1
      })()`))
      await main.js(`${modalButton('이 사이트 계정 추가')}.click()`)
      await main.js(`(${SET})(${loginModal}.querySelector('.browser-login-form input:not([type=password])'), 'manual@example.test')`)
      await main.js(`(${SET})(${loginModal}.querySelector('input[type=password]'), 'only-a-test-password')`)
      await main.js(`${loginModal}.querySelector('form').requestSubmit()`)
      check('the browser can save an account and never returns its password to the app renderer', await main.until(`
        ${loginModal}.textContent.includes('manual@example.test') && window.electronAPI.browserReviewLogins(${JSON.stringify(loginTab)}, {type: 'list'}).then(result =>
          result.accounts.length === 1 && !JSON.stringify(result).includes('only-a-test-password')
        )
      `))
      fs.writeFileSync(path.join(profile, 'browser-login-import.csv'), `name,url,username,password\r\n` +
        `Fixture,${origin}/login,imported@example.test,"comma,quote""test"\r\n` +
        `Fixture,${origin}/login,manual@example.test,should-not-overwrite\r\n`)
      await main.js(`${modalButton('다른 브라우저에서 가져오기')}.click()`)
      const source = `${loginModal}.querySelector('.browser-login-import select')`
      const detected = await main.until(`[...${source}?.options ?? []].map(option => option.textContent).join(',') === 'Google Chrome · 개인,Google Chrome · 업무'`)
      check('guided import shows the installed browser and its profiles', detected)
      if (!detected) throw new Error('the fixture browser profiles were not listed')
      await main.js(`(() => {
        const select = ${source}
        select.value = [...select.options].find(option => option.textContent === 'Google Chrome · 업무').value
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      const startImport = () => main.js(`${modalButton('가져오기')}.click()`)
      const exportReady = `!${source} && ${loginModal}.querySelector('.browser-login-import').textContent.includes('chrome://password-manager/settings') &&
        ${loginModal}.querySelector('.browser-login-import').textContent.includes('파일 다운로드') &&
        ${modalButton('저장 경로 다시 복사')}?.disabled === false`
      const exportDestination = path.join(profile, 'browser-export-destination')
      await startImport()
      check('starting the import copies a destination for the browser export', await main.until(exportReady) && fs.existsSync(exportDestination))
      const canceledDestination = fs.readFileSync(exportDestination, 'utf8')
      const cancelImport = `${loginModal}.querySelector('.browser-login-import-actions').querySelector('button')`
      await main.js(`${cancelImport}.click()`)
      for (let attempt = 0; attempt < 20 && fs.existsSync(path.dirname(canceledDestination)); attempt++) await sleep(50)
      check('canceling removes the temporary destination and returns to profile selection',
        await main.until(`!!${source}`) && !fs.existsSync(path.dirname(canceledDestination)))
      await startImport()
      const launchFile = path.join(profile, 'browser-source-launch.json')
      if (!await main.until(exportReady)) throw new Error('the browser import did not start')
      const args = fs.existsSync(launchFile) ? JSON.parse(fs.readFileSync(launchFile, 'utf8')) : []
      const launchPage = args.at(-1) ?? ''
      check('the selected profile opens a local export guide Chrome can load at startup', args.includes('--profile-directory=Profile 1') &&
        launchPage.startsWith('data:text/html;charset=utf-8,') &&
        decodeURIComponent(launchPage).includes('<code>chrome://password-manager/settings</code>'))
      const sourceCsv = path.join(profile, 'browser-login-import.csv')
      const destination = fs.readFileSync(exportDestination, 'utf8')
      check('each import waits for its own export file', destination !== canceledDestination && !fs.existsSync(destination))
      fs.copyFileSync(sourceCsv, destination, fs.constants.COPYFILE_EXCL)
      check('saving the export imports it without opening a file picker', await main.until(`
        ${loginModal}.textContent.includes('imported@example.test') && ${loginModal}.textContent.includes('1개를 가져왔습니다.')
      `))
      check('the automatic import removes its temporary copy and preserves the existing CSV', !fs.existsSync(destination) && fs.existsSync(sourceCsv))
      await main.js(`${modalButton('다른 브라우저에서 가져오기')}.click()`)
      await main.until(`!!${source} && !${modalButton('CSV 파일 선택…')}?.disabled`)
      await main.js(`${modalButton('CSV 파일 선택…')}.click()`)
      check('a manually selected CSV can still be imported, skipping duplicates', await main.until(`
        ${loginModal}.textContent.includes('0개를 가져왔습니다.') && ${loginModal}.textContent.includes('2개 항목은 건너뛰었습니다.')
      `))
      const vault = fs.readFileSync(path.join(profile, 'browser-logins.json'), 'utf8')
      check('saved and imported passwords are encrypted on disk', !vault.includes('only-a-test-password') && !vault.includes('comma,quote') && !vault.includes('imported@example.test'))
      const account = `${loginModal}.querySelectorAll('.browser-login-list li')`
      const fill = `[...${account}].find(item => item.textContent.includes('imported@example.test'))?.querySelector('.btn-primary')`
      const fillReady = await main.until(`(() => { const button = ${fill}; return !!button && !button.disabled })()`)
      if (fillReady) await main.js(`${fill}.click()`)
      check('choosing Fill enters the selected account without submitting the page', fillReady && await main.until(`!${loginModal}`) && await loginPage.js(`
        document.querySelector('#username').value === 'imported@example.test' &&
        document.querySelector('#password').value === 'comma,quote"test' && !document.body.dataset.submitted
      `))
      await main.js(`${settings}.click()`)
      await main.until(`!!${loginModal} && !${loginModal}.querySelector('input[type=checkbox]').disabled`)
      await main.js(`${loginModal}.querySelector('input[type=checkbox]').click()`)
      check('login retention applies to new tabs', await main.until(`${loginModal}.textContent.includes('새 브라우저 탭부터')`))
      await main.js(`${modalButton('닫기')}.click()`)
      // The click turned retention off: the new tab browses apart from the kept logins
      const persistent = await openBrowserTab()
      const persistentPage = await navigateLogin(persistent, '?foreign=1')
      try {
        check('browsing with login retention turned off is separate from the kept logins',
          await persistentPage.js("!document.cookie.includes('temporary_fixture')") &&
          await main.js(`window.electronAPI.browserReviewLogins(${JSON.stringify(persistent)}, {type: 'list'}).then(result => result.sessionPersistent === false)`))
        check('the browser refuses to fill a form that submits to another origin', await main.js(`(async () => {
          const tab = ${JSON.stringify(persistent)}
          const { accounts } = await window.electronAPI.browserReviewLogins(tab, {type: 'list'})
          const account = accounts.find(row => row.username === 'imported@example.test')
          return !(await window.electronAPI.browserReviewLogins(tab, {type: 'fill', id: account.id, origin: account.origin})).success
        })()`) && await persistentPage.js("!document.querySelector('#password').value"))
      } finally { persistentPage.close() }
    } finally { loginPage.close() }

    // 2026-11-23 user report: a link opening a new window (target="_blank") did nothing. It opens in a new
    // browser tab of the app, as in a web browser
    const linkTab = await openBrowserTab()
    await main.js(`window.electronAPI.browserReviewAction(${JSON.stringify(linkTab)}, {type: 'navigate', address: ${JSON.stringify(origin + '/?blank=1')}})`)
    const linkPage = await connect(target => target.url === origin + '/?blank=1')
    try {
      await main.until(`window.electronAPI.browserReviewState(${JSON.stringify(linkTab)}).then(state => state.url && !state.loading)`)
      await linkPage.click(...await linkPage.center(`document.querySelector('#blank')`))
      check('a link opening a new window opens in a new browser tab of the app', await main.until(`(async () => {
        const tab = document.querySelector('.terminal-tab.active[data-tab-id^="browser:"]')?.dataset.tabId
        if (!tab || tab === ${JSON.stringify(linkTab)}) return false
        const state = await window.electronAPI.browserReviewState(tab)
        return state?.url === ${JSON.stringify(origin + '/opened')}
      })()`, 8000))
      check('the page it came from stays as it was', await main.js(`window.electronAPI.browserReviewState(${JSON.stringify(linkTab)}).then(state => state.url === ${JSON.stringify(origin + '/?blank=1')})`))
    } finally { linkPage.close() }

    // A page opened from a project (a run preset's 열기, a server's chip) offers that project first
    await main.js(`window.electronAPI.browserReviewOpenLink(${JSON.stringify(origin + '/?project=1')}, 'internal', { folder: ${JSON.stringify(profile)} })`)
    const preferredOf = `(async () => {
      const tab = document.querySelector('.terminal-tab.active[data-tab-id^="browser:"]')?.dataset.tabId
      const state = tab && await window.electronAPI.browserReviewState(tab)
      if (state?.url !== ${JSON.stringify(origin + '/?project=1')}) return ''
      return (await window.electronAPI.browserReviewProjects(tab))?.preferred ?? ''
    })()`
    await main.until(preferredOf, 8000)
    const preferred = await main.js(preferredOf)
    check('a tab opened from a project prefers that project in the element request',
      typeof preferred === 'string' && path.relative(preferred, profile) === '', String(preferred))

    // 2026-11-26 user request: the address bar suggests pages visited before and completes the address inline
    const suggestTab = await openBrowserTab()
    const suggestRoot = `document.querySelector('[data-browser-tab-id="${suggestTab}"]')`
    const addressInput = `${suggestRoot}.querySelector('.browser-review-address input')`
    const host = origin.replace(/^http:\/\//, '')
    await main.click(...await main.center(addressInput))
    await main.js(`${addressInput}.select()`)
    await main.type(host + '/op')
    check('typing completes a visited address inline, the added part selected, with the list below', await main.until(`(() => {
      const input = ${addressInput}
      return input.value === ${JSON.stringify(host + '/opened')} && input.selectionStart === ${host.length + 3}
        && input.selectionEnd === input.value.length && !!${suggestRoot}.querySelector('.browser-address-suggestions [role=option]')
    })()`), await main.js(`${addressInput}.value`))
    await main.enter()
    check('Enter opens the completed page', await main.until(`window.electronAPI.browserReviewState(${JSON.stringify(suggestTab)})
      .then(state => state.url === ${JSON.stringify(origin + '/opened')})`, 8000)
      && await main.until(`!${suggestRoot}.querySelector('.browser-address-suggestions')`))
    await main.click(...await main.center(addressInput))
    await main.js(`${addressInput}.select()`)
    await main.type('project')
    const projectRow = `[...${suggestRoot}.querySelectorAll('.browser-address-suggestions [role=option]')].find(row => row.textContent.includes('?project=1'))`
    check('a part of a visited address finds it in the list without completing it inline',
      await main.until(`!!${projectRow} && ${addressInput}.value === 'project'`))
    await main.click(...await main.center(projectRow))
    check('clicking a suggestion opens it', await main.until(`window.electronAPI.browserReviewState(${JSON.stringify(suggestTab)})
      .then(state => state.url === ${JSON.stringify(origin + '/?project=1')})`, 8000))

    const requestFolder = path.join(profile, 'new-review-project')
    fs.mkdirSync(requestFolder)
    const newUrl = origin + '/?new-session=1'
    await main.js(`window.electronAPI.browserReviewAction(${JSON.stringify(suggestTab)}, {
      type: 'navigate', address: ${JSON.stringify(newUrl)}
    })`)
    const newPage = await connect(target => target.url === newUrl)
    try {
      const newCompose = `${suggestRoot}.querySelector('.browser-review-compose')`
      await main.until(`window.electronAPI.browserReviewState(${JSON.stringify(suggestTab)}).then(state => !state.loading)`)
      await main.js(`${suggestRoot}.querySelector('.browser-review-tools-toggle').click()`)
      await main.until(`!!${suggestRoot}.querySelector('.browser-review-tool-toggle')`)
      await main.js(`${suggestRoot}.querySelector('.browser-review-tool-toggle').click()`)
      await main.until(`${newCompose}.querySelector('.browser-review-pick')?.getAttribute('aria-pressed') === 'true'`)
      await newPage.click(...await newPage.center("document.querySelector('#save-button')"))
      await main.until(`${newCompose}.querySelector('.browser-review-selection code')?.textContent === '#save-button'`)
      const newRecipient = `${newCompose}.querySelector('.browser-review-agent')`
      const sendNew = `${newCompose}.querySelector('.browser-review-send')`
      const newDraft = '새 Codex 세션에 요소 수정을 요청합니다.'
      check('the browser offers Claude Code and Codex alongside existing recipients', await main.js(`
        [...${newRecipient}.querySelectorAll('optgroup[label="새 세션에 요청"] option')].map(option => option.value).join(',') === 'new:claude,new:codex'
      `))
      await main.js(`(() => {
        const select = ${newRecipient}
        select.value = 'new:codex'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        const draft = ${newCompose}.querySelector('textarea')
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(draft, ${JSON.stringify(newDraft)})
        draft.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      await main.js(`${newCompose}.querySelector('.browser-review-add-image').click()`)
      await main.until(`${newCompose}.querySelectorAll('.browser-review-attachments img').length === 2 && !${sendNew}.disabled`)
      await main.js(`${sendNew}.click()`)
      const dialogLog = path.join(profile, 'test-agent-request-dialog')
      for (let attempt = 0; attempt < 40 && !fs.existsSync(dialogLog); attempt++) await sleep(150)
      const options = JSON.parse(fs.readFileSync(dialogLog, 'utf8'))
      check('the project prefills the folder picker and cancelling keeps the request and both images',
        options.defaultPath && path.relative(profile, options.defaultPath) === '' && await main.until(`
          !${sendNew}.disabled && ${newCompose}.querySelector('textarea').value === ${JSON.stringify(newDraft)} &&
          ${newCompose}.querySelectorAll('.browser-review-attachments img').length === 2
        `))

      fs.writeFileSync(path.join(profile, 'test-agent-request-folder'), requestFolder)
      await main.js(`${sendNew}.click()`)
      const newAgent = `window.electronAPI.agentMessagesSnapshot().then(({ agents }) => agents.find(agent =>
        agent.kind === 'codex' && agent.mcpConnected && agent.cwd === ${JSON.stringify(requestFolder)}))`
      check('the new Codex session gets its own tab', await main.until(`${newAgent}.then(agent => !!agent &&
        !!document.querySelector('.terminal-tab[data-tab-id="' + agent.shellId + '"]'))`, 8000))
      const { id: agentId } = await main.js(newAgent)
      const inbox = await mcp('read_inbox', {}, agentId)
      const message = inbox.messages[0]
      const files = message?.text.split('\n').filter(line => path.isAbsolute(line) && line.endsWith('.png'))
      check('the new Codex inbox receives one request with the selected element, text and attachments',
        inbox.messages.length === 1 && message.text.includes(newDraft) && message.text.includes('#save-button') &&
        files?.length === 2 && files.every(file => fs.existsSync(file)))
      check('the new session request also appears in browser review history', await main.until(`
        ${history(suggestRoot)}.querySelector('[data-request-id="${message.id}"]')?.textContent.includes(${JSON.stringify(newDraft)})
      `))
    } finally { newPage.close() }
  } finally {
    main.close()
    page?.close()
    server.close()
  }
}

run().then(finish).catch(error => { console.error(error); process.exit(1) })
