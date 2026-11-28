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
  const feature = path.join(process.env.E2E_PROFILE, 'alpha-feature')
  execFileSync('git', ['worktree', 'add', '-b', 'feature', feature], { cwd: alpha, stdio: 'pipe', windowsHide: true })

  const driver = await connect()
  const { js, until, send } = driver
  try {
    await unlock(driver)
    await js(`localStorage.setItem('ezshell.localProjects', ${JSON.stringify(JSON.stringify([alpha, beta]))});
      window.dispatchEvent(new Event('ezshell:local-projects-changed'))`)
    // A project with one worktree shows its name only on the project's line (the row names its terminal)
    const open = name => `([...document.querySelectorAll('.local-worktree')].find(w => w.querySelector('.local-worktree-name')?.textContent === ${JSON.stringify(name)}) ??
      [...document.querySelectorAll('.local-project')].find(p => p.querySelector('.local-project-name')?.textContent === ${JSON.stringify(name)})?.querySelector('.local-worktree.is-lone'))?.querySelector('.local-worktree-open')`
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
    check('the labeled work list has its own bordered area before the tabs', await js(`(() => {
      const work = document.querySelector('.terminal-tab-header > .tab-group-control')
      const strip = document.querySelector('.terminal-tab-header > .terminal-tab-items')
      return work?.querySelector('.tab-group-select-label')?.textContent === '작업 목록 · 2개'
        && getComputedStyle(work).borderInlineEndWidth === '1px'
        && work.getBoundingClientRect().right <= strip.getBoundingClientRect().left
        && !!strip.querySelector('.terminal-tab.active')
    })()`))
    await driver.shot('local-tab-group-header')
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
    const fromNewTabMenu = async label => {
      await driver.click(...await driver.center(plus))
      const item = `[...document.querySelectorAll('.new-tab-menu-item')].find(item => item.textContent.trim() === ${JSON.stringify(label)})`
      if (!(await until(`!!${item}`, 5000))) throw new Error(`the new tab menu has no ${label} option`)
      await driver.click(...await driver.center(item))
    }
    // A local work is added from the work list's own +, not from the new tab menu (user decision, 2026-11-20)
    await driver.click(...await driver.center(plus))
    await until(`document.querySelectorAll('.new-tab-menu-item').length > 0`, 5000)
    check('the new tab menu has no 로컬 작업 item', await js(`![...document.querySelectorAll('.new-tab-menu-item')].some(item => item.textContent.includes('로컬 작업'))`))
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until(`!document.querySelector('.new-tab-menu')`, 3000)
    await driver.click(...await driver.center(`document.querySelector('.tab-group-select')`))
    check('the work list has a + at the end of its title row', await until(`!!document.querySelector('.tab-group-menu-head .tab-group-menu-add')`, 4000))
    await driver.click(...await driver.center(`document.querySelector('.tab-group-menu-add')`))
    check('the + opens the 로컬 작업 dialog', await until(`!!document.querySelector('.local-project-dialog')`, 4000))
    // Adding starts with no folder (user report: a registered folder was already picked) and picks no agent
    check('adding starts with no folder picked', await js(`document.querySelector('#local-project-folder')?.value === '' && !document.querySelector('.local-project-dialog button[type=submit]')`))
    check("the dialog has no agent choice (the user's shell opens)", await js(`!document.querySelector('#local-project-agent') && !document.querySelector('.local-project-dialog').textContent.includes('실행 도구')`))
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until(`!document.querySelector('.local-project-dialog')`, 3000)
    await fromNewTabMenu('브라우저 열기')
    const browser = `document.querySelector('.terminal-tab[data-tab-id^="browser:"]')`
    check('a browser tab opens alongside the local terminal in the same project', await until(`!!${browser} && ${tabs}.length === 2`))
    const browserId = await js(`${browser}.dataset.tabId`)
    // 2026-11-20 user request: the work's browser (and SSH) tabs show in its worktree in the sidebar too
    check('the browser tab is listed under the worktree in the sidebar', await until(`!!document.querySelector('.local-worktree [data-work-tab-id="${browserId}"]')`, 5000))
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

    const splitTab = (screen, id) => `document.querySelector('.split-pane[data-screen="${screen}"] .split-pane-tab-item[data-tab-id="${id}"]')`
    await js(`(() => {
      window.__splitSource = ${browser}
      window.__splitData = new DataTransfer()
      window.__splitSource.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__splitData }))
    })()`)
    await js(`(() => {
      const area = document.querySelector('.terminal-area')
      const bounds = area.getBoundingClientRect()
      const options = { bubbles: true, cancelable: true, dataTransfer: window.__splitData, clientX: bounds.right - 12, clientY: bounds.top + bounds.height / 2 }
      area.dispatchEvent(new DragEvent('dragover', options))
    })()`)
    await until(`!!document.querySelector('.drop-zone-right.active')`, 3000)
    await js(`window.__splitSource.dispatchEvent(new DragEvent('dragend', { bubbles: true }))`)
    const splitRestored = `${splitTab(0, alphaId)}?.classList.contains('active') && ${splitTab(1, browserId)}?.classList.contains('active') && !!document.querySelector('.split-pane[data-screen="1"].active-pane')`
    const visibleLeftTab = `document.querySelector('.split-pane[data-screen="0"] .terminal-wrapper.visible [data-local-tab-id]')?.dataset.localTabId`
    check('dragging opens the tab in the right screen', await until(splitRestored, 5000))
    check('the left screen shows the local terminal of the selected work', await until(`${visibleLeftTab} === ${JSON.stringify(alphaId)}`, 5000))
    const splitSelector = `document.querySelector('.split-pane[data-screen="0"] .tab-group-select')`
    const selectorPresent = await until(`!!${splitSelector} && ${selectName} === 'alpha' && document.querySelectorAll('.tab-group-select').length === 1`, 3000)
    check('the work selector remains at the left of the split tab strip', selectorPresent)
    if (selectorPresent) {
      await driver.shot('local-tab-groups-split')
      await driver.click(...await driver.center(splitSelector))
      check('opening the work list keeps focus on the right screen', await until(`!!document.querySelector('.tab-group-menu') && ${splitRestored}`, 3000))
      const betaOption = `[...document.querySelectorAll('.tab-group-option')].find(item => item.querySelector('.tab-group-option-name')?.textContent === 'beta')`
      await driver.click(...await driver.center(betaOption))
      check('selecting another work from the split shows its tabs', await until(`!document.querySelector('.split-pane') && ${selectName} === 'beta' && ${tabs}[0]?.dataset.tabId === ${JSON.stringify(betaId)}`, 5000))
      await pickTabGroup(driver, 'alpha')
      check('returning restores the split and its focused tab', await until(`${splitRestored} && ${visibleLeftTab} === ${JSON.stringify(alphaId)}`, 5000))
    }
    await js(`document.querySelector('.split-pane-btn[title="분할 해제"]')?.click()`)
    await until(browserFirst, 5000)
    await js(`${browser}.querySelector('.tab-close').click()`)

    // Going to a tab from the sidebar switches the group
    await js(`${open('beta')}.click()`)
    check('opening the other project\'s worktree goes to its tab and group', await until(`${tabs}.length === 1 && ${tabs}[0].dataset.tabId === ${JSON.stringify(betaId)}`, 5000))

    // Closing the last tab of a work falls back to the other work
    await js(`${tabs}[0].querySelector('.tab-close, [aria-label*="닫기"]')?.click()`)
    check('closing a work\'s last tab shows the other work, one work left', await until(`${tabs}.length === 1 && ${tabs}[0].dataset.tabId === ${JSON.stringify(alphaId)} && ${selectName} === 'alpha' && !document.querySelector('.tab-group-select-more')`, 8000), String(await js(`${tabs}.map(t => t.dataset.tabId).join(',')`)))
    await driver.shot('local-tab-groups')

    const active = `document.querySelector('.terminal-tab.active')`
    const cwdIs = folder => `window.electronAPI.localShellCurrentDirectory(${active}?.dataset.tabId).then(cwd => cwd === ${JSON.stringify(folder)})`
    const badge = tab => `${tab}.querySelector('.tab-worktree-badge')`
    check('the main checkout has a separate branch badge', await until(`${badge(active)}?.textContent === 'main'`))
    await fromNewTabMenu('로컬 터미널')
    check('the plus menu opens a shell in the active checkout without leaving its work', await until(`
      ${tabs}.length === 2 && ${selectName} === 'alpha' && ${badge(active)}?.textContent === 'main' && ${cwdIs(alpha)}
    `))
    await js(`${active}.querySelector('.tab-close').click()`)

    // 2026-11-26 user report: with a tab in a folder below the work (mbris-new\backend) in front, the plus
    // menu's shell opened there and there was no way to open one in the work's folder
    const backend = path.join(alpha, 'backend')
    fs.mkdirSync(backend, { recursive: true })
    await js(`window.dispatchEvent(new CustomEvent('ezshell:open-local-terminal', { detail: ${JSON.stringify({ cwd: backend, workspaceLabel: 'backend' })} }))`)
    check('a shell in a folder below the work joins the work', await until(`${tabs}.length === 2 && ${selectName} === 'alpha' && ${cwdIs(backend)}`, 10000))
    await fromNewTabMenu('로컬 터미널')
    check('the plus menu’s shell opens in the work’s folder, not the front tab’s', await until(`${tabs}.length === 3 && ${cwdIs(alpha)}`, 10000))
    await js(`${active}.querySelector('.tab-close').click()`)
    await until(`${tabs}.length === 2`)
    await js(`[...document.querySelectorAll('.terminal-tab')].find(tab => tab.offsetParent && tab.textContent.includes('backend'))?.click()`)
    await until(`${cwdIs(backend)}`, 5000)
    await fromNewTabMenu('로컬 터미널 · backend앞 탭의 폴더')
    check('the plus menu also offers the front tab’s folder below the work', await until(`${tabs}.length === 3 && ${cwdIs(backend)} && ${active}?.dataset.tabId !== undefined`, 10000))
    // Only the two shells opened here: the work's first tab stays for the checks below
    for (let index = 0; index < 2; index++) {
      await js(`${tabs}.find(tab => tab.dataset.tabId !== ${JSON.stringify(alphaId)})?.querySelector('.tab-close').click()`)
      await sleep(300)
    }
    await until(`${tabs}.length === 1 && ${tabs}[0].dataset.tabId === ${JSON.stringify(alphaId)}`, 5000)

    await js(`${open('alpha-feature')}.click()`)
    check('the feature worktree has its own badge in the same project', await until(`${selectName} === 'alpha' && ${badge(active)}?.textContent === 'feature' && ${cwdIs(feature)}`))
    await fromNewTabMenu('브라우저 열기')
    await until(`${active}?.dataset.tabId.startsWith('browser:')`)
    await fromNewTabMenu('로컬 터미널')
    check('opening a shell from the project browser uses the last local worktree', await until(`
      ${tabs}.length === 4 && ${selectName} === 'alpha' &&
      ${badge(active)}?.textContent === 'feature' && !${active}.querySelector('[data-tab-label]').textContent.includes('feature') && ${cwdIs(feature)}
    `))
    await sleep(250)
    await driver.shot('local-tab-worktree-badges')

    const mainTab = `document.querySelector('.terminal-tab[data-tab-id="${alphaId}"]')`
    const target = await driver.center(mainTab)
    await js(`(() => {
      window.__worktreeDrag = new DataTransfer()
      window.__worktreeSource = ${active}
      window.__worktreeSource.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__worktreeDrag }))
    })()`)
    await sleep(200)
    const overWorktree = kind => js(`(${mainTab}).dispatchEvent(new DragEvent(${JSON.stringify(kind)}, {
      bubbles: true, cancelable: true, dataTransfer: window.__worktreeDrag, clientX: ${target[0]}, clientY: ${target[1]}
    }))`)
    await overWorktree('dragover')
    check('holding over a different worktree shows both folders as the reason merging is blocked', await until(`(() => {
      const marker = document.querySelector('.tab-merge-marker.on-tab.is-blocked')
      return !!marker && marker.textContent.includes(${JSON.stringify(alpha)}) && marker.textContent.includes(${JSON.stringify(feature)})
    })()`, 4000))
    await overWorktree('drop')
    await js(`window.__worktreeSource.dispatchEvent(new DragEvent('dragend', { bubbles: true }))`)
    check('the rejected merge leaves all of the tabs open', await until(`${tabs}.length === 4 && [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('같은 작업 폴더'))`))
  } finally {
    driver.close()
  }
  finish()
})().catch(error => { console.error(error); process.exit(1) })
