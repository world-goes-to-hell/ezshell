// 설정 > 진단 정보 and the command palette's 진단 정보 복사 (docs/plan/2026-11-28-diagnostics.md): main builds the
// bundle (versions, agent states, recent errors; no messages or secrets), the screen shows the error count, a folded
// preview, and copies it. 파일로 저장 opens a save dialog, so it is not pressed here.
// Run by e2e/run.js (fresh profile, no server needed).
const { createChecks, connect, unlock, pageProblems } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { send, js, until, shot } = driver
  try {
    await send('Page.bringToFront')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await unlock(driver)
    if (!await js(`typeof window.electronAPI.diagnosticsReport === 'function'`)) {
      check('main offers the diagnostics bundle', false, 'window.electronAPI.diagnosticsReport is missing')
      return
    }

    // An error of the main window's console is recorded (errors.log) and counted in the bundle
    await js(`console.error('e2e-diagnostics-marker')`)
    let report = null
    for (let tries = 0; tries < 40; tries++) {
      report = await js(`window.electronAPI.diagnosticsReport()`)
      if (report?.text?.includes('e2e-diagnostics-marker')) break
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    check('a console error of the main window reaches the bundle’s recent errors', report?.errors >= 1 && report.text.includes('e2e-diagnostics-marker'),
      report?.text?.split('## 최근 오류')[1]?.slice(0, 300))
    check('main builds a readable bundle with the error count of the last day', report?.success === true &&
      typeof report.text === 'string' && report.text.length > 0 && Number.isInteger(report.errors), JSON.stringify(report).slice(0, 300))
    const home = process.env.USERPROFILE || process.env.HOME || ''
    check('the bundle does not spell out the home folder', !home || !report.text.toLowerCase().includes(home.toLowerCase()))

    const comma = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, modifiers: 2 }
    await js(`document.activeElement && document.activeElement.blur()`)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...comma })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...comma })
    if (!await until(`!!document.querySelector('.settings-tabs-list')`, 5000)) throw new Error('settings did not open')
    const tab = `[...document.querySelectorAll('.settings-tabs-list > [role=tab]')].find(tab => tab.textContent.trim() === '진단 정보')`
    check('settings list 진단 정보 as a category', await until(`!!${tab}`))
    await js(`${tab}.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`)
    const section = `document.querySelector('.diagnostics-settings')`
    check('it shows the recent error count', await until(`/^최근 24시간 오류 [0-9,]+건$/.test(${section}?.querySelector('.diagnostics-summary')?.textContent ?? '')`, 8000),
      await js(`${section}?.querySelector('.diagnostics-summary')?.textContent`))
    const buttons = await js(`[...${section}.querySelectorAll('.diagnostics-actions button')].map(button => button.textContent.trim()).join('|')`)
    check('with 복사, 파일로 저장, 로그 폴더 열기 and 다시 만들기', buttons === '복사|파일로 저장|로그 폴더 열기|다시 만들기', buttons)
    check('the preview starts folded and holds the bundle', await js(`(() => {
      const details = ${section}.querySelector('.diagnostics-preview')
      return !!details && !details.open && details.querySelector('pre').textContent.length > 0
    })()`))
    await js(`${section}.querySelector('.diagnostics-preview summary').click()`)
    await shot('settings-diagnostics')

    await js(`[...${section}.querySelectorAll('.diagnostics-actions button')].find(button => button.textContent.trim() === '복사').click()`)
    check('복사 puts the bundle on the clipboard', await until(`[...document.querySelectorAll('.toast')].some(toast => toast.textContent.includes('복사됨'))`, 5000))

    // The command palette's 진단 정보 복사
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until(`!document.querySelector('.settings-tabs-list')`, 3000)
    await js(`document.activeElement?.blur()`)
    const palette = { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: process.platform === 'darwin' ? 4 : 2 }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...palette })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...palette })
    const item = `[...document.querySelectorAll('.command-item')].find(item => item.textContent.includes('진단 정보 복사'))`
    check('the command palette offers 진단 정보 복사', await until(`!!${item}`, 4000))

    // The marker above is the only console error expected
    const problems = (await pageProblems(driver)).filter(problem => !JSON.stringify(problem).includes('e2e-diagnostics-marker'))
    check('no page errors', !problems.length, JSON.stringify(problems))
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
