// The tab strip shows one work at a time (docs/plan/2026-11-19-tab-groups-by-project.md): a local tab
// opened in another project hides the first project's tab, the work selector switches back, the hidden
// tab's shell keeps running, and Ctrl+Tab stays within the group in front.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { connect, createChecks, unlock, sleep, pickTabGroup } = require('../support/driver')

const { check, finish } = createChecks()

;(async () => {
  const makeRepo = (name) => {
    const repo = path.join(process.env.E2E_PROFILE, name)
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'README.md'), name)
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Groups', '-c', 'user.email=groups@example.invalid', ...args], { cwd: repo, stdio: 'pipe', windowsHide: true })
    git('init', '-b', 'main')
    git('add', '.')
    git('commit', '-m', 'init')
    return repo
  }
  const alpha = makeRepo('alpha')
  const beta = makeRepo('beta')

  const driver = await connect()
  const { js, until, send } = driver
  try {
    await unlock(driver)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([alpha, beta]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    const open = name => `[...document.querySelectorAll('.local-worktree')].find(w => w.querySelector('.local-worktree-name')?.textContent === ${JSON.stringify(name)})?.querySelector('.local-worktree-open')`
    await until(`!!${open('alpha')} && !!${open('beta')}`, 15000)
    const tabs = `[...document.querySelectorAll('.terminal-tabs .terminal-tab')]`
    const selectName = `document.querySelector('.tab-group-select .tab-group-select-name')?.textContent`

    await js(`${open('alpha')}.click()`)
    check('a local tab opens in the first project', await until(`${tabs}.length === 1 && !!document.querySelector('.local-terminal-host .xterm-helper-textarea')`, 15000))
    check('the selector shows the current work', await until(`${selectName} === 'alpha' && !document.querySelector('.tab-group-select-more')`, 5000))
    const alphaId = await js(`${tabs}[0].dataset.tabId`)

    await js(`${open('beta')}.click()`)
    check('a tab of the other project replaces the strip', await until(`${tabs}.length === 1 && ${tabs}[0].dataset.tabId !== ${JSON.stringify(alphaId)}`, 15000), String(await js(`${tabs}.map(t => t.textContent.trim()).join(' | ')`)))
    check('the selector names the new work and tells there are two', await until(`${selectName} === 'beta' && document.querySelector('.tab-group-select-more')?.textContent === '2' && !document.querySelector('.tab-group-chip')`, 5000))
    const betaId = await js(`${tabs}[0].dataset.tabId`)
    check('the hidden tab keeps its shell', await js(`!!document.querySelector('[data-local-tab-id=${JSON.stringify(alphaId)}]')`))

    await pickTabGroup(driver, 'alpha')
    check('picking the first work in the list brings back its tab', await until(`${tabs}.length === 1 && ${tabs}[0].dataset.tabId === ${JSON.stringify(alphaId)} && ${tabs}[0].classList.contains('active')`, 5000))

    // Ctrl+Tab stays in the group in front (one tab here): the front tab does not change
    await js(`document.activeElement && document.activeElement.blur()`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 2 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 2 })
    await sleep(400)
    check('Ctrl+Tab stays within the group in front', await js(`${tabs}.length === 1 && ${tabs}[0].dataset.tabId === ${JSON.stringify(alphaId)}`))

    const plus = `document.querySelector('.terminal-tabs .new-tab-btn')`
    await driver.click(...await driver.center(plus))
    const browserItem = `[...document.querySelectorAll('.new-tab-menu-item')].find(item => item.textContent.trim() === '브라우저 열기')`
    await until(`!!${browserItem}`)
    await driver.click(...await driver.center(browserItem))
    const browser = `document.querySelector('.terminal-tab[data-tab-id^="browser:"]')`
    check('a browser tab opens alongside the local terminal in the same project', await until(`!!${browser} && ${tabs}.length === 2`))
    const browserId = await js(`${browser}.dataset.tabId`)
    await js(`${tabs}[0].click()`)
    await js(`(() => {
      window.__reorderSource = ${browser}
      window.__reorderData = new DataTransfer()
      window.__reorderSource.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__reorderData }))
    })()`)
    await sleep(200)
    const [leftX, tabY] = await js(`(() => { const r = ${tabs}[0].getBoundingClientRect(); return [r.left + 8, r.top + r.height / 2] })()`)
    await js(`(() => {
      const target = document.elementFromPoint(${leftX}, ${tabY})
      const options = { bubbles: true, cancelable: true, dataTransfer: window.__reorderData, clientX: ${leftX}, clientY: ${tabY} }
      target.dispatchEvent(new DragEvent('dragover', options))
    })()`)
    check('dragging a browser tab over the local tab shows an insertion line', await until(`!!document.querySelector('.tab-order-marker') && !document.querySelector('.tab-merge-marker')`, 3000))
    await js(`(() => {
      const target = document.elementFromPoint(${leftX}, ${tabY})
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__reorderData, clientX: ${leftX}, clientY: ${tabY} }))
      window.__reorderSource.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
    })()`)
    const browserFirst = `${tabs}.length === 2 && ${tabs}[0].dataset.tabId === ${JSON.stringify(browserId)} && ${tabs}[1].dataset.tabId === ${JSON.stringify(alphaId)}`
    check('reordering keeps both tabs and leaves the local shell selected', await until(`${browserFirst} && ${tabs}[1].classList.contains('active')`))
    await pickTabGroup(driver, 'beta')
    await pickTabGroup(driver, 'alpha')
    check('coming back to the project keeps the chosen tab order', await until(browserFirst))
    await js(`${browser}.querySelector('.tab-close').click()`)

    // Going to a tab from the sidebar switches the group
    await js(`${open('beta')}.click()`)
    check('opening the other project\'s worktree goes to its tab and group', await until(`${tabs}.length === 1 && ${tabs}[0].dataset.tabId === ${JSON.stringify(betaId)}`, 5000))

    // Closing the last tab of a work falls back to the other work
    await js(`${tabs}[0].querySelector('.tab-close, [aria-label*="닫기"]')?.click()`)
    check('closing a work\'s last tab shows the other work, one work left', await until(`${tabs}.length === 1 && ${tabs}[0].dataset.tabId === ${JSON.stringify(alphaId)} && ${selectName} === 'alpha' && !document.querySelector('.tab-group-select-more')`, 8000), String(await js(`${tabs}.map(t => t.dataset.tabId).join(',')`)))
    await driver.shot('local-tab-groups')
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
