const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, pageProblems, SET, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const folder = path.join(process.env.E2E_PROFILE, 'shop-msa')
const other = path.join(process.env.E2E_PROFILE, 'another-project')
fs.mkdirSync(path.join(folder, 'backend'), { recursive: true })
fs.mkdirSync(other)
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Run Panel Test', '-c', 'user.email=run-panel@example.invalid', ...args],
  { cwd, stdio: 'pipe', windowsHide: true })
git(folder, 'init', '-b', 'main')
git(folder, 'commit', '--allow-empty', '-m', 'Create project')
const backend = path.join(folder, 'backend')
git(backend, 'init', '-b', 'feature/backend')
git(backend, 'commit', '--allow-empty', '-m', 'Create service')
fs.writeFileSync(path.join(folder, 'backend', 'service.cjs'), `
  const fs = require('node:fs')
  const http = require('node:http')
  const mode = process.argv[2]
  if (mode === 'crash') {
    const timer = setInterval(() => {
      if (!fs.existsSync('fail')) return
      clearInterval(timer)
      console.error('Fixture failure')
      process.exit(1)
    }, 50)
  } else {
    const server = http.createServer((_request, response) => response.end('OK'))
    server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + server.address().port + '/'))
  }
  if (mode === 'waiting') {
    const timer = setInterval(() => {
      if (!fs.existsSync('ready')) return
      clearInterval(timer)
      console.log('fixture healthy')
    }, 50)
  }
`)

