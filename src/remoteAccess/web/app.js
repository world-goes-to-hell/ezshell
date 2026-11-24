// The phone page of ezShell's remote access: register once (the address carries a one-time code),
// sign in with the authenticator's code, pick a session, use its terminal; answer MCP approval
// requests (approvals.js), watch MCP activity (activity.js), follow PC tabs and agent chats.
// Plain script (no build step): served as it is by src/remoteAccess/server.js.
(() => {
  'use strict'
  const TOKEN_KEY = 'ezshell-device-token'
  // A ticket from a code sign-in that lets this device resume without a code for a day
  const TRUST_KEY = 'ezshell-device-trust'
  const $ = (id) => document.getElementById(id)
  const views = ['signin', 'message', 'sessions', 'tabs', 'activity', 'agents', 'chat', 'terminal', 'tab-terminal']
  const TABBED = new Set(['sessions', 'tabs', 'activity', 'agents', 'chat'])
  const AGENT_VIEWS = new Set(['agents', 'chat'])
  const PC_TAB_VIEWS = new Set(['tabs', 'tab-terminal'])
  const workspaceSize = window.matchMedia('(min-width: 45rem) and (min-height: 40rem)')
  const workspaceLists = { terminal: 'sessions', 'tab-terminal': 'tabs', chat: 'agents' }
  const workspaceHints = {
    sessions: '목록에서 열 세션을 선택하세요.',
    tabs: '이어서 볼 PC 탭을 선택하세요.',
    agents: '대화를 열 에이전트를 선택하세요.'
  }
  const THEME_VARIABLES = [
    '--bg', '--panel', '--line', '--text', '--muted', '--accent', '--on-accent',
    '--focus', '--error', '--danger', '--radius', '--panel-radius', '--font', '--scheme'
  ]
  let currentView = null
  let tabsEnabled = false
  let agentsEnabled = false
  let keyboardOpen = false
  const terminalView = view => view === 'terminal' || view === 'tab-terminal'
  const showsNavigation = view => TABBED.has(view) || terminalView(view)
  const inWorkspace = () => workspaceSize.matches && showsNavigation(currentView)

  function updateNavigationVisibility(workspace = inWorkspace()) {
    const hideForKeyboard = keyboardOpen && terminalView(currentView)
    $('tabs').hidden = workspace || !showsNavigation(currentView) || hideForKeyboard
    document.body.toggleAttribute('data-terminal-keyboard', hideForKeyboard)
  }

  function layout() {
    const workspace = inWorkspace()
    document.body.toggleAttribute('data-workspace', workspace)
    views.forEach(view => { $(`view-${view}`).hidden = view !== currentView })
    if (workspace) {
      $('view-sessions').hidden = false
      $('view-agents').hidden = !agentsEnabled
      $('view-tabs').hidden = !tabsEnabled
    }
    $('workspace-header').hidden = !workspace
    $('workspace-status').hidden = !workspace
    $('workspace-activity').setAttribute('aria-pressed', String(currentView === 'activity'))
    const active = $('workspace-current')
    for (const [name, bar] of workspaceBars) {
      const parent = workspace && name === currentView ? active : $(`view-${name}`)
      if (bar.parentElement !== parent) parent.prepend(bar)
    }
    agents?.layout(workspace)
    active.hidden = !active.childElementCount
    const hint = workspace && workspaceHints[currentView]
    $('workspace-empty').hidden = !hint
    if (hint) $('workspace-empty-title').textContent = hint
    updateNavigationVisibility(workspace)
    const selected = workspaceLists[currentView] ?? currentView
    for (const tab of $('tabs').querySelectorAll('button')) {
      if (tab.dataset.view === selected) tab.setAttribute('aria-current', 'page')
      else tab.removeAttribute('aria-current')
    }
  }

  function syncAgentList() {
    if (agentsEnabled && (inWorkspace() || AGENT_VIEWS.has(currentView))) agents?.enter()
    else agents?.leave()
  }

  const show = (name) => {
    if (name === currentView) return
    const previous = currentView
    if (previous === reselect?.view) reselect = null
    currentView = name
    if (previous === 'sessions') $('pc-tabs-status').hidden = true
    layout()
    if (previous === 'activity') activity.leave()
    if (previous === 'terminal') {
      setShellVisible(false)
      setCtrl(false)
    }
    if (previous === 'tab-terminal') {
      pcTabs.detach()
      setCtrl(false)
    }
    if (previous === 'chat' && name !== 'chat') agents?.closeChat()
    syncAgentList()
    if (terminalView(name)) {
      $(`view-${name}`).append($('keys'))
      setKeysVisible(name === 'terminal' && Boolean(shellId))
    }
    if (name === 'terminal') {
      setShellVisible(true)
      fitTerminal()
    }
    if (name === 'activity') activity.enter()
    if (name === 'tabs') pcTabs.enter()
  }

  let socket = null
  let terminal = null
  let fit = null
  let shellId = null
  let selectedSession = null
  let terminalName = ''
  let pendingOpen = null
  let openSequence = 0
  let isCtrlArmed = false
  let wasReady = false
  let reconnectAllowed = false
  let waitForWake = false
  let retryTimer = null
  let wakeTimer = null
  let retryCount = 0
  let savedView = null
  let reselect = null
  let forgetTicketOnReady = false
  const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]
  const RESUME_TIMEOUT_MS = 10000
  const CONNECT_FAILED = 'PC 의 ezShell 에 연결하지 못했습니다. ezShell 이 켜져 있고 잠금이 풀려 있는지, 원격 접속이 켜져 있는지, 이 휴대폰의 Tailscale 이 연결되어 있는지 확인하세요.'

  const readToken = () => {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  }
  const saveToken = (token) => {
    try {
      localStorage.setItem(TOKEN_KEY, token)
    } catch {
      // Private mode: the device has to be registered again next time
    }
  }

  // The resume ticket is kept as { ticket, expiresAt }; the server holds only its hash and the real expiry
  const readTrust = () => {
    try {
      const raw = localStorage.getItem(TRUST_KEY)
      if (!raw) return null
      const trust = JSON.parse(raw)
      return trust && typeof trust.ticket === 'string' && typeof trust.expiresAt === 'number' ? trust : null
    } catch {
      return null
    }
  }
  const saveTrust = (trust) => {
    try {
      if (trust && typeof trust.ticket === 'string') localStorage.setItem(TRUST_KEY, JSON.stringify({ ticket: trust.ticket, expiresAt: Number(trust.expiresAt) || 0 }))
      else localStorage.removeItem(TRUST_KEY)
    } catch {
      // Private mode: a code is needed on every connection, as before
    }
  }
  const clearTrust = () => saveTrust(null)

  const send = (message) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  function rememberView() {
    if (currentView === 'tabs' && reselect?.view === 'tabs') {
      savedView = { view: 'tab-terminal', tabId: reselect.id }
    } else if (currentView === 'agents' && reselect?.view === 'agents') {
      savedView = { view: 'chat', agent: reselect.agent }
    } else {
      savedView = { view: currentView, tabId: pcTabs.selectedId, agent: agents?.selectedAgent }
    }
    reselect = null
  }

  function restoreView() {
    const saved = savedView
    savedView = null
    if (!saved) return
    if (saved.view === 'terminal' && terminal) show('terminal')
    else if (PC_TAB_VIEWS.has(saved.view) && tabsEnabled) {
      if (saved.view === 'tab-terminal' && saved.tabId) reselect = { view: 'tabs', id: saved.tabId }
      show('tabs')
    } else if (AGENT_VIEWS.has(saved.view) && agentsEnabled) {
      if (saved.view === 'chat' && saved.agent) reselect = { view: 'agents', agent: saved.agent }
      show('agents')
    } else if (saved.view === 'activity') show('activity')
  }

  function cancelRetry() {
    clearTimeout(retryTimer)
    retryTimer = null
  }

  function canReconnect() {
    return reconnectAllowed && !waitForWake && !socket && !document.hidden
      && navigator.onLine !== false && retryCount < RETRY_DELAYS.length
  }

  function scheduleReconnect() {
    if (retryTimer !== null) return true
    if (!canReconnect() || !readToken() || !readTrust()) return false
    message('다시 접속하는 중…')
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!canReconnect()) return
      const token = readToken()
      const trust = readTrust()
      if (!token || !trust) return start()
      retryCount++
      connect(() => send({ type: 'resume', token, ticket: trust.ticket }), true)
    }, RETRY_DELAYS[retryCount])
    return true
  }

  function wake() {
    if (document.hidden) return
    waitForWake = false
    if (!socket) scheduleReconnect()
    else if (wasReady && socket.readyState === WebSocket.OPEN && wakeTimer === null) {
      // A suspended browser can still report OPEN after its network disappeared.
      const current = socket
      wakeTimer = setTimeout(() => {
        wakeTimer = null
        if (socket === current) current.close()
      }, RESUME_TIMEOUT_MS)
      send({ type: 'probe' })
    }
    fitViewport()
  }

  const ez = window.ezRemote
  const tree = ez.createSessionTree({ list: $('session-list'), filter: $('session-filter'), onOpen: (session) => openTerminal(session) })
  const approvals = ez.createApprovals({ send })
  const activity = ez.createActivity({ list: $('activity-list'), send })
  const push = ez.createPush({ button: $('push-toggle'), status: $('push-status'), send })
  const pcTabs = ez.createTabs({
    list: $('pc-tabs-list'), name: $('pc-tab-name'), notice: $('pc-tab-notice'), mode: $('pc-tab-mode'),
    viewport: $('pc-tab-viewport'), host: $('pc-tab-host'), send, show,
    createTerminal, onData: sendTerminalInput, setKeysVisible, onClose: () => show('tabs')
  })
  const agents = ez.createAgents?.({ list: $('view-agents'), chat: $('view-chat'), send, show })
  const workspaceBars = ['terminal', 'chat', 'activity'].map(name => [name, $(`view-${name}`).querySelector('.bar')])
    .filter(([, bar]) => bar)

  function message(text, { canRetry = false } = {}) {
    $('message-text').textContent = text
    $('message-retry').hidden = !canRetry
    show('message')
  }

  function signinError(text) {
    const box = $('signin-error')
    box.textContent = text
    box.hidden = !text
  }

  function setPcTabsEnabled(enabled, reason = 'PC에서 탭 이어 보기를 껐습니다.') {
    tabsEnabled = enabled
    $('tabs').querySelector('[data-view="tabs"]').hidden = !enabled
    const status = $('pc-tabs-status')
    if (enabled) {
      status.hidden = true
      return
    }
    if (PC_TAB_VIEWS.has(currentView)) {
      show('sessions')
      status.textContent = reason
      status.hidden = false
      send({ type: 'sessions' })
    }
    pcTabs.reset()
  }

  function updateFeatures(features) {
    agentsEnabled = Boolean(agents && features?.agents === true)
    const showNewTabs = !tabsEnabled && features?.tabs === true
    setPcTabsEnabled(features?.tabs === true)
    $('tabs').querySelector('[data-view="agents"]').hidden = !agentsEnabled
    if (!agentsEnabled && AGENT_VIEWS.has(currentView)) show('sessions')
    layout()
    if (showNewTabs && inWorkspace()) pcTabs.enter()
    syncAgentList()
  }

  function terminalColors(style) {
    const token = (name) => style.getPropertyValue(name).trim()
    return {
      background: token('--bg'), foreground: token('--text'),
      cursor: token('--terminal-cursor'), cursorAccent: token('--terminal-cursor-accent'),
      selectionBackground: token('--terminal-selection')
    }
  }

  function applyTheme(theme) {
    const root = document.documentElement
    let themed = false
    for (const key of THEME_VARIABLES) {
      const value = theme?.[key]
      // The server validates these values before sending them. Missing or removed tokens use CSS defaults.
      if (typeof value !== 'string' || !value) root.style.removeProperty(key)
      else {
        root.style.setProperty(key, value === '0' && key.endsWith('radius') ? '0px' : value)
        themed = true
      }
    }
    root.toggleAttribute('data-themed', themed)
    const colors = terminalColors(getComputedStyle(root))
    document.querySelector('meta[name="theme-color"]').content = colors.background
    if (terminal) terminal.options.theme = colors
    pcTabs.setTheme(colors)
  }

  // ---- Connection ----
  function connect(onOpen, resuming = false) {
    // HTTPS (a Tailscale certificate) needs the secure socket on the same name
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const next = new WebSocket(`${scheme}://${location.host}/ws`)
    let didOpen = false
    socket = next
    const deadline = resuming ? setTimeout(() => next.close(), RESUME_TIMEOUT_MS) : null
    next.addEventListener('open', () => {
      if (socket !== next) return
      didOpen = true
      onOpen()
    })
    next.addEventListener('message', (event) => {
      if (socket !== next) return
      clearTimeout(wakeTimer)
      wakeTimer = null
      const incoming = JSON.parse(event.data)
      if (incoming.type === 'ready' || incoming.type === 'error' || incoming.type === 'bye') clearTimeout(deadline)
      handle(incoming)
    })
    next.addEventListener('close', () => {
      clearTimeout(deadline)
      if (socket !== next) return
      socket = null
      clearTimeout(wakeTimer)
      wakeTimer = null
      const wasSignedIn = wasReady
      if (wasSignedIn) rememberView()
      wasReady = false
      endTerminal()
      approvals.reset()
      activity.reset()
      push.reset()
      pcTabs.reset()
      agents?.reset()
      if ((wasSignedIn || resuming) && scheduleReconnect()) return
      if (wasSignedIn || (resuming && reconnectAllowed)) message('연결이 끊겼습니다.', { canRetry: true })
      else if (!didOpen) {
        // Never reached the PC: said where the person is looking
        if (!$('view-signin').hidden) signinError(CONNECT_FAILED)
        else message(CONNECT_FAILED, { canRetry: true })
      }
    })
  }

  function handle(msg) {
    switch (msg.type) {
      case 'paired':
        saveToken(msg.token)
        history.replaceState(null, '', location.pathname)
        $('signin-note').textContent = '이 기기를 등록했습니다. 인증 앱의 6자리 코드를 입력하세요.'
        show('signin')
        $('signin-code').focus()
        break
      case 'trust':
        // Store the fresh ticket before opening the signed-in view.
        saveTrust(msg)
        break
      case 'ready':
        wasReady = true
        if (forgetTicketOnReady) clearTrust()
        forgetTicketOnReady = false
        reconnectAllowed = Boolean(readToken() && readTrust())
        retryCount = 0
        cancelRetry()
        $('device-name').textContent = msg.device
        $('workspace-device').textContent = msg.device
        applyTheme(msg.theme)
        tree.update(msg.folders, msg.sessions)
        tabsEnabled = false
        agentsEnabled = false
        show('sessions')
        updateFeatures(msg.features)
        restoreView()
        for (const request of Array.isArray(msg.approvals) ? msg.approvals : []) approvals.add(request)
        void push.setAvailability(msg.push)
        break
      case 'features':
        if (wasReady) {
          updateFeatures(msg.features)
          agents?.onMessage(msg)
        }
        break
      case 'theme':
        if (wasReady) applyTheme(msg.theme)
        break
      case 'sessions':
        tree.update(msg.folders, msg.sessions)
        break
      case 'approval':
        approvals.add(msg.request)
        break
      case 'approval-closed':
        approvals.closed(msg)
        break
      case 'approval-result':
        approvals.result(msg)
        break
      case 'activity':
        activity.setItems(msg.items)
        break
      case 'activity-item':
        activity.upsert(msg.item)
        break
      case 'activity-output':
        activity.output(msg.id, msg.parts)
        break
      case 'activity-stop-result':
        activity.stopResult(msg)
        break
      case 'tabs':
        if (typeof msg.error === 'string' && msg.error) {
          setPcTabsEnabled(false, msg.error)
          layout()
        } else {
          pcTabs.onMessage(msg)
          if (reselect?.view === 'tabs') {
            const tab = Array.isArray(msg.tabs) && msg.tabs.find(item => item?.id === reselect.id)
            reselect = null
            if (tab && currentView === 'tabs') pcTabs.reopen(tab)
          }
        }
        break
      case 'tab-attached':
      case 'tab-data':
      case 'tab-ended':
      case 'tab-error':
        pcTabs.onMessage(msg)
        break
      case 'push-result':
        push.result(msg)
        break
      case 'error':
        reconnectAllowed = false
        cancelRetry()
        // A stored ticket that no longer works (a day passed, or it did not match): forget it and ask for a code
        if (msg.code === 'trust-expired' || msg.code === 'bad-ticket') clearTrust()
        if (!readToken() || msg.code === 'unknown-device') message(msg.message)
        else {
          show('signin')
          signinError(msg.code === 'trust-expired' ? '' : msg.message)
          $('signin-code').value = ''
          $('signin-code').focus()
        }
        break
      case 'opened':
        if (pendingOpen && msg.requestId === pendingOpen) {
          shellId = msg.shellId
          pendingOpen = null
          $('terminal-state').textContent = ''
          updateShellActions()
          if (currentView === 'terminal') {
            setKeysVisible(true)
            fitTerminal()
            terminal.focus()
          } else setShellVisible(false)
        } else if (msg.shellId !== shellId) send({ type: 'close', shellId: msg.shellId })
        break
      case 'open-failed':
        if (pendingOpen && msg.requestId === pendingOpen) {
          pendingOpen = null
          updateShellActions()
          $('terminal-state').textContent = ''
          terminal.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`)
        }
        break
      case 'data':
        if (msg.shellId === shellId && terminal) terminal.write(msg.data)
        break
      case 'closed':
        if (msg.shellId === shellId) {
          endTerminal()
        }
        break
      case 'bye':
        if (wasReady) rememberView()
        wasReady = false
        reconnectAllowed = msg.code === 'idle'
        waitForWake = reconnectAllowed
        cancelRetry()
        message(msg.message, { canRetry: true })
        break
      default:
        if (msg.type === 'agents' || msg.type?.startsWith('chat-')) agents?.onMessage(msg)
        if (msg.type === 'agents' && reselect?.view === 'agents') {
          const { agent } = reselect
          const match = !msg.error && Array.isArray(msg.agents) && msg.agents.find(item => item?.shellId === agent.shellId
            && item.agentId === agent.agentId && item.kind === agent.kind)
          reselect = null
          if (match && currentView === 'agents') agents?.reopen(match)
        }
    }
  }

  // ---- Screens ----
  $('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('button[data-view]')
    if (!tab || tab.hidden || tab.dataset.view === currentView) return
    show(tab.dataset.view)
    if (tab.dataset.view === 'sessions') send({ type: 'sessions' })
  })
  $('sessions-refresh').addEventListener('click', () => send({ type: 'sessions' }))
  $('workspace-activity').addEventListener('click', () => show(currentView === 'activity' ? 'sessions' : 'activity'))
  $('pc-tabs-refresh').addEventListener('click', () => pcTabs.enter())
  $('pc-tab-back').addEventListener('click', () => show('tabs'))

  // ---- Terminal ----
  function fitTerminal() {
    if (currentView !== 'terminal' || !terminal || !fit) return
    try {
      fit.fit()
    } catch {
      return
    }
    if (shellId) send({ type: 'resize', shellId, cols: terminal.cols, rows: terminal.rows })
  }

  function openTerminal(session) {
    if (shellId || pendingOpen) {
      show('terminal')
      if (selectedSession === session.id) terminal?.focus()
      else $('terminal-state').textContent = '열린 셸을 종료한 뒤 다른 세션을 열 수 있습니다.'
      return
    }
    closeTerminal()
    selectedSession = session.id
    tree.select(selectedSession)
    terminalName = $('terminal-name').textContent = session.name
    $('terminal-state').textContent = '접속 중…'
    show('terminal')
    terminal = createTerminal()
    fit = new FitAddon.FitAddon()
    terminal.loadAddon(fit)
    terminal.open($('terminal-host'))
    try {
      fit.fit()
    } catch {
      // Sized again once the shell is open
    }
    terminal.onData((data) => { if (shellId) sendTerminalInput(data) })
    pendingOpen = `q${++openSequence}`
    updateShellActions()
    send({ type: 'open', requestId: pendingOpen, sessionId: session.id, cols: terminal.cols, rows: terminal.rows })
  }

  function createTerminal(options) {
    const style = getComputedStyle(document.documentElement)
    return new Terminal({
      fontSize: 13, fontFamily: style.getPropertyValue('--font-mono').trim(),
      cursorBlink: true, scrollback: 3000, minimumContrastRatio: 4.5, theme: terminalColors(style),
      ...options
    })
  }

  function closeTerminal() {
    if (shellId) send({ type: 'close', shellId })
    shellId = null
    selectedSession = null
    terminalName = ''
    tree.select(null)
    pendingOpen = null
    setCtrl(false)
    if (terminal) terminal.dispose()
    terminal = null
    fit = null
    $('terminal-host').textContent = ''
    updateShellActions()
  }

  function updateShellActions() {
    const hasShell = Boolean(shellId || pendingOpen)
    $('terminal-return').hidden = !hasShell
    $('terminal-return').textContent = hasShell ? `열린 셸 · ${terminalName}` : ''
    $('terminal-close').hidden = !hasShell
  }

  function setShellVisible(visible) {
    if (shellId) send({ type: 'shell-visible', shellId, visible })
  }

  function endTerminal() {
    if (!shellId && !pendingOpen) return
    shellId = null
    pendingOpen = null
    selectedSession = null
    tree.select(null)
    updateShellActions()
    if (currentView === 'terminal') setKeysVisible(false)
    $('terminal-state').textContent = '연결 종료됨'
    terminal?.write('\r\n\x1b[2m연결이 종료되었습니다.\x1b[0m\r\n')
  }

  function setCtrl(isOn) {
    isCtrlArmed = isOn
    $('keys').querySelector('[data-key="ctrl"]').setAttribute('aria-pressed', String(isOn))
  }

  function setKeysVisible(visible) {
    $('keys').hidden = !visible
    if (!visible) setCtrl(false)
  }

  function sendToTerminal(data) {
    if (!data) return
    if (currentView === 'tab-terminal') pcTabs.input(data)
    else if (currentView === 'terminal' && shellId) send({ type: 'input', shellId, data })
  }

  function sendTerminalInput(data) {
    // Ctrl from the key row turns the next letter into its control character.
    if (isCtrlArmed && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0)
      setCtrl(false)
      if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64)
    }
    sendToTerminal(data)
  }

  const KEYS = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' }
  $('keys').addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button || $('keys').hidden) return
    if (button.dataset.key === 'ctrl') setCtrl(!isCtrlArmed)
    else sendToTerminal(KEYS[button.dataset.key] ?? button.dataset.text ?? '')
    if (currentView === 'tab-terminal') pcTabs.focus()
    else terminal?.focus()
  })
  // A tap on the key row must not take the keyboard away from the terminal
  $('keys').addEventListener('mousedown', (event) => event.preventDefault())

  $('terminal-back').addEventListener('click', () => {
    show('sessions')
    send({ type: 'sessions' })
  })
  $('terminal-return').addEventListener('click', () => show('terminal'))
  $('terminal-close').addEventListener('click', () => {
    closeTerminal()
    show('sessions')
  })
  function fitViewport() {
    const viewport = window.visualViewport
    const style = document.documentElement.style
    keyboardOpen = false
    if (viewport?.height > 0 && (viewport.scale ?? 1) === 1) {
      style.setProperty('--visible-height', `${Math.floor(viewport.height)}px`)
      style.setProperty('--visible-top', `${Math.floor(viewport.offsetTop || 0)}px`)
      keyboardOpen = viewport.height < window.innerHeight * 0.75
    } else {
      style.removeProperty('--visible-height')
      style.removeProperty('--visible-top')
    }
    if (keyboardOpen) style.setProperty('--tab-safe-bottom', '0px')
    else style.removeProperty('--tab-safe-bottom')
    updateNavigationVisibility()
    fitTerminal()
  }
  window.addEventListener('resize', fitViewport)
  workspaceSize.addEventListener('change', () => {
    layout()
    syncAgentList()
    if (inWorkspace() && tabsEnabled) pcTabs.enter()
    fitTerminal()
  })
  window.visualViewport?.addEventListener('resize', fitViewport)
  window.visualViewport?.addEventListener('scroll', fitViewport)
  if (window.visualViewport) fitViewport()
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelRetry()
      clearTimeout(wakeTimer)
      wakeTimer = null
    }
    else wake()
  })
  window.addEventListener('online', wake)
  window.addEventListener('pageshow', event => { if (event.persisted) wake() })

  // ---- Start ----
  $('signin-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const code = $('signin-code').value.trim()
    if (!/^\d{6}$/.test(code)) return signinError('6자리 숫자를 입력하세요.')
    signinError('')
    const token = readToken()
    const remember = $('signin-remember').checked
    forgetTicketOnReady = !remember
    const payload = { type: 'signin', token, code, remember }
    if (socket && socket.readyState === WebSocket.OPEN) send(payload)
    else connect(() => send(payload))
  })
  $('message-retry').addEventListener('click', start)

  function start() {
    if (socket) return
    cancelRetry()
    retryCount = 0
    waitForWake = false
    reconnectAllowed = false
    const pairCode = new URLSearchParams(location.hash.slice(1)).get('pair')
    const token = readToken()
    signinError('')
    $('signin-code').value = ''
    if (pairCode) {
      message('이 기기를 등록하는 중…')
      connect(() => send({ type: 'pair', code: pairCode, name: deviceName() }))
    } else if (token) {
      const trust = readTrust()
      // The PC checks expiry using the same clock that issued the ticket.
      if (trust) {
        reconnectAllowed = true
        message('접속하는 중…')
        connect(() => send({ type: 'resume', token, ticket: trust.ticket }), true)
      } else {
        $('signin-note').textContent = '인증 앱의 6자리 코드를 입력하세요.'
        show('signin')
        $('signin-code').focus()
      }
    } else {
      message('이 기기는 등록되어 있지 않습니다. PC 의 ezShell 설정 > 원격 접속에서 QR 을 찍어 등록하세요.')
    }
  }

  /** A short name for the list of devices on the PC */
  function deviceName() {
    const agent = navigator.userAgent
    const model = /iPhone|iPad|Android|Windows|Macintosh|Linux/.exec(agent)
    const browser = /Edg|Chrome|Firefox|Safari/.exec(agent)
    return [model ? model[0] : '기기', browser ? browser[0].replace('Edg', 'Edge') : ''].filter(Boolean).join(' · ')
  }

  start()
})()
