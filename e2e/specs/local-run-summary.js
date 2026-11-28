const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, pageProblems, SET, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const folder = path.join(process.env.E2E_PROFILE, 'run-summary')
const quoted = JSON.stringify(folder)
const names = Array.from({ length: 9 }, (_, index) => `서비스 ${index + 1}`)

fs.mkdirSync(folder, { recursive: true })
fs.writeFileSync(path.join(folder, 'service.cjs'), `
if (process.argv[2] === 'fail') {
  console.error('ERROR fixture startup failed')
  process.exit(1)
} else {
  console.log('fixture ready in 1 ms')
  setInterval(() => {}, 1000)
}
`)

;(async () => {
  const driver = await connect()
  const { js, click, center, send, until, shot } = driver
  const section = `document.querySelector('.run-presets')`
  const summary = `document.querySelector('.run-presets-summary')`
  const row = id => `document.querySelector('.run-presets .run-preset[data-run-preset="${id}"]')`
  const rowCount = `document.querySelectorAll('.run-presets .run-preset').length`
  const command = `document.querySelector('.run-command-dialog .btn-primary')`
  const count = filter => `document.querySelector('[data-run-filter="${filter}"]')`
  const panel = `document.querySelector('.workspace-panel')`
  const threshold = `document.querySelector('.settings-run-threshold input')`
  const menuItem = label => `[...document.querySelectorAll('.run-context-menu [role=menuitem]')]
    .find(item => item.textContent.trim() === ${JSON.stringify(label)})`

  async function requireState(expression, timeout = 12000) {
    if (!await until(expression, timeout)) throw new Error(expression)
  }

  async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
    const params = { key, code, windowsVirtualKeyCode, modifiers }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }

  async function clickElement(expression, button) {
    await requireState(`!!${expression}`)
    const spot = await center(expression)
    if (!spot) throw new Error(`missing element: ${expression}`)
    await click(...spot, button)
  }

  async function openSubmenu(label) {
    const item = menuItem(label)
    await requireState(`!!${item}`)
    await js(`${item}.focus()`)
    await key('ArrowRight', 'ArrowRight', 39)
    await requireState(`${item}?.getAttribute('aria-expanded') === 'true'`)
  }

  async function pick(label) {
    const item = menuItem(label)
    await requireState(`!!${item} && ${item}.getAttribute('aria-disabled') !== 'true'`)
    await js(`${item}.focus()`)
    await key('Enter', 'Enter', 13)
    await requireState(`!document.querySelector('.run-context-menu')`)
  }

  async function choosePreset(name, action) {
    await clickElement(summary, 'right')
    await openSubmenu('구성 고르기')
    await openSubmenu(name)
    await pick(action)
  }

  async function confirmCommand() {
    await requireState(`${command} && !${command}.disabled`)
    await js(`${command}.click()`)
    await requireState(`!document.querySelector('.run-command-dialog')`)
  }

  async function setThreshold(value) {
    await js('document.activeElement?.blur()')
    await key(',', 'Comma', 188, process.platform === 'darwin' ? 4 : 2)
    await requireState(`!!document.querySelector('.settings-modal')`)
    await js(`[...document.querySelectorAll('.settings-tabs-list > [role=tab]')]
      .find(tab => tab.textContent.trim() === '개발 도구')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
    await requireState(`!!${threshold}`)
    await js(`(() => { const field = ${threshold}; field.focus(); (${SET})(field, '${value}'); field.blur() })()`)
    await js(`document.querySelector('.settings-modal [aria-label="Close"]').click()`)
    await requireState(`!document.querySelector('.settings-modal')`)
  }

  try {
    await unlock(driver)
    const ids = []
    for (const [index, name] of names.entries()) {
      const result = await js(`window.electronAPI.runPresetsSave(${quoted}, ${JSON.stringify({
        name, kind: 'custom', command: `node service.cjs ${index === 1 ? 'fail' : 'serve'}`, relative: '.', notify: false,
      })})`)
      if (!result.preset) throw new Error(result.error)
      ids.push(result.preset.id)
    }
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([folder]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    await requireState(`!!${summary}`)
    check('nine presets show a single summary with all status counts at the default of eight', await js(`
      ${summary}.textContent.includes('실행 9') && ${rowCount} === 0 &&
      ['running', 'crashed', 'unresponsive'].every(status => document.querySelector('[data-run-filter="' + status + '"]').textContent === '0')`))
    await js(`document.querySelector('.sidebar').style.setProperty('--sidebar-width', '160px')`)
    check('a narrow sidebar keeps the summary title, counts and panel button in view', await until(`(() => {
      const head = ${summary}
      const bounds = head.getBoundingClientRect()
      return head.clientWidth < 150 && [...head.children].every(child => {
        const rect = child.getBoundingClientRect()
        return rect.width > 0 && child.scrollWidth <= child.clientWidth && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
      })
    })()`))
    await js(`document.querySelector('.sidebar').style.removeProperty('--sidebar-width')`)

    await setThreshold(9)
    check('a threshold equal to the count keeps the full list and its existing controls', await until(`
      !${summary} && ${rowCount} === 9 && !!${section}.querySelector('.run-bundle-go')`))
    await setThreshold(8)
    await requireState(`!!${summary} && ${rowCount} === 0`)

    const panelButton = `${summary}.querySelector('.run-summary-panel')`
    await js(`${panelButton}.focus()`)
    await key('F10', 'F10', 121, 8)
    await requireState(`!!${menuItem('모두 실행')}`)
    await key('Escape', 'Escape', 27)
    await requireState(`!document.querySelector('.run-context-menu')`)
    check('Escape returns keyboard focus to the button that opened the context menu', await until(`document.activeElement === ${panelButton}`))
    await key('F10', 'F10', 121, 8)
    check('the restored focus can reopen the menu without a pointer', await until(`!!${menuItem('모두 실행')}`))
    await key('Escape', 'Escape', 27)
    await requireState(`!document.querySelector('.run-context-menu')`)

    await clickElement(summary, 'right')
    await requireState(`!!${menuItem('모두 실행')}`)
    check('summary context includes project-wide actions', await js(`
      ['모두 실행', '모두 중지', '묶음 만들기…', '기동 순서…', '실행 구성 추가', '실행 패널 열기',
        '실행 중 모두 중지', '종료한 것 모두 다시 실행'].every(label =>
        [...document.querySelectorAll('.run-context-menu [role=menuitem]')].some(item => item.textContent.trim() === label))`))
    await openSubmenu('구성 고르기')
    check('the picker groups visible and hidden presets under their actual stages', await js(`
      [...document.querySelectorAll('.run-context-stage')].map(group => group.querySelectorAll('.run-context-trigger')[1]?.textContent.trim())
        .join(',') === ${JSON.stringify(names.join(','))}`))
    await openSubmenu('1단계')
    check('a stage has both scoped actions', await js(`!!${menuItem('이 단계만 실행')} && !!${menuItem('이 단계 중지')}`))
    await key('Escape', 'Escape', 27)
    await requireState(`!document.querySelector('.run-context-menu')`)

    await choosePreset(names[8], '늘 보이기')
    check('pinning a hidden preset reveals just that row and its star', await until(`
      ${row(ids[8])}?.dataset.pinned === 'true' && ${rowCount} === 1`))
    await js('window.runSummaryBeforeReload = true')
    await send('Page.reload')
    check('the threshold and pinned preset survive a renderer reload', await until(`
      !window.runSummaryBeforeReload && !!${summary} && ${row(ids[8])}?.dataset.pinned === 'true'`))
    await clickElement(row(ids[8]), 'right')
    check('a pinned row opens the complete preset context menu', await until(`
      !!${menuItem('실행')} && !!${menuItem('실행 진단')} && !!${menuItem('패널에서 보기')} && !!${menuItem('폴더 열기')}`))
    await pick('고정 풀기')
    await requireState(`${rowCount} === 0`)

    await choosePreset(names[0], '실행')
    await confirmCommand()
    if (!await until(`${count('running')}.textContent === '1'`, 20000)) {
      const diagnostic = await js(`(async () => ({
        state: (await window.electronAPI.runPresetsList(${quoted})).states[${JSON.stringify(ids[0])}],
        notices: [...document.querySelectorAll('.toast, .run-command-dialog, .xterm-rows')].map(element => element.textContent.trim().slice(-500))
      }))()`)
      throw new Error('fixture did not become ready ' + JSON.stringify(diagnostic))
    }
    await choosePreset(names[1], '실행')
    await confirmCommand()
    check('a healthy running preset contributes to the count and only the crashed preset is shown', await until(`
      ${count('running')}.textContent === '1' && ${count('crashed')}.textContent === '1' &&
      ${row(ids[1])}?.dataset.status === 'crashed' && !${row(ids[0])} && ${rowCount} === 1`))
    await clickElement(row(ids[1]), 'right')
    check('the crashed row offers recovery and sending actions', await until(`
      !!${menuItem('다시 실행')} && !!${menuItem('로그 보기')} && !!${menuItem('에이전트에게 보내기')}`))
    await key('Escape', 'Escape', 27)
    await requireState(`!document.querySelector('.run-context-menu')`)

    await clickElement(count('crashed'))
    check('the crashed count opens the right panel filtered to this worktree’s crashed preset', await until(`
      ${panel}?.textContent.includes('run-summary') && ${panel}.textContent.includes('서비스 2') && !${panel}.textContent.includes('서비스 1')`))
    await clickElement(count('running'))
    check('the running count retargets the panel filter without reopening the sidebar list', await until(`
      ${panel}?.textContent.includes('서비스 1') && !${panel}.textContent.includes('서비스 2') && ${rowCount} === 1`))
    await shot('local-run-summary')
    const problems = await pageProblems(driver)
    check('no page errors', problems.length === 0, JSON.stringify(problems))
  } finally {
    await js(`window.electronAPI.runPresetStopAll(${quoted})`).catch(() => {})
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