;(async () => {
  const driver = await connect()
  const { js, until, click, center, send, enter, move, shot } = driver
  const quoted = JSON.stringify(folder)
  const list = `window.electronAPI.runPresetsList(${quoted})`
  const mainButton = kind => `document.querySelector('.workspace-runs-commands [data-run-action="${kind}"]')`
  const panel = `document.querySelector('.workspace-runs')`
  const row = id => `document.querySelector('[data-workspace-run="${id}"]')`
  const search = `document.querySelector('input[aria-label="실행 구성 검색"]')`
  const select = `document.querySelector('select[aria-label="실행 프로젝트"]')`
  const rows = `[...document.querySelectorAll('[data-workspace-run]')]`
  const confirm = `document.querySelector('.run-command-dialog .btn-primary')`
  const wait = async (condition, ms) => {
    if (!await until(condition, ms)) throw new Error(condition)
  }
  const key = async (key, code, virtualKey) => {
    const event = { key, code, windowsVirtualKeyCode: virtualKey }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }
  const setSearch = value => js(`(${SET})(${search}, ${JSON.stringify(value)})`)
  const choose = (select, value) => js(`(() => { const element = ${select}; element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  const ask = async () => {
    await wait(`!!${confirm} && !${confirm}.disabled`)
    await js(`${confirm}.click()`)
  }

  try {
    await unlock(driver)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([folder, other]))})
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    const presets = {}
    for (const name of ['infra', 'checkout-api', 'broken-api', 'auth', 'catalog', 'client', 'gateway', 'mail', 'orders', 'stock']) {
      const mode = name === 'broken-api' ? 'crash' : name === 'infra' ? 'waiting' : 'serve'
      const result = await js(`window.electronAPI.runPresetsSave(${quoted}, ${JSON.stringify({
        name, kind: 'custom', command: `node service.cjs ${mode}`, relative: 'backend'
      })})`)
      if (!result.preset) throw new Error(result.error)
      presets[name] = result.preset.id
    }
    const infra = presets.infra
    const checkout = presets['checkout-api']
    const broken = presets['broken-api']
    const order = {
      stages: [{ ids: [infra], gate: { kind: 'log', value: 'fixture healthy' } }, { ids: [checkout], gate: { kind: 'none' } }],
      timeoutSeconds: 4, onTimeout: 'pause', reverseStop: true, askDependencies: true
    }
    const configured = await js(`window.electronAPI.runStartOrderSave(${quoted}, ${JSON.stringify(order)}, ${JSON.stringify(Object.values(presets))})`)
    if (!configured.ok) throw new Error(configured.error)
    const savedBundle = await js(`window.electronAPI.runPresetBundleSave(${quoted}, {name: '결제 개발', presetIds: ['${infra}', '${checkout}']})`)
    if (!savedBundle.ok) throw new Error(savedBundle.error)
    const bundle = savedBundle.bundles.find(item => item.name === '결제 개발')

    await wait(`!!document.querySelector('.workspace-indicator')`)
    await js(`document.querySelector('.workspace-indicator').click()`)
    await js(`document.querySelector('#workspace-tab-run').click()`)
    await wait(`!!${select} && [...${select}.options].length >= 3`)
    await choose(select, folder)
    check('project chooser loads ten saved presets with the configured stages', await until(`${rows}.length === 10 &&
      ${row(infra)}?.cells[0].textContent === '1' && ${row(checkout)}?.cells[0].textContent === '2'`))
    check('a nested repository branch is shown and highlighted when different from the project branch', await until(`
      ${row(checkout)}?.cells[4].textContent === 'feature/backend' && ${row(checkout)}?.cells[4].dataset.different === 'true'`),
    JSON.stringify(await js(`[${row(checkout)}?.cells[4].textContent, ${row(checkout)}?.cells[4].dataset.different]`)))

    const bundleSelect = `document.querySelector('select[aria-label="실행 묶음"]')`
    await choose(bundleSelect, bundle.id)
    check('selecting a bundle shows its members', await until(`${rows}.length === 2 && !!${row(checkout)}`))
    await choose(bundleSelect, '')
    await setSearch('BACKEND checkout')
    check('search finds a configuration by name and folder and flattens the groups', await until(`
      ${rows}.length === 1 && !!${row(checkout)} && !document.querySelector('.workspace-runs-group')`))
    await js(`${search}.focus()`)
    await key('ArrowDown', 'ArrowDown', 40)
    check('down from the search focuses a matching row', await js(`document.activeElement === ${row(checkout)}`))
    await enter()
    check('Enter opens the shared row actions', await until(`
      !!document.querySelector('[role=menu]') && document.querySelector('[role=menu]').textContent.includes('실행 진단')`))
    await driver.pick('늘 보이기')
    check('pin changes are shown in the table', await until(`!!${row(checkout)}?.querySelector('[aria-label="고정됨"]')`))
    await js(`${search}.focus()`)
    await key('Escape', 'Escape', 27)
    check('Escape clears the filter', await until(`${rows}.length === 10 && ${search}.value === ''`))

    const onlySecondStage = `${row(checkout)}.parentElement.querySelector('[data-run-action="startStage"]')`
    await js(`${onlySecondStage}.click()`)
    await ask()
    check('running only the second stage leaves the predecessor idle', await until(`${row(checkout)}?.dataset.runStatus === 'running' &&
      ${row(infra)}?.dataset.runStatus === 'idle'`))
    const port = await js(`${row(checkout)}.cells[3].textContent.trim().slice(1)`)
    await setSearch(port)
    check('search uses the reported port', await until(`${rows}.length === 1 && !!${row(checkout)}`))
    await setSearch('')
    await js(`${row(checkout)}.focus()`)
    const beforeRestart = await js(`(async () => (await ${list}).states['${checkout}'].startedAt)()`)
    await key('r', 'KeyR', 82)
    check('R restarts the focused service', await until(`(async () => {
      const state = (await ${list}).states['${checkout}']
      return state.status === 'running' && state.startedAt > ${beforeRestart}
    })()`))
    await js(`${row(checkout)}.focus()`)
    await key(' ', 'Space', 32)
    check('Space stops the focused service', await until(`${row(checkout)}?.dataset.runStatus === 'stopped'`))
    await key('l', 'KeyL', 76)
    check('L opens the service log', await until(`!!document.querySelector('.local-terminal-host .xterm-helper-textarea')`))
    await choose(select, '')
    check('automatic selection follows the local terminal inside the registered project', await until(`
      ${select}.options[0].textContent.includes('shop-msa') && ${rows}.length === 10`))

    await js(`${row(broken)}.focus()`)
    const before = await js(`${rows}.map(row => row.dataset.workspaceRun)`)
    await key(' ', 'Space', 32)
    await ask()
    await js(`${row(broken)}.focus()`)
    await move(...await center(row(broken)))
    fs.writeFileSync(path.join(backend, 'fail'), '')
    check('a crash updates status while the pointer and keyboard focus hold the order', await until(`
      ${row(broken)}?.dataset.runStatus === 'crashed' && JSON.stringify(${rows}.map(row => row.dataset.workspaceRun)) === ${JSON.stringify(JSON.stringify(before))}`))
    await move(...await center(search))
    check('pointer leaving still holds the order while a row has focus', await js(`${rows}[0] !== ${row(broken)}`))
    await js(`${search}.focus()`)
    check('leaving the table moves the crashed service to the top', await until(`${rows}[0] === ${row(broken)}`))
    await js(`${panel}.querySelector('button[data-run-status="crashed"]').click()`)
    check('the crash counter filters the table', await until(`${rows}.length === 1 && ${rows}[0] === ${row(broken)}`))
    await js(`${search}.focus()`)
    await key('Escape', 'Escape', 27)

    await js(`${mainButton('startAll')}.click()`)
    await ask()
    check('batch progress reports the current stage and displays the queued stage', await until(`
      ${panel}.querySelector('progress')?.max === 2 && ${panel}.querySelector('progress')?.value === 1 &&
      ${row(checkout)}?.textContent.includes('앞 단계 대기')`))
    await shot('local-run-panel')
    check('a paused batch exposes log, skip, cancel and retry', await until(`
      [...document.querySelectorAll('.workspace-runs-recovery button')].map(button => button.textContent.trim()).join('|') ===
        '로그 보기|건너뛰고 계속|취소|다시 시도'`))
    fs.writeFileSync(path.join(backend, 'ready'), '')
    await js(`${panel}.querySelector('[data-run-action="retryOrder"]').click()`)
    check('retry continues to the second stage after the first gate is satisfied', await until(`
      ${row(checkout)}?.dataset.runStatus === 'running' && !${panel}.querySelector('progress')`))
    await js(`${mainButton('stopAll')}.click()`)
    check('all stop stops the active services', await until(`${row(infra)}?.dataset.runStatus === 'stopped' &&
      ${row(checkout)}?.dataset.runStatus === 'stopped'`))
    await choose(select, other)
    check('changing projects selects that project’s own configuration list', await until(`${panel}.textContent.includes('등록된 실행 구성이 없습니다.')`))
    const problems = await pageProblems(driver)
    check('no page errors', !problems.length, JSON.stringify(problems))
  } finally {
    await js(`window.electronAPI.runPresetStopAll(${quoted})`).catch(() => {})
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
