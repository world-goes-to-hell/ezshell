// 프로젝트 검색 (docs/plan/2026-11-26-project-search.md): Shift twice finds a file of the local tab's project by
// name, Ctrl+Shift+F finds text in its files; both are heard in the terminal, and Enter opens the file window
// (a content result at its line). Typing a capital in the terminal must not open it.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { connect, createChecks, openLocalAgent, sleep, unlock } = require('../support/driver')

const { check, finish } = createChecks()
const SET = `(el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }`

async function findPage(match, timeout) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const found = (await (await fetch(`${process.env.E2E_CDP}/json`)).json()).find(match)
    if (found) return found
    await sleep(250)
  }
  return null
}

;(async () => {
  const work = path.join(process.env.E2E_PROFILE, 'search project')
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(work, relative)), { recursive: true })
    fs.writeFileSync(path.join(work, relative), content)
  }
  const lines = Array.from({ length: 300 }, (_, index) => index === 249 ? '    String marker = "needle-in-project";' : `    // line ${index + 1}`)
  write('src/app/OrderService.java', ['public class OrderService {', ...lines.slice(1), '}'].join('\n'))
  write('README.md', '# search project\n')
  write('node_modules/pkg/index.js', 'needle-in-project\n')
  write('.gitignore', 'ignored.log\n')
  write('ignored.log', 'needle-in-project\n')
  execFileSync('git', ['init', '-q'], { cwd: work, windowsHide: true })

  const driver = await connect()
  const { js, until, send, type } = driver
  const key = async (type, keyName, code, vk, modifiers = 0) => send('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode: vk, modifiers })
  const shiftTap = async () => {
    await key('rawKeyDown', 'Shift', 'ShiftLeft', 16, 8)
    await key('keyUp', 'Shift', 'ShiftLeft', 16, 0)
    await sleep(80)
  }
  const ctrlShiftF = async () => {
    await key('rawKeyDown', 'F', 'KeyF', 70, 2 | 8)
    await key('keyUp', 'F', 'KeyF', 70, 0)
  }
  const dialog = `document.querySelector('.project-search')`
  const selectedMode = `${dialog}?.querySelector('.project-search-mode[aria-selected="true"]')?.textContent ?? ''`
  const setQuery = query => js(`(${SET})(document.querySelector('.project-search-input > input'), ${JSON.stringify(query)})`)
  const focusTerminal = async () => {
    await js(`document.querySelector('.local-terminal-pane textarea.xterm-helper-textarea')?.focus()`)
    return until(`document.activeElement?.classList.contains('xterm-helper-textarea')`, 5000)
  }
  const openedFile = async run => {
    const before = new Set((await (await fetch(`${process.env.E2E_CDP}/json`)).json()).map(target => target.id))
    await run()
    const target = await findPage(found => found.url.includes('remoteFileMode') && !before.has(found.id), 15000)
    return target ? { target, page: await connect(found => found.id === target.id) } : null
  }
  const closeFile = async opened => {
    opened.page.close()
    try { await fetch(`${process.env.E2E_CDP}/json/close/${opened.target.id}`) } catch { /* gone */ }
  }

  try {
    await unlock(driver)
    await openLocalAgent(driver, undefined, work)
    check('a local terminal opens in the project', await until(`!!document.querySelector('.local-terminal-pane textarea.xterm-helper-textarea')`, 20000))
    await sleep(1500)
    check('the terminal has the keys', await focusTerminal())

    // Typing a capital (Shift held with a letter) twice is not Shift twice
    for (const [letter, code, vk] of [['A', 'KeyA', 65], ['B', 'KeyB', 66]]) {
      await key('rawKeyDown', 'Shift', 'ShiftLeft', 16, 8)
      await key('rawKeyDown', letter, code, vk, 8)
      await key('keyUp', letter, code, vk, 8)
      await key('keyUp', 'Shift', 'ShiftLeft', 16, 0)
      await sleep(60)
    }
    await sleep(300)
    check('typing capitals in the terminal does not open the search', !(await js(`!!${dialog}`)))

    await shiftTap()
    await shiftTap()
    check('Shift twice in the terminal opens the file search on the project', await until(`!!${dialog} && (${selectedMode}).includes('파일') &&
      (${dialog}.querySelector('.project-search-project')?.textContent ?? '').includes('search project')`, 5000),
      await js(`${dialog}?.textContent ?? 'no dialog'`))
    await setQuery('OrderServ')
    const fileRow = `[...document.querySelectorAll('.project-search-row.is-file')].find(row => row.textContent.includes('OrderService.java'))`
    check('the file is found by part of its name, with its folder', await until(`!!${fileRow} && ${fileRow}.querySelector('.project-search-folder')?.textContent === 'src/app'`, 10000),
      await js(`document.querySelector('.project-search-list')?.textContent ?? ''`))
    await driver.shot('project-search-file')
    const javaFile = await openedFile(() => send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }))
    check('Enter opens it in the file window and closes the search', !!javaFile && !(await js(`!!${dialog}`)) &&
      await javaFile.page.until(`(document.querySelector('.cm-content')?.textContent || '').includes('public class OrderService')`, 15000))
    if (javaFile) await closeFile(javaFile)

    // Opening again keeps the search; the opened search is listed in the empty box and completes typing
    await driver.js(`window.focus()`)
    check('the terminal has the keys before reopening', await focusTerminal())
    await shiftTap()
    await shiftTap()
    const box = `document.querySelector('.project-search-input > input')`
    check('Shift twice again shows the last search and its results', await until(`${box}?.value === 'OrderServ' && !!${fileRow}`, 10000),
      await js(`${box}?.value ?? 'no box'`))
    await setQuery('')
    const recentRow = `document.querySelector('.project-search-row.is-recent')`
    check('the empty box lists the search whose result was opened', await until(`(${recentRow}?.textContent ?? '') === 'OrderServ'`, 5000),
      await js(`document.querySelector('.project-search-list')?.textContent ?? ''`))
    await js(`${box}.focus()`)
    await type('Ord')
    check('typing completes the earlier search, the added part selected', await until(`${box}.value === 'OrderServ' &&
      ${box}.selectionStart === 3 && ${box}.selectionEnd === 9`, 5000),
      await js(`JSON.stringify([${box}.value, ${box}.selectionStart, ${box}.selectionEnd])`))
    await type('X')
    check('typing on replaces the completed part', await until(`${box}.value === 'OrdX'`, 3000), await js(`${box}.value`))
    await key('rawKeyDown', 'Escape', 'Escape', 27)
    await until(`!${dialog}`, 3000)

    await driver.js(`window.focus()`)
    check('the terminal has the keys again', await focusTerminal())
    await ctrlShiftF()
    check('Ctrl+Shift+F in the terminal opens the content search', await until(`!!${dialog} && (${selectedMode}).includes('내용')`, 5000))
    await setQuery('needle-in-project')
    const results = `document.querySelector('.project-search-list')?.textContent ?? ''`
    check('the content search finds the line, not in ignored files or installed folders', await until(`
      !!document.querySelector('.project-search-row.is-line') && (${results}).includes('OrderService.java') && (${results}).includes('250') &&
      !(${results}).includes('index.js') && !(${results}).includes('ignored.log')`, 10000), await js(results))
    await driver.shot('project-search-content')
    check('the found text is marked', await js(`document.querySelector('.project-search-row.is-line mark')?.textContent === 'needle-in-project'`))
    const lineFile = await openedFile(() => js(`document.querySelector('.project-search-row.is-line').click()`))
    check('a content result opens the file at its line', !!lineFile &&
      await lineFile.page.until(`(document.querySelector('.cm-activeLine')?.textContent || '').includes('needle-in-project')`, 15000),
      lineFile ? await lineFile.page.js(`document.querySelector('.cm-activeLine')?.textContent ?? 'no active line'`) : 'no window')
    if (lineFile) await closeFile(lineFile)

    await js('window.focus()')
    await focusTerminal()
    await shiftTap()
    await shiftTap()
    const regex = `document.querySelector('.project-search-regex')`
    await until(`!!${regex} && (${selectedMode}).includes('파일')`)
    await setQuery('')
    await js(`${regex}.click()`)
    check('file search offers a regex example and keeps focus in the query', await until(`
      ${regex}?.getAttribute('aria-pressed') === 'true' && document.activeElement === ${box} &&
      document.querySelector('.project-search-example code')?.textContent === ${JSON.stringify('\\.tsx$')}
    `))
    await setQuery('^src/app/Order.*\\.java$')
    check('the filename regex matches an entire relative path and highlights both parts', await until(`
      ${fileRow}?.querySelector('.project-search-name mark')?.textContent === 'OrderService.java' &&
      ${fileRow}.querySelector('.project-search-folder mark')?.textContent === 'src/app'
    `, 10000))
    await driver.shot('project-search-regex-file')
    await key('rawKeyDown', 'Escape', 'Escape', 27)
    await until(`!${dialog}`)

    await focusTerminal()
    await ctrlShiftF()
    check('the content shortcut keeps the regex mode and starts in the content tab', await until(`
      (${selectedMode}).includes('내용') && ${regex}?.getAttribute('aria-pressed') === 'true'
    `))
    await setQuery('[')
    check('an unfinished regex shows an inline error and clears stale results', await until(`
      ${box}?.getAttribute('aria-invalid') === 'true' && (${results}).includes('올바른 정규식') &&
      !document.querySelector('.project-search-row.is-line')
    `))
    await setQuery('needle-(?:in-project|elsewhere)')
    check('content regex highlights matched text and keeps git ignore rules', await until(`
      ${box}?.getAttribute('aria-invalid') === null && document.querySelector('.project-search-row.is-line mark')?.textContent === 'needle-in-project' &&
      (${results}).includes('250') && !(${results}).includes('ignored.log') && !(${results}).includes('index.js')
    `, 10000))
    await driver.shot('project-search-regex-content')
    await key('rawKeyDown', 'r', 'KeyR', 82, 1)
    await key('keyUp', 'r', 'KeyR', 82)
    check('Alt+R switches back to literal search without replacing the query', await until(`
      ${regex}?.getAttribute('aria-pressed') === 'false' && ${box}?.value === 'needle-(?:in-project|elsewhere)' &&
      (${results}).includes('찾은 것이 없습니다')
    `))
    await key('rawKeyDown', 'Escape', 'Escape', 27)
    await until(`!${dialog}`)

    // Without a local tab in front there is no project
    await js(`document.querySelectorAll('.terminal-tab .tab-close').forEach(button => button.click())`)
    await until(`!document.querySelector('.local-terminal-pane')`, 5000)
    await js(`document.activeElement?.blur()`)
    await shiftTap()
    await shiftTap()
    check('without a local tab the search says where it works', await until(`(${dialog}?.textContent ?? '').includes('로컬 작업 탭에서 쓸 수 있습니다')`, 5000),
      await js(`${dialog}?.textContent ?? 'no dialog'`))
    await key('rawKeyDown', 'Escape', 'Escape', 27)
    check('Esc closes it', await until(`!${dialog}`, 3000))
  } catch (error) {
    check(`no error: ${error.message}`, false)
  } finally {
    driver.close()
    finish()
  }
})()
