// Exercise the opening motion against the test SSH server, including a refused host key.
const { createChecks, connect, unlock, SET, PANEL } = require('../support/driver')
const { check, finish } = createChecks()

;(async () => {
  const driver = await connect()
  const { js, send, until } = driver
  const port = process.env.E2E_SSH_PORT
  const row = 'document.querySelector(".session-item")'
  const tabCount = 'document.querySelectorAll(".terminal-tab").length'
  const shell = `(${PANEL}?.querySelector('.xterm-rows')?.textContent || '').includes('fake shell')`
  const hostKeyButton = (text) => `[...document.querySelectorAll('.host-key-dialog button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`
  const trust = hostKeyButton('신뢰하고 접속')
  const setMotionPreference = (value) => send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }]
  })
  const openThemes = async () => {
    await js(`document.querySelector('.title-bar-btn[title="설정"]').click()`)
    await until(`!!document.querySelector('.theme-card-main')`)
  }
  const closeThemes = async () => {
    await js(`document.querySelector('.settings-modal .modal-close-btn').click()`)
    await until(`!document.querySelector('.settings-modal')`)
  }

  await unlock(driver)
  await openThemes()
  await js(`[...document.querySelectorAll('.theme-card-main')].find(button =>
    button.querySelector('.theme-name').textContent === 'Dracula'
  ).click()`)
  await closeThemes()
  await setMotionPreference('no-preference')
  await js(`(() => {
    window.__sshReveals = []
    window.__sshFlights = []
    new MutationObserver(records => {
      for (const record of records) for (const ghost of record.addedNodes) {
        if (!(ghost instanceof HTMLElement) || !ghost.matches('.session-tab-flight')) continue
        const tab = [...document.querySelectorAll('.terminal-tab, .split-pane-tab-item')]
          .find(node => node.dataset.tabId === ghost.dataset.destinationId)
        const label = tab?.querySelector('[data-tab-label]')
        const motion = ghost.getAnimations()[0]
        const endpoint = new DOMMatrixReadOnly(motion.effect.getKeyframes().at(-1).transform)
        const startX = ghost.offsetLeft + 7
        const startY = ghost.offsetTop + ghost.offsetHeight / 2
        const origin = document.querySelector('.session-item .session-name').getBoundingClientRect()
        const destination = label?.getBoundingClientRect()
        const style = getComputedStyle(ghost)
        const pixel = document.createElement('canvas').getContext('2d')
        pixel.fillStyle = style.getPropertyValue('--flight-accent').trim()
        pixel.fillRect(0, 0, 1, 1)
        window.__sshFlights.push({
          id: ghost.dataset.destinationId,
          startsAtRow: Math.abs(startX - origin.left) < 2 && Math.abs(startY - origin.top - origin.height / 2) < 2,
          endsAtLabel: !!destination && Math.abs(startX + endpoint.m41 - destination.left) < 12 &&
            Math.abs(startY + endpoint.m42 - destination.top - destination.height / 2) < 4,
          active: tab?.classList.contains('active'),
          secondary: !!tab?.closest('.split-pane.secondary'),
          pointerEvents: style.pointerEvents,
          hidden: ghost.getAttribute('aria-hidden'),
          labelHidden: getComputedStyle(label).opacity === '0',
          labelMatches: label.textContent === ghost.textContent,
          labelFits: ghost.scrollWidth <= ghost.clientWidth,
          accent: Array.from(pixel.getImageData(0, 0, 1, 1).data).slice(0, 3)
        })
        if (window.__captureSSHFlight) {
          motion.pause()
          motion.currentTime = 110
        }
      }
    }).observe(document.body, { childList: true })
    document.addEventListener('animationstart', (event) => {
      if (event.animationName !== 'ssh-terminal-reveal') return
      const cover = event.target
      const { visibility, pointerEvents } = getComputedStyle(cover)
      const reveal = { visibility, pointerEvents }
      const animation = cover.getAnimations().find(item => item.animationName === event.animationName)
      if (visibility === 'visible' && animation) {
        const elapsed = animation.currentTime
        reveal.duration = animation.effect.getTiming().duration
        animation.currentTime = reveal.duration / 2
        const style = getComputedStyle(cover)
        reveal.edgeOpacity = Number(style.opacity)
        reveal.edgePosition = new DOMMatrixReadOnly(style.transform).m42 / cover.offsetHeight
        reveal.gradient = style.backgroundImage
        const pixel = document.createElement('canvas').getContext('2d')
        pixel.fillStyle = style.borderTopColor
        pixel.fillRect(0, 0, 1, 1)
        reveal.edgeRgb = Array.from(pixel.getImageData(0, 0, 1, 1).data).slice(0, 3)
        animation.currentTime = elapsed
      }
      window.__sshReveals.push(reveal)
    })
    document.querySelector('.btn-quick-connect').click()
  })()`)
  await until(`!!document.querySelector('input[placeholder="192.168.1.1"]')`)
  await js(`(() => {
    const set = ${SET}
    set(document.querySelector('input[placeholder="192.168.1.1"]'), '127.0.0.1')
    set(document.querySelector('.modal-content input[type=number]'), '${port}')
    set(document.querySelector('input[placeholder="root"]'), 'tester')
    set(document.querySelector('input[placeholder="••••••••"]'), 'x')
    ;[...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === '연결 및 저장').click()
  })()`)

  check('the saved row shows the pending motion before a tab opens', await until(`
    !!${trust} && ${row}?.getAttribute('aria-busy') === 'true' && ${tabCount} === 0 &&
    getComputedStyle(${row}, '::after').animationName === 'ssh-connecting-sweep'
  `))
  check('the pending motion uses the selected accent', await js(`
    getComputedStyle(${row}, '::after').backgroundImage.includes('rgb(189, 147, 249)')
  `))
  await js(`${hostKeyButton('접속 안 함')}?.click()`)
  check('refusing the host key clears the busy state without opening a tab', await until(`
    !${trust} && !!${row} && !${row}.hasAttribute('aria-busy') && ${tabCount} === 0
  `))

  const connectFromSidebar = () => js(`${row}.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
  await connectFromSidebar()
  await until(`!!${trust}`)
  await js(`${hostKeyButton('접속 안 함')}?.click()`)
  check('refusing a connection from the sidebar leaves the flight idle', await until(`
    !${trust} && !${row}.hasAttribute('aria-busy') && ${tabCount} === 0 && window.__sshFlights.length === 0
  `))
  await connectFromSidebar()
  await until(`!!${trust} && !${trust}.disabled`)
  await js(`${trust}.click()`)
  check('success clears the busy state, lights the row and opens the shell', await until(`
    ${row}.classList.contains('active') && !${row}.hasAttribute('aria-busy') && ${shell}
  `))
  check('the reveal plays once, lets pointer input through and removes its cover', await until(`
    window.__sshReveals.length === 1 && window.__sshReveals[0].visibility === 'visible' &&
    window.__sshReveals[0].pointerEvents === 'none' && !document.querySelector('.terminal-connection-reveal')
  `))
  const firstReveal = await js('window.__sshReveals[0]')
  check('the leading edge stays bright while crossing the terminal', firstReveal?.duration >= 450 &&
    firstReveal.edgeOpacity >= .9 && firstReveal.edgePosition > .25 && firstReveal.edgePosition < .85, JSON.stringify(firstReveal))
  const [darkRed, darkGreen, darkBlue] = firstReveal?.edgeRgb ?? []
  check('Dracula opens with a purple edge and its own shell background',
    darkBlue > darkRed && darkRed > darkGreen && firstReveal.gradient.endsWith('rgb(30, 31, 41) 88px)'))
  const flightLanded = '!document.querySelector(".session-tab-flight, .session-tab-receiver")'
  check('the sidebar name flies to the newly active tab and restores its label', await until(`
    window.__sshFlights.length === 1 && ${flightLanded} &&
    window.__sshFlights[0].id === document.querySelector('.terminal-tab.active').dataset.tabId
  `))
  const firstFlight = await js('window.__sshFlights[0]')
  check('the flight uses themed color, follows the source and destination, and takes no input',
    firstFlight?.startsAtRow && firstFlight.endsAtLabel && firstFlight.active &&
    firstFlight.labelHidden && firstFlight.labelMatches && firstFlight.labelFits && firstFlight.pointerEvents === 'none' &&
    firstFlight.hidden === 'true' && firstFlight.accent.join() === '189,147,249', JSON.stringify(firstFlight))

  const sidebar = 'document.querySelector(".sidebar")'
  const toggleSidebar = () => js('document.querySelector(".sidebar-toggle").click()')
  const compact = `${sidebar}.matches('.rail:not(.peek-open)')`
  const mainLeft = 'document.querySelector("#main-content").getBoundingClientRect().left'
  const dotColor = 'getComputedStyle(document.querySelector(".session-item.active .session-dot")).backgroundColor'
  const railDot = 'document.querySelector(".rail-connection-dot")'
  const pinnedLeft = await js(mainLeft)
  const connectedColor = await js(dotColor)
  await js(`(() => {
    window.__dotFlights = []
    new MutationObserver(records => {
      for (const record of records) for (const dot of record.addedNodes) {
        if (!(dot instanceof HTMLElement) || !dot.matches('.sidebar-connection-flight')) continue
        const style = getComputedStyle(dot)
        const animation = dot.getAnimations()[0]
        const from = new DOMMatrixReadOnly(animation.effect.getKeyframes()[0].transform)
        const to = new DOMMatrixReadOnly(animation.effect.getKeyframes().at(-1).transform)
        const left = parseFloat(dot.style.left) + dot.offsetWidth / 2
        const top = parseFloat(dot.style.top) + dot.offsetHeight / 2
        const positionMatches = (matrix, element) => {
          const rect = element.getBoundingClientRect()
          return Math.abs(left + matrix.m41 - rect.left - rect.width / 2) < 2 &&
            Math.abs(top + matrix.m42 - rect.top - rect.height / 2) < 2
        }
        const folding = ${compact}
        const row = [...document.querySelectorAll('.session-item.active')].find(item =>
          positionMatches(folding ? from : to, item.querySelector(
            '.session-dot, .session-tab-badge--connected .session-tab-badge-dot'
          ))
        )
        window.__dotFlights.push({
          sessionId: row?.dataset.sessionId,
          followsDots: !!row && positionMatches(folding ? to : from, ${railDot}),
          color: style.backgroundColor,
          accent: style.getPropertyValue('--sidebar-flight-accent').trim(),
          pointerEvents: style.pointerEvents
        })
      }
    }).observe(document.body, { childList: true })
  })()`)
  await toggleSidebar()
  check('folding hands off the green session dot to the rail with the theme accent as a glow', await until(`
    ${compact} && ${railDot} && document.querySelector('.sidebar-content').inert &&
    !document.querySelector('.sidebar-connection-flight, .sidebar-connection-arrival') &&
    window.__dotFlights.length === 1 && getComputedStyle(${railDot}).backgroundColor === ${JSON.stringify(connectedColor)}
  `))
  const foldedFlight = await js('window.__dotFlights[0]')
  check('the moving dot follows both visible anchors and keeps the connected status color',
    foldedFlight?.followsDots && foldedFlight.color === connectedColor &&
    foldedFlight.accent.toLowerCase() === '#bd93f9' && foldedFlight.pointerEvents === 'none', JSON.stringify(foldedFlight))
  const compactLeft = await js(mainLeft)
  const railPoint = await driver.center(sidebar)
  await driver.move(...railPoint)
  check('hover opens the sidebar over the terminal and returns the green dot to the row', await until(`
    ${sidebar}.matches('.rail.peek-open') && ${mainLeft} === ${compactLeft} &&
    !document.querySelector('.sidebar-content').inert && window.__dotFlights.length === 2 &&
    window.__dotFlights[1].followsDots && !document.querySelector('.sidebar-connection-flight')
  `))
  await driver.move(pinnedLeft + 100, 200)
  check('leaving the peek closes it and leaves the shell in place', await until(`
    ${compact} && ${mainLeft} === ${compactLeft} && ${shell} && window.__dotFlights.length === 3 &&
    !document.querySelector('.sidebar-connection-flight')
  `))
  await driver.move(...railPoint)
  await until(`${sidebar}.matches('.rail.peek-open') && !document.querySelector('.sidebar-connection-flight')`)
  await toggleSidebar()
  await driver.move(pinnedLeft + 100, 200)
  check('pinning keeps the overlay open as a docked sidebar with the same terminal', await until(`
    !${sidebar}.classList.contains('rail') && ${mainLeft} === ${pinnedLeft} &&
    ${shell} && window.__dotFlights.length === 4
  `))

  await openThemes()
  await js(`document.querySelector('.theme-action-btn-primary').click()`)
  await until(`!!document.querySelector('#theme-editor-name')`)
  await js(`(() => {
    const set = ${SET}
    const colorField = label => [...document.querySelectorAll('.theme-editor .color-picker')].find(field =>
      field.querySelector('label').textContent === label
    ).querySelector('.color-picker-text')
    set(document.querySelector('#theme-editor-name'), 'Motion theme test')
    set(colorField('액센트'), '#a21c47')
    set(colorField('배경'), '#eef1f7')
    set(colorField('전경'), '#122035')
    document.querySelector('.theme-editor-btn-primary').click()
  })()`)
  await until(`document.documentElement.dataset.theme.startsWith('custom-')`)
  await closeThemes()
  await connectFromSidebar()
  check('the custom theme opens another shell', await until(`
    ${tabCount} === 2 && ${shell} && !document.querySelector('.terminal-connection-reveal')
  `))
  const customReveal = await js('window.__sshReveals[1]')
  const [customRed, customGreen, customBlue] = customReveal?.edgeRgb ?? []
  check('the cover immediately picks up a custom accent and light shell background',
    customRed > customBlue && customBlue > customGreen && customReveal.gradient.endsWith('rgb(238, 241, 247) 88px)'),
    JSON.stringify(customReveal))
  check('the custom accent also colors the flight to the second tab', await until(`
    window.__sshFlights.length === 2 && ${flightLanded} &&
    window.__sshFlights[1].id === document.querySelector('.terminal-tab.active').dataset.tabId &&
    window.__sshFlights[1].accent.join() === '162,28,71'
  `))

  await setMotionPreference('reduce')
  await toggleSidebar()
  const reducedFold = await until(`
    ${compact} && Math.abs(document.querySelector('.sidebar-panel').getBoundingClientRect().width - 46) < 1 &&
    getComputedStyle(${railDot}).visibility === 'visible' && window.__dotFlights.length === 4
  `, 3000)
  check('reduced motion folds the sidebar immediately with the status dot already in the rail', reducedFold, reducedFold ? '' :
    JSON.stringify(await js(`({
      compact: ${compact},
      width: document.querySelector('.sidebar-panel').getBoundingClientRect().width,
      dot: getComputedStyle(${railDot}).visibility,
      flights: window.__dotFlights.length,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches
    })`)))
  await toggleSidebar()
  await connectFromSidebar()
  check('reduced motion opens a shell without showing a reveal', await until(`
    ${tabCount} === 3 && ${shell} && !document.querySelector('.terminal-connection-reveal') &&
    window.__sshReveals.filter(entry => entry.visibility === 'visible').length === 2 &&
    window.__sshFlights.length === 2 && ${flightLanded}
  `))
  await setMotionPreference('no-preference')
  await js(`document.querySelector('.terminal-tab').click()`)
  check('returning to the existing tab leaves its shell visible without another reveal', await until(`
    document.querySelector('.terminal-tab').classList.contains('active') &&
    ${shell} && !document.querySelector('.terminal-connection-reveal') &&
    window.__sshReveals.filter(entry => entry.visibility === 'visible').length === 2 && window.__sshFlights.length === 2
  `))
  await js(`document.querySelector('.terminal-tab').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 450, clientY: 60 })
  )`)
  await until(`!!document.querySelector('.tab-context-menu')`)
  await js(`[...document.querySelectorAll('.tab-context-menu .menu-item')].find(
    button => button.textContent.trim() === '가로 분할'
  ).click()`)
  const focusedPane = 'document.querySelector(".split-pane.secondary.active-pane")'
  await until(`!!document.querySelector('.split-pane.secondary .split-pane-header')`)
  await js(`document.querySelector('.split-pane.secondary .split-pane-header').dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true })
  )`)
  check('the secondary split accepts focus', await until(`!!${focusedPane}`))
  await js('window.__captureSSHFlight = true')
  await connectFromSidebar()
  check('the flight follows the new tab into the focused split', await until(`
    window.__sshFlights.length === 3 &&
    window.__sshFlights[2].id === ${focusedPane}?.querySelector('.split-pane-tab-item.active')?.dataset.tabId &&
    window.__sshFlights[2].secondary && window.__sshFlights[2].endsAtLabel
  `))
  if (await js(`!!document.querySelector('.session-tab-flight')`)) {
    await driver.shot('ssh-session-tab-flight')
    await js(`document.querySelector('.session-tab-flight')?.getAnimations()[0]?.play()`)
  }
  check('the split destination label is restored when the flight ends', await until(flightLanded))

  await js(`document.querySelector('.sidebar .btn-new-connection').click()`)
  await until(`!!document.querySelector('input[placeholder="My Server"]')`)
  await js(`(() => {
    const set = ${SET}
    const form = document.querySelector('input[placeholder="My Server"]').form
    set(form.querySelector('input[placeholder="My Server"]'), 'Second saved session')
    set(form.querySelector('input[placeholder="192.168.1.1"]'), '127.0.0.1')
    set(form.querySelector('input[type=number]'), '${port}')
    set(form.querySelector('input[placeholder="root"]'), 'tester')
    set(form.querySelector('input[placeholder="••••••••"]'), 'x')
    form.querySelector('.icon-option[title="cloud"]').click()
  })()`)
  await until(`!!document.querySelector('.icon-option.selected[title="cloud"]')`)
  await js(`document.querySelector('input[placeholder="My Server"]').form.querySelector('button[type=submit]').click()`)
  check('two saved sessions share the rail, including a session with a custom icon', await until(`
    document.querySelectorAll('.session-item.active').length === 2 &&
    document.querySelectorAll('.session-item.active .session-dot').length === 1 &&
    Number(document.querySelector('.rail-count.is-connected').textContent.trim()) === 5
  `))
  await js('window.__dotFlights = []')
  await toggleSidebar()
  const sidebarMotionFinished = '!document.querySelector(".sidebar-connection-flight, .sidebar-connection-arrival")'
  const bothSessionsVisited = (index) => `
    window.__dotFlights.slice(${index}, ${index + 2}).every(entry => entry.followsDots) &&
    new Set(window.__dotFlights.slice(${index}, ${index + 2}).map(entry => entry.sessionId)).size === 2
  `
  check('folding merges both session indicators into a single rail dot', await until(`
    ${compact} && ${sidebarMotionFinished} && window.__dotFlights.length === 2 && ${bothSessionsVisited(0)}
  `))
  await driver.move(...railPoint)
  check('peeking fans the rail dot out once to each connected session regardless of focus or tab count', await until(`
    ${sidebar}.matches('.rail.peek-open') && ${sidebarMotionFinished} &&
    window.__dotFlights.length === 4 && ${bothSessionsVisited(2)}
  `))
  finish()
})().catch((error) => { console.error(error); process.exit(1) })
