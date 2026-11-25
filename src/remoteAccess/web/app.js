// The phone page of ezShell's remote access: register once (the address carries a one-time code),
// sign in with the authenticator's code, pick a session, use its terminal; answer MCP approval
// requests (approvals.js), watch MCP activity (activity.js), follow PC tabs and agent chats.
// Plain script (no build step): served as it is by src/remoteAccess/server.js.
(() => {
  'use strict'
  const TOKEN_KEY = 'ezshell-device-token'
  // A ticket from a code sign-in that lets this device resume without a code for a day
  const TRUST_KEY = 'ezshell-device-trust'
  const SIDEBAR_KEY = 'ezshell-workspace-sidebar'
  const GENERAL = { id: 'general', name: '일반' }
  const $ = (id) => document.getElementById(id)
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  const views = ['signin', 'message', 'activity', 'chat', 'terminal', 'tab-terminal']
  const tabViews = { ssh: 'terminal', pc: 'tab-terminal', chat: 'chat' }
  const tabIcons = { ssh: '>_', pc: '▣', chat: '◉', browser: '▤' }
  const workspaceSize = window.matchMedia('(min-width: 45rem) and (min-height: 40rem)')
  const portrait = window.matchMedia('(orientation: portrait)')
  let tabletLayout = workspaceSize.matches
  let stackedPanes = portrait.matches
  let currentView = null
  let tabsEnabled = false
  let agentsEnabled = false
  let keyboardOpen = false
  let keyboardBaseline = 0
  let viewportWidth = 0
  let drawerOpen = false
  let openTabs = []
  let activeGroup = GENERAL.id
  let groupPanes = new Map()
  let frontTab = null
  let viewer = null
  let splitTab = null
  let secondFocused = false
  let splitRatio = 50
  let secondary = null
  let secondaryViewer = null
  let agentList = null
  const sidebar = readSidebar()
  const approvalIds = new Set()
  const pcSessionTabs = { connected: 0, lost: 0 }
  let pcTabCount = 0
  let workingAgents = 0
  let hasProjectServers = false
  const workTabs = () => openTabs.filter(tab => tab.group.id === activeGroup)
  const groupOf = item => typeof item?.id === 'string' && item.id && item.id !== GENERAL.id && typeof item.name === 'string' && item.name ? item : GENERAL
  const terminalView = view => view === 'terminal' || view === 'tab-terminal'
  const isWorkspace = () => wasReady && currentView !== 'signin' && currentView !== 'message'
  const splitVisible = () => isWorkspace() && currentView !== 'activity' && tabletLayout && Boolean(splitTab)
  const focusedPane = () => splitTab && secondFocused ? 1 : 0
  const focusedTab = () => focusedPane() === 1 ? splitTab : frontTab
  const primaryTab = () => tabletLayout ? frontTab : focusedTab()
  const activeShell = () => currentView === 'terminal' ? primaryTab() : null

  function layout() {
    const signedIn = isWorkspace()
    const wide = signedIn && tabletLayout
    const collapsed = wide && sidebar.collapsed
    const showDrawer = signedIn && !wide && drawerOpen
    document.body.toggleAttribute('data-remote-workspace', signedIn)
    document.body.toggleAttribute('data-workspace', wide)
    document.body.toggleAttribute('data-sidebar-collapsed', collapsed)
    document.body.toggleAttribute('data-keyboard', keyboardOpen)
    views.forEach(view => { $(`view-${view}`).hidden = view !== currentView })
    $('workspace-sidebar').hidden = !wide && !showDrawer
    $('workspace-sidebar-toggle').hidden = !wide
    $('workspace-sidebar-summary').hidden = !collapsed
    $('workspace-sidebar-divider').hidden = !wide || collapsed
    const sidebarToggle = $('workspace-sidebar-toggle')
    const sidebarAction = collapsed ? '사이드바 펼치기' : '사이드바 접기'
    sidebarToggle.textContent = collapsed ? '›' : '‹'
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed))
    sidebarToggle.setAttribute('aria-label', sidebarAction)
    sidebarToggle.title = sidebarAction
    $('workspace-scrim').hidden = !showDrawer
    $('workspace-menu').hidden = !signedIn || wide
    $('workspace-menu').setAttribute('aria-expanded', String(showDrawer))
    $('view-sessions').hidden = !signedIn || collapsed
    $('view-agents').hidden = !signedIn || collapsed || (!agentsEnabled && !agents?.hasReviewTabs && !hasProjectServers)
    $('view-tabs').hidden = !signedIn || collapsed || !tabsEnabled
    $('workspace-header').hidden = !signedIn
    $('workspace-tabs').hidden = !signedIn || workTabs().length === 0
    $('workspace-content').hidden = !signedIn
    $('workspace-content').inert = showDrawer
    $('workspace-status').hidden = !signedIn || keyboardOpen
    $('workspace-activity').setAttribute('aria-pressed', String(currentView === 'activity'))
    const blank = currentView === 'workspace'
    const tab = primaryTab()
    $('workspace-empty').hidden = !signedIn || !blank
    if (blank) {
      $('workspace-empty-title').textContent = tab?.waiting ? '목록을 확인하는 중…'
        : tab ? 'PC에서 이 항목의 공유가 종료되었습니다.'
          : collapsed ? '사이드바를 펼쳐 열 작업을 선택하세요.' : '목록에서 열 작업을 선택하세요.'
    }
    layoutSplit()
  }

  const show = (name) => {
    const previous = currentView
    currentView = name
    layout()
    if (name === previous) return
    if (previous === 'activity') activity.leave()
    setKeysVisible(false)
    if (terminalView(name)) {
      $(`view-${name}`).append($('keys'))
    }
    if (name === 'activity') activity.enter()
  }

  let socket = null
  let openSequence = 0
  let isCtrlArmed = false
  let wasReady = false
  let reconnectAllowed = false
  let waitForWake = false
  let retryTimer = null
  let wakeTimer = null
  let retryCount = 0
  let savedView = null
  let signingIn = false
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
  function readSidebar() {
    try {
      const saved = JSON.parse(localStorage.getItem(SIDEBAR_KEY))
      return {
        collapsed: saved?.collapsed === true,
        width: Number.isFinite(saved?.width) ? Math.max(172, Math.min(420, saved.width)) : null
      }
    } catch {
      return { collapsed: false, width: null }
    }
  }

  function saveSidebar() {
    try { localStorage.setItem(SIDEBAR_KEY, JSON.stringify(sidebar)) } catch {
      // Use the current size until the page closes if storage is unavailable.
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
    const groups = new Map(groupPanes).set(activeGroup, paneState())
    savedView = { tabs: [...openTabs], activeGroup, groups, activity: currentView === 'activity' }
    if (viewer?.type === 'chat') viewer.draft = agents.draft
    if (secondaryViewer?.type === 'chat') secondaryViewer.draft = secondary.chat.draft
  }

  function restoreView() {
    const saved = savedView
    savedView = null
    if (!saved) return
    openTabs = saved.tabs.filter(tab => tab.type === 'ssh' || (tab.type === 'pc' ? tabsEnabled : agentsEnabled))
    for (const tab of openTabs) {
      if (tab.type !== 'ssh') tab.waiting = true
    }
    groupPanes = saved.groups
    activeGroup = saved.activeGroup
    restorePanes()
    recoverActiveGroup()
    if (saved.activity) show('activity')
    refreshWorkspace()
  }

  function discardSavedView() {
    for (const tab of savedView?.tabs ?? []) {
      tab.terminal?.dispose()
      tab.host?.remove()
    }
    savedView = null
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
  let terminalPresentation = { ...ez.theme.terminalOptions(), fontFamily: 'ui-monospace, monospace' }
  let fontRequest = 0
  const tree = ez.createSessionTree({ list: $('session-list'), filter: $('session-filter'), onOpen: (session) => openTerminal(session) })
  const approvals = ez.createApprovals({ send })
  const activity = ez.createActivity({ list: $('activity-list'), send })
  const push = ez.createPush({ button: $('push-toggle'), status: $('push-status'), send })
  const pcTabs = ez.createTabs({
    list: $('pc-tabs-list'), name: $('pc-tab-name'), notice: $('pc-tab-notice'), mode: $('pc-tab-mode'),
    viewport: $('pc-tab-viewport'), host: $('pc-tab-host'), send,
    createTerminal, onData: data => sendTerminalInput(data, primaryTab()), setKeysVisible, onOpen: openPcTab
  })
  const secondaryViews = ['workspace-empty', 'view-terminal', 'view-tab-terminal', 'view-chat'].map(id => $(id).cloneNode(true))
  const agents = ez.createAgents({
    list: $('view-agents'), chat: $('view-chat'), send, onOpen: openChat, openReview: openPcTab, openServer: openTerminal
  })

  function createSecondary() {
    const pane = $('workspace-secondary')
    for (const clone of secondaryViews) {
      clone.id += '-split'
      for (const node of clone.querySelectorAll('[id]')) node.id += '-split'
      for (const label of clone.querySelectorAll('label[for]')) label.htmlFor += '-split'
      pane.append(clone)
    }
    const find = id => $(`${id}-split`)
    find('workspace-empty-open')?.remove()
    // The extra key row follows the terminal type that occupies this pane.
    if (!find('keys')) {
      const keys = $('keys').cloneNode(true)
      keys.id = 'keys-split'
      find('view-terminal').append(keys)
    }
    const pc = ez.createTabs({
      name: find('pc-tab-name'), notice: find('pc-tab-notice'), mode: find('pc-tab-mode'),
      viewport: find('pc-tab-viewport'), host: find('pc-tab-host'), send, find, createTerminal,
      onData: data => sendTerminalInput(data, splitTab),
      setKeysVisible: visible => { find('keys').hidden = !visible },
      onOpen: openPcTab
    })
    const chat = ez.createAgents({
      list: document.createElement('section'), chat: find('view-chat'),
      send: message => { if (message.type !== 'agents-list' && message.type !== 'agents-watch') send(message) },
      onOpen: openChat, openReview: openPcTab
    })
    pc.setAgentsEnabled?.(agentsEnabled)
    if (agentsEnabled) chat.enter()
    if (agentList) chat.onMessage(agentList)
    bindKeys(find('keys'), () => splitTab, pc, true)
    find('terminal-close').addEventListener('click', () => removeTabs(tab => tab === splitTab))
    find('terminal-reopen').addEventListener('click', () => reopenShell(splitTab))
    return { find, pc, chat }
  }

  function pauseSecondary() {
    if (secondaryViewer?.type === 'pc') secondary.pc.detach()
    if (secondaryViewer?.type === 'chat') {
      secondaryViewer.draft = secondary.chat.draft
      secondary.chat.closeChat()
    }
    secondaryViewer = null
  }

  function layoutSplit() {
    const showSplit = splitVisible()
    $('workspace-secondary').hidden = !showSplit
    $('workspace-split-divider').hidden = !showSplit
    splitRoot.toggleAttribute('data-split', showSplit)
    splitRoot.setAttribute('data-split-axis', stackedPanes ? 'rows' : 'columns')
    splitRoot.style.setProperty('--split-size', `${splitRatio}%`)
    splitDivider.setAttribute('aria-orientation', stackedPanes ? 'horizontal' : 'vertical')
    splitDivider.setAttribute('aria-valuenow', String(splitRatio))
    $('workspace-primary').toggleAttribute('data-focused', showSplit && !secondFocused)
    $('workspace-secondary').toggleAttribute('data-focused', showSplit && secondFocused)
    if (!showSplit) {
      pauseSecondary()
      for (const host of secondary?.find('terminal-host').children ?? []) host.hidden = true
      return
    }
    secondary ??= createSecondary()
    const { find, pc, chat } = secondary
    const tab = splitTab
    if (secondaryViewer && secondaryViewer !== tab) pauseSecondary()
    const available = !tab.waiting && !tab.unavailable
    const view = available ? tabViews[tab.type] : null
    for (const kind of Object.values(tabViews)) find(`view-${kind}`).hidden = kind !== view
    find('workspace-empty').hidden = Boolean(view)
    if (!view) {
      if (secondaryViewer === tab) pauseSecondary()
      find('workspace-empty-title').textContent = tab.waiting ? '목록을 확인하는 중…' : 'PC에서 이 항목의 공유가 종료되었습니다.'
      return
    }
    if (terminalView(view) && find('keys').parentElement !== find(`view-${view}`)) find(`view-${view}`).append(find('keys'))
    if (view === 'terminal') renderShell(tab, find)
    if (!secondaryViewer && tab.type !== 'ssh' && !document.hidden) {
      secondaryViewer = tab
      if (tab.type === 'pc') pc.reopen(tab.item)
      else chat.reopen(tab.item, tab.draft)
    }
  }

  function message(text, { canRetry = false, canPair = false } = {}) {
    $('message-text').textContent = text
    $('message-retry').hidden = !canRetry
    $('pair-link-form').hidden = !standalone || !canPair
    $('pair-link-error').hidden = true
    show('message')
  }

  function signinError(text) {
    const box = $('signin-error')
    box.textContent = text
    box.hidden = !text
  }

  function setPcTabsEnabled(enabled, reason = 'PC에서 탭 이어 보기를 껐습니다.') {
    const changed = enabled !== tabsEnabled
    tabsEnabled = enabled
    if (enabled) {
      $('pc-tabs-status').hidden = true
      if (changed) pcTabs.enter()
      return
    }
    if (changed) {
      $('pc-tabs-status').textContent = reason
      $('pc-tabs-status').hidden = false
    }
    pcTabCount = 0
    removeTabs(tab => tab.type === 'pc')
    pcTabs.reset()
    secondary?.pc.reset()
    agents.setReviewTabs([])
    renderStatus()
  }

  function updateFeatures(features) {
    agentsEnabled = features?.agents === true
    pcTabs.setAgentsEnabled?.(agentsEnabled)
    secondary?.pc.setAgentsEnabled?.(agentsEnabled)
    setPcTabsEnabled(features?.tabs === true)
    if (agentsEnabled) {
      agents.enter()
      secondary?.chat.enter()
    }
    else {
      removeTabs(tab => tab.type === 'chat')
      agents.leave()
      secondary?.chat.leave()
      agentList = null
      workingAgents = 0
    }
    layout()
    renderStatus()
  }

  function applyTheme(theme) {
    ez.theme.set(theme)
    updateTerminalPresentation()
  }

  function updateTerminalPresentation() {
    const next = ez.theme.terminalOptions()
    const request = ++fontRequest
    const update = fontFamily => {
      const fontChanged = terminalPresentation.fontFamily !== fontFamily
      terminalPresentation = { theme: next.theme, fontFamily }
      for (const tab of openTabs) if (tab.terminal) Object.assign(tab.terminal.options, terminalPresentation)
      pcTabs.setTerminalOptions(terminalPresentation)
      secondary?.pc.setTerminalOptions(terminalPresentation)
      if (fontChanged) fitTerminal()
    }
    const font = `13px ${next.fontFamily}`
    const sample = 'A한'
    if (!document.fonts || document.fonts.check(font, sample)) {
      update(next.fontFamily)
      return
    }
    // xterm measures cells when the family changes. Wait for bundled fonts before doing that.
    update(terminalPresentation.fontFamily)
    const useFont = () => { if (request === fontRequest) update(next.fontFamily) }
    void document.fonts.load(font, sample).then(useFont, useFont)
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
      signingIn = false
      clearTimeout(wakeTimer)
      wakeTimer = null
      const wasSignedIn = wasReady
      if (wasSignedIn) rememberView()
      wasReady = false
      endShells()
      openTabs = []
      groupPanes.clear()
      activeGroup = GENERAL.id
      viewer = null
      frontTab = null
      secondaryViewer = null
      splitTab = null
      secondFocused = false
      splitRatio = 50
      agentList = null
      hasProjectServers = false
      drawerOpen = false
      approvalIds.clear()
      pcTabCount = 0
      workingAgents = 0
      approvals.reset()
      activity.reset()
      push.reset()
      pcTabs.reset()
      agents.reset()
      secondary?.pc.reset()
      secondary?.chat.reset()
      if ((wasSignedIn || resuming) && scheduleReconnect()) return
      if (wasSignedIn || (resuming && reconnectAllowed)) message('연결이 끊겼습니다.', { canRetry: true })
      else if (!didOpen) {
        // Never reached the PC: said where the person is looking
        if (!$('view-signin').hidden) signinError(CONNECT_FAILED)
        else message(CONNECT_FAILED, { canRetry: true, canPair: !readToken() })
      }
    })
  }

  function handle(msg) {
    switch (msg.type) {
      case 'paired':
        discardSavedView()
        saveToken(msg.token)
        clearTrust()
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
        signingIn = false
        wasReady = true
        if (forgetTicketOnReady) clearTrust()
        forgetTicketOnReady = false
        reconnectAllowed = Boolean(readToken() && readTrust())
        retryCount = 0
        cancelRetry()
        $('workspace-device').textContent = msg.device
        updateSessions(msg)
        tabsEnabled = false
        agentsEnabled = false
        show('workspace')
        updateFeatures(msg.features)
        restoreView()
        applyTheme(msg.theme)
        for (const request of Array.isArray(msg.approvals) ? msg.approvals : []) addApproval(request)
        void push.setAvailability(msg.push)
        break
      case 'features':
        if (wasReady) {
          updateFeatures(msg.features)
          agents.onMessage(msg)
          secondary?.chat.onMessage(msg)
        }
        break
      case 'theme':
        if (wasReady) applyTheme(msg.theme)
        break
      case 'sessions':
        updateSessions(msg)
        layout()
        renderGroupSelectors()
        break
      case 'approval':
        addApproval(msg.request)
        break
      case 'approval-closed':
        approvals.closed(msg)
        approvalIds.delete(msg.id)
        renderStatus()
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
        if (msg.error) {
          setPcTabsEnabled(false, msg.error)
          layout()
        } else if (tabsEnabled) {
          pcTabCount = Array.isArray(msg.tabs) ? msg.tabs.filter(tab => typeof tab?.id === 'string').length : 0
          pcTabs.onMessage(msg)
          secondary?.pc.onMessage(msg)
          agents.setReviewTabs(msg.tabs)
          syncTabs('pc', msg.tabs, pcKey)
          layout()
        }
        break
      case 'tab-attached':
      case 'tab-data':
      case 'tab-ended':
      case 'tab-error':
      case 'browser-opened':
      case 'browser-image':
      case 'browser-result':
      case 'browser-ended':
        pcTabs.onMessage(msg)
        secondary?.pc.onMessage(msg)
        break
      case 'push-result':
        push.result(msg)
        break
      case 'error':
        signingIn = false
        reconnectAllowed = false
        cancelRetry()
        // A stored ticket that no longer works (a day passed, or it did not match): forget it and ask for a code
        if (msg.code === 'trust-expired' || msg.code === 'bad-ticket') clearTrust()
        if (!readToken() || msg.code === 'unknown-device' || msg.code === 'pair-failed') {
          discardSavedView()
          message(msg.message, { canPair: true })
        }
        else {
          show('signin')
          signinError(msg.code === 'trust-expired' ? '' : msg.message)
          $('signin-code').value = ''
          $('signin-code').focus()
        }
        break
      case 'opened':
        shellOpened(msg)
        break
      case 'open-failed':
        {
          const tab = openTabs.find(tab => tab.pending && tab.pending === msg.requestId)
          if (tab) endShell(tab, msg.message || '연결하지 못했습니다.')
        }
        break
      case 'data':
        shellOf(msg.shellId)?.terminal.write(msg.data)
        break
      case 'closed':
        {
          const tab = shellOf(msg.shellId)
          if (tab) endShell(tab)
        }
        break
      case 'bye':
        signingIn = false
        if (wasReady && msg.code === 'idle') rememberView()
        else {
          discardSavedView()
          removeTabs(() => true)
        }
        wasReady = false
        reconnectAllowed = msg.code === 'idle'
        waitForWake = reconnectAllowed
        cancelRetry()
        message(msg.message, { canRetry: true })
        break
      case 'agents':
        if (agentsEnabled) {
          const listed = !msg.error && Array.isArray(msg.agents) ? msg.agents
            .filter(agent => typeof agent?.shellId === 'string')
            .map(({ role, ...agent }) => ({
              ...agent,
              // The server supplies the desktop provider name and number. The role only decorates that label.
              name: [typeof role === 'string' ? role.trim() : '', agent.name || agent.agentId || '에이전트'].filter(Boolean).join(' · ')
            })) : []
          agentList = { ...msg, agents: listed }
          agents.onMessage(agentList)
          secondary?.chat.onMessage(agentList)
          workingAgents = listed.filter(agent => agent.status === 'working' && !agent.waitingApproval).length
          syncTabs('chat', listed, chatKey)
        }
        break
      default:
        if (msg.type?.startsWith('chat-')) {
          agents.onMessage(msg)
          secondary?.chat.onMessage(msg)
        }
    }
  }

  // ---- Screens ----
  function setDrawer(open, focusMenu = false) {
    drawerOpen = open && isWorkspace() && !tabletLayout
    layout()
    if (drawerOpen) $('workspace-sidebar').focus({ preventScroll: true })
    else if (focusMenu) $('workspace-menu').focus()
  }

  $('workspace-menu').addEventListener('click', () => setDrawer(!drawerOpen))
  $('workspace-sidebar-toggle').addEventListener('click', () => {
    sidebar.collapsed = !sidebar.collapsed
    saveSidebar()
    layout()
    fitTerminal()
  })
  for (const id of ['session', 'agent', 'pc', 'approval']) {
    $(`sidebar-${id}-status`).addEventListener('click', () => {
      $('workspace-sidebar-toggle').click()
      $('workspace-sidebar-toggle').focus({ preventScroll: true })
    })
  }
  $('workspace-scrim').addEventListener('click', () => setDrawer(false, true))
  $('workspace-empty-open').addEventListener('click', () => setDrawer(true))
  document.addEventListener('keydown', event => {
    if (drawerOpen && event.key === 'Escape') setDrawer(false, true)
  })
  document.addEventListener('keydown', event => {
    const tabs = workTabs()
    if (!isWorkspace() || !tabs.length || approvals.isOpen || !event.ctrlKey || event.altKey || event.metaKey) return
    const tab = focusedTab()
    if (event.key.toLowerCase() === 'w' && !event.shiftKey) {
      if (!tab || event.target?.closest?.('.xterm')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      removeTabs(item => item === tab)
      focusedTab()?.button.focus({ preventScroll: true })
      return
    }
    let target
    if (event.key === 'Tab') {
      const step = event.shiftKey ? -1 : 1
      target = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length]
    } else if (!event.shiftKey && /^[1-9]$/.test(event.key)) target = tabs[Number(event.key) - 1]
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    selectTab(target)
    target.button?.focus({ preventScroll: true })
  }, true)
  let edgeTouch = null
  document.addEventListener('touchstart', event => {
    const touch = event.touches.length === 1 ? event.touches[0] : null
    edgeTouch = touch && !tabletLayout && isWorkspace() && touch.clientX <= 24
      ? { x: touch.clientX, y: touch.clientY } : null
  }, { passive: true })
  document.addEventListener('touchend', event => {
    const start = edgeTouch
    edgeTouch = null
    const end = event.changedTouches[0]
    if (start && end && end.clientX - start.x > 64 && Math.abs(end.clientY - start.y) < 40) setDrawer(true)
  }, { passive: true })
  document.addEventListener('touchcancel', () => { edgeTouch = null }, { passive: true })

  $('sessions-refresh').addEventListener('click', () => send({ type: 'sessions' }))
  $('workspace-activity').addEventListener('click', () => {
    setDrawer(false)
    if (currentView === 'activity') {
      renderWorkspace()
    }
    else {
      pauseViewer()
      pauseSecondary()
      show('activity')
      renderTabs()
    }
  })
  $('pc-tabs-refresh').addEventListener('click', () => pcTabs.enter())
  function bindDivider(element, size, resize, reset, done = () => {}, vertical = () => false) {
    let drag = null
    const coordinate = (event) => vertical() ? event.clientY : event.clientX
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      drag = { start: coordinate(event), size: size(), id: event.pointerId }
      element.setPointerCapture(event.pointerId)
    })
    element.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId) resize(drag.size + coordinate(event) - drag.start)
    })
    element.addEventListener('lostpointercapture', () => {
      if (!drag) return
      drag = null
      done()
    })
    element.addEventListener('dblclick', () => {
      reset()
      done()
    })
    element.addEventListener('keydown', event => {
      const [back, forward] = vertical() ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
      const delta = event.key === back ? -16 : event.key === forward ? 16 : 0
      if (!delta) return
      event.preventDefault()
      resize(size() + delta)
      done()
    })
  }

  function applySidebarWidth() {
    const style = document.documentElement.style
    if (sidebar.width === null) style.removeProperty('--preferred-sidebar-width')
    else style.setProperty('--preferred-sidebar-width', `${sidebar.width}px`)
    fitTerminal()
  }

  const sidebarNode = $('workspace-sidebar')
  bindDivider($('workspace-sidebar-divider'), () => sidebarNode.getBoundingClientRect().width, width => {
    sidebar.width = Math.round(Math.max(172, Math.min(420, width)))
    applySidebarWidth()
  }, () => {
    sidebar.width = null
    applySidebarWidth()
  }, saveSidebar)
  const splitRoot = $('workspace-content')
  const splitDivider = $('workspace-split-divider')
  const axisSize = (element) => element.getBoundingClientRect()[stackedPanes ? 'height' : 'width']
  const sizeSplit = (ratio) => {
    splitRatio = Math.round(Math.max(25, Math.min(75, ratio)) * 10) / 10
    splitRoot.style.setProperty('--split-size', `${splitRatio}%`)
    splitDivider.setAttribute('aria-valuenow', String(splitRatio))
    fitTerminal()
    revealPaneTabs()
  }
  bindDivider(splitDivider, () => axisSize($('workspace-primary')), size => {
    const total = axisSize(splitRoot)
    if (total && splitVisible()) sizeSplit(100 * size / total)
  }, () => sizeSplit(50), undefined, () => stackedPanes)

  for (const [id, isSecondary] of [['workspace-primary', false], ['workspace-secondary', true]]) {
    for (const type of ['pointerdown', 'focusin']) $(id).addEventListener(type, event => {
      if (event.target?.closest?.('.workspace-group-select')) return
      if (splitVisible() && secondFocused !== isSecondary) setPaneFocus(isSecondary)
    })
  }

  // Each visible pane subscribes to its selected tab only.
  const pcKey = item => JSON.stringify([item.id, item.kind || 'terminal'])
  const chatKey = item => JSON.stringify([item.shellId, item.agentId, item.kind])
  const strips = [$('workspace-current'), $('workspace-current-split')]
  const groupSelectors = [$('workspace-group-select'), $('workspace-group-select-split')]
  const tabFadeWidth = 28
  const tabWidths = window.ResizeObserver ? new window.ResizeObserver(revealPaneTabs) : null
  for (const strip of strips) {
    tabWidths?.observe(strip)
    strip.addEventListener('scroll', () => updateStripOverflow(strip), { passive: true })
    strip.addEventListener('wheel', event => {
      if (event.ctrlKey || event.deltaX || !event.deltaY || strip.scrollWidth <= strip.clientWidth) return
      event.preventDefault()
      strip.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : 1)
    }, { passive: false })
  }

  function updateSessions({ folders, sessions, linkedProjects }) {
    tree.update(folders, sessions)
    const projects = Array.isArray(linkedProjects)
      ? linkedProjects.filter(project => typeof project?.id === 'string' && Array.isArray(project.servers) && project.servers.length) : []
    hasProjectServers = projects.length > 0
    agents.setProjectServers?.(projects)
    const labels = new Map(projects.map(project => [project.id, project.name]))
    for (const tab of openTabs) {
      const name = labels.get(tab.group.id)
      if (tab.type === 'ssh' && name) tab.group = { id: tab.group.id, name }
    }
    pcSessionTabs.connected = 0
    pcSessionTabs.lost = 0
    for (const session of Array.isArray(sessions) ? sessions : []) {
      pcSessionTabs.connected += Number(session.openTabs?.connected) || 0
      pcSessionTabs.lost += Number(session.openTabs?.disconnected) || 0
    }
    renderStatus()
  }

  function renderRailItem(id, counts, detail) {
    const labels = []
    for (const [badgeId, label, count] of counts) {
      const badge = $(badgeId)
      badge.hidden = count <= 0
      badge.textContent = String(count)
      badge.title = count > 0 ? `${label} ${count}개` : ''
      if (count > 0) labels.push(badge.title)
    }
    const item = $(id)
    item.hidden = labels.length === 0
    if (detail) labels.push(detail)
    item.title = labels.join(' · ')
    item.setAttribute('aria-label', item.title)
  }

  function renderStatus() {
    let shells = 0
    let lostShells = 0
    for (const tab of openTabs) {
      if (tab.shellId) shells++
      else if (tab.type === 'ssh' && tab.ended) lostShells++
    }
    $('workspace-shell-count').textContent = `셸 ${shells}`
    $('workspace-approval-count').textContent = `MCP 대기 ${approvalIds.size}`
    $('workspace-working-count').textContent = `작업 중 ${workingAgents}`
    renderRailItem('sidebar-session-status', [
      ['sidebar-session-connected', '연결된 세션 탭', pcSessionTabs.connected + shells],
      ['sidebar-session-lost', '끊긴 세션 탭', pcSessionTabs.lost + lostShells]
    ])
    renderRailItem('sidebar-agent-status', [['sidebar-agent-count', '로컬 작업 에이전트', agentList?.agents.length ?? 0]],
      workingAgents > 0 ? `작업 중 ${workingAgents}개` : '')
    if (workingAgents > 0) $('sidebar-agent-status').dataset.agentWork = 'working'
    else delete $('sidebar-agent-status').dataset.agentWork
    renderRailItem('sidebar-pc-status', [['sidebar-pc-count', '공유된 PC 탭', pcTabCount]])
    renderRailItem('sidebar-approval-status', [['sidebar-approval-count', 'MCP 대기', approvalIds.size]])
  }

  function addApproval(request) {
    if (typeof request?.id === 'string') {
      approvalIds.add(request.id)
      closeContextMenu()
      clearPress()
    }
    approvals.add(request)
    renderStatus()
  }

  function renderTabs() {
    const tabs = workTabs()
    for (const strip of strips) {
      for (const row of [...strip.children]) {
        if (!tabs.some(tab => tab.row === row)) {
          tabWidths?.unobserve(row)
          row.remove()
        }
      }
    }
    const two = splitVisible()
    const counts = [0, 0]
    for (const tab of tabs) {
      if (!tab.row) {
        tab.row = document.createElement('div')
        tab.row.className = 'terminal-tab workspace-tab'
        tab.row.dataset.type = tab.item?.kind === 'browser' ? 'browser' : tab.type
        tab.button = document.createElement('button')
        tab.button.type = 'button'
        tab.button.className = 'workspace-tab-select'
        const icon = document.createElement('span')
        icon.className = 'workspace-tab-icon'
        icon.textContent = tabIcons[tab.row.dataset.type]
        icon.setAttribute('aria-hidden', 'true')
        tab.label = document.createElement('span')
        tab.label.dataset.tabLabel = ''
        tab.button.append(icon, tab.label)
        if (tab.type === 'chat') {
          tab.dot = document.createElement('span')
          tab.dot.className = 'workspace-tab-dot'
          tab.button.append(tab.dot)
        }
        tab.button.addEventListener('click', () => selectTab(tab))
        tab.close = document.createElement('button')
        tab.close.type = 'button'
        tab.close.className = 'tab-close workspace-tab-close'
        tab.close.textContent = '×'
        tab.close.addEventListener('click', () => {
          removeTabs(item => item === tab)
          focusedTab()?.button.focus({ preventScroll: true })
        })
        tab.row.append(tab.button, tab.close)
        bindTabDrag(tab)
      }
      const active = currentView !== 'activity' && (two ? tab === frontTab || tab === splitTab : tab === primaryTab())
      tab.row.classList.toggle('active', active)
      tab.row.draggable = canArrangeTabs()
      tab.row.toggleAttribute('data-ended', Boolean(tab.ended || tab.unavailable))
      tab.button.setAttribute('aria-pressed', String(active))
      tab.label.textContent = tab.name
      tab.button.title = tab.name
      tab.close.setAttribute('aria-label', `${tab.name} 닫기`)
      if (tab.dot) agents.setTabStatus(tab.dot, tab.item, tab.unavailable)
      const pane = two ? tab.pane : 0
      const strip = strips[pane]
      const next = strip.children[counts[pane]++]
      if (next !== tab.row) {
        strip.insertBefore(tab.row, next ?? null)
        tabWidths?.observe(tab.row)
      }
    }
    $('workspace-tabs-split').hidden = !two
    renderGroupSelectors()
    revealPaneTabs()
    renderStatus()
  }

  function groupsWithTabs() {
    const groups = new Map()
    for (const tab of openTabs) {
      const { id, name } = tab.group
      const group = groups.get(id) ?? { id, name, count: 0 }
      group.count++
      groups.set(id, group)
    }
    return groups
  }

  function renderGroupSelectors() {
    const groups = groupsWithTabs()
    const active = groups.get(activeGroup)
    for (const [index, button] of groupSelectors.entries()) {
      button.hidden = !active || (groups.size === 1 && active.id === GENERAL.id) || (index === 1 && !splitVisible())
      const label = active?.name ?? ''
      button.textContent = label
      button.title = active ? `작업 목록 · ${label} · 탭 ${active.count}개` : '작업 목록'
      button.setAttribute('aria-label', button.title)
    }
  }

  for (const trigger of groupSelectors) trigger.addEventListener('click', () => {
    if (contextOrigin === trigger) return closeContextMenu(true)
    if (trigger.hidden || approvals.isOpen) return
    const { left, bottom } = trigger.getBoundingClientRect()
    const options = [...groupsWithTabs().values()].map(group => ({
      text: group.name, count: group.count, current: group.id === activeGroup,
      run: () => {
        if (!openTabs.some(tab => tab.group.id === group.id)) return
        enterGroup(group.id)
        renderWorkspace()
        if (trigger.hidden || !trigger.getClientRects().length) focusedTab()?.button.focus({ preventScroll: true })
      }
    }))
    trigger.setAttribute('aria-expanded', 'true')
    openContextMenu({ clientX: left, clientY: bottom + 3 }, { focus: trigger, label: '작업 목록', options })
  })

  function pauseViewer() {
    if (viewer?.type === 'pc') pcTabs.detach()
    if (viewer?.type === 'chat') {
      viewer.draft = agents.draft
      agents.closeChat()
    }
    viewer = null
  }

  function resumeViewer() {
    const tab = primaryTab()
    if (viewer || document.hidden || !tab || tab.type === 'ssh' || currentView !== tabViews[tab.type]) return
    viewer = tab
    if (tab.type === 'pc') pcTabs.reopen(tab.item)
    else agents.reopen(tab.item, tab.draft)
  }

  function selectTab(tab) {
    closeContextMenu()
    enterGroup(tab.group.id)
    if (focusedTab() !== tab) setCtrl(false)
    if (tab.pane === 1) splitTab = tab
    else frontTab = tab
    secondFocused = tab.pane === 1
    const wasDrawerOpen = drawerOpen
    drawerOpen = false
    renderWorkspace()
    if (wasDrawerOpen) tab.button.focus({ preventScroll: true })
  }

  function setPaneFocus(isSecondary) {
    const tab = isSecondary ? splitTab : frontTab
    if (tab) selectTab(tab)
  }

  function renderWorkspace() {
    const tab = primaryTab()
    if (viewer && viewer !== tab) pauseViewer()
    const available = tab && !tab.waiting && !tab.unavailable
    if (viewer && !available) pauseViewer()
    if (secondaryViewer && (!tabletLayout || secondaryViewer !== splitTab)) pauseSecondary()
    show(available ? tabViews[tab.type] : 'workspace')
    const focused = focusedTab()
    tree.select(focused?.type === 'ssh' && focused.group.id === GENERAL.id ? focused.key : null)
    agents.selectServer?.(focused?.type === 'ssh' ? focused.key : null, focused?.group.id)
    if (available && tab.type === 'ssh') renderShell(tab, $)
    else resumeViewer()
    fitTerminal()
    renderTabs()
  }

  function refreshWorkspace() {
    if (isWorkspace() && currentView !== 'activity') renderWorkspace()
    else {
      layout()
      renderTabs()
    }
  }

  function updateStripOverflow(strip) {
    strip.toggleAttribute('data-overflow-start', strip.scrollLeft > 1)
    strip.toggleAttribute('data-overflow-end', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1)
  }

  function revealPaneTabs() {
    revealTab(strips[0], primaryTab()?.row)
    revealTab(strips[1], splitVisible() ? splitTab.row : null)
  }

  function revealTab(strip, row) {
    const maxScroll = strip.scrollWidth - strip.clientWidth
    if (row && isWorkspace() && maxScroll > 0) {
      const start = strip.scrollLeft
      const end = start + strip.clientWidth
      const left = row.offsetLeft
      // Whole-pixel layout measurements can round down at the close button's edge.
      const right = left + row.offsetWidth + 4
      const startFade = start > 1 ? tabFadeWidth : 0
      const endFade = start < maxScroll - 1 ? tabFadeWidth : 0
      if (left < start + startFade) strip.scrollLeft = left - tabFadeWidth
      else if (right > end - endFade) strip.scrollLeft = right - strip.clientWidth + tabFadeWidth
    }
    updateStripOverflow(strip)
  }

  function paneState() {
    return { frontTab, splitTab, secondFocused, splitRatio }
  }

  function restorePanes() {
    const saved = groupPanes.get(activeGroup)
    frontTab = saved?.frontTab ?? null
    splitTab = saved?.splitTab ?? null
    secondFocused = saved?.secondFocused ?? false
    splitRatio = saved?.splitRatio ?? 50
    reconcilePanes()
  }

  function enterGroup(id) {
    if (id === activeGroup) return
    setCtrl(false)
    if (workTabs().length) groupPanes.set(activeGroup, paneState())
    else groupPanes.delete(activeGroup)
    activeGroup = id
    restorePanes()
  }

  function recoverActiveGroup(previous = openTabs) {
    if (!workTabs().length && openTabs.length) enterGroup(openTabs[0].group.id)
    else reconcilePanes(previous)
  }

  function reconcilePanes(previous = openTabs) {
    const tabs = workTabs()
    function resolve(active, pane) {
      if (active?.pane === pane && tabs.includes(active)) return active
      const candidates = tabs.filter(tab => tab.pane === pane)
      const index = previous.filter(tab => tab.group.id === activeGroup && tab.pane === pane).indexOf(active)
      return candidates[Math.min(index < 0 ? candidates.length - 1 : index, candidates.length - 1)] ?? null
    }
    frontTab = resolve(frontTab, 0)
    splitTab = resolve(splitTab, 1)
    if (!frontTab && splitTab) {
      for (const tab of tabs) tab.pane = 0
      frontTab = splitTab
      splitTab = null
    }
    if (!splitTab) {
      secondFocused = false
      splitRatio = 50
    }
  }

  function openInFocusedPane(tab) {
    enterGroup(tab.group.id)
    const pane = focusedPane()
    if (tab.pane !== pane) moveTab(tab, pane)
    else selectTab(tab)
  }

  function moveTab(tab, pane) {
    if (tab.pane === pane) return
    tab.pane = pane
    reconcilePanes()
    selectTab(tab)
    tab.button.focus({ preventScroll: true })
  }

  function splitWithTab(tab, pane) {
    const tabs = workTabs()
    if (splitTab || tabs.length < 2) return
    const remaining = frontTab === tab ? tabs.findLast(item => item !== tab) : frontTab
    for (const item of tabs) item.pane = item === tab ? pane : 1 - pane
    frontTab = pane === 0 ? tab : remaining
    splitTab = pane === 1 ? tab : remaining
    splitRatio = 50
    selectTab(tab)
    tab.button.focus({ preventScroll: true })
  }

  function canArrangeTabs() {
    return isWorkspace() && tabletLayout && currentView !== 'activity' && !approvals.isOpen
  }

  let draggedTab = null
  function bindTabDrag(tab) {
    tab.row.addEventListener('dragstart', event => {
      if (!canArrangeTabs() || (!splitTab && workTabs().length < 2) || !event.dataTransfer) {
        event.preventDefault()
        return
      }
      draggedTab = tab
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('application/x-ezshell-workspace-tab', 'move')
    })
    tab.row.addEventListener('dragend', () => {
      draggedTab = null
      showTabDrop(null)
    })
  }

  function tabDropTarget(event) {
    if (!draggedTab || !workTabs().includes(draggedTab) || !canArrangeTabs()) return null
    const { left, top, right, bottom, width, height } = splitRoot.getBoundingClientRect()
    const { clientX: x, clientY: y } = event
    if (x < left || x > right || y < top || y > bottom) return null
    if (splitVisible()) {
      const target = 1 - draggedTab.pane
      const header = $(target === 1 ? 'workspace-tabs-split' : 'workspace-tabs')
      if (event.target?.closest?.('.workspace-pane-tabs') === header) return { pane: target, header }
    }
    const vertical = stackedPanes
    const band = Math.min(48, (vertical ? height : width) * .25)
    const start = vertical ? y - top : x - left
    const end = vertical ? bottom - y : right - x
    const pane = start < band ? 0 : end < band ? 1 : null
    if (pane === null || (splitVisible() && pane === draggedTab.pane)) return null
    return { pane, edge: pane === 0 ? 'start' : 'end' }
  }

  function showTabDrop(target) {
    splitRoot.removeAttribute('data-drop-edge')
    $('workspace-tabs').toggleAttribute('data-drop-target', target?.header === $('workspace-tabs'))
    $('workspace-tabs-split').toggleAttribute('data-drop-target', target?.header === $('workspace-tabs-split'))
    if (target?.edge) splitRoot.setAttribute('data-drop-edge', target.edge)
    const hint = $('workspace-drop-preview')
    hint.hidden = !target?.edge
    if (target?.edge) hint.textContent = splitVisible() ? '다른 화면으로 옮기기' : '화면 나누기'
  }

  splitRoot.addEventListener('dragover', event => {
    if (!draggedTab) return
    const target = tabDropTarget(event)
    showTabDrop(target)
    if (!target) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  })
  splitRoot.addEventListener('dragleave', event => {
    if (event.target === splitRoot || (event.relatedTarget && !splitRoot.contains(event.relatedTarget))) showTabDrop(null)
  })
  splitRoot.addEventListener('drop', event => {
    if (!draggedTab) return
    const target = tabDropTarget(event)
    const tab = draggedTab
    draggedTab = null
    showTabDrop(null)
    if (!target) return
    event.preventDefault()
    if (splitVisible()) moveTab(tab, target.pane)
    else splitWithTab(tab, target.pane)
  })

  function removeTabs(matches) {
    const removed = openTabs.filter(matches)
    if (!removed.length) return
    const previous = openTabs
    if (removed.includes(viewer)) pauseViewer()
    if (removed.includes(secondaryViewer)) pauseSecondary()
    for (const tab of removed) {
      if (tab.shellId) send({ type: 'close', shellId: tab.shellId })
      tab.terminal?.dispose()
      tab.host?.remove()
    }
    openTabs = openTabs.filter(tab => !removed.includes(tab))
    for (const group of groupPanes.keys()) {
      if (!openTabs.some(tab => tab.group.id === group)) groupPanes.delete(group)
    }
    recoverActiveGroup(previous)
    refreshWorkspace()
  }

  function openPcTab(item) {
    if (tabsEnabled) openViewer('pc', pcKey(item), item, item.name)
  }

  function openChat(item) {
    if (agentsEnabled) openViewer('chat', chatKey(item), item, agents.nameOf(item))
  }

  function openViewer(type, key, item, name) {
    let tab = openTabs.find(tab => tab.type === type && tab.key === key)
    if (!tab) {
      tab = { type, key, item, name, group: groupOf(item.project), pane: 0 }
      openTabs.push(tab)
    }
    // Re-selecting a list item can retry a viewer that ended in the foreground.
    if (viewer === tab && (type === 'pc' ? pcTabs.selectedId === null : agents.isOpen === false)) pauseViewer()
    if (secondaryViewer === tab && (type === 'pc' ? secondary.pc.selectedId === null : secondary.chat.isOpen === false)) pauseSecondary()
    openInFocusedPane(tab)
  }

  function syncTabs(type, items, keyOf) {
    const focused = focusedTab()
    const activeWasWaiting = primaryTab()?.type === type && primaryTab().waiting
    let changedGroup = false
    const list = new Map((Array.isArray(items) ? items : []).filter(Boolean).map(item => [keyOf(item), item]))
    for (const tab of openTabs) {
      if (tab.type !== type) continue
      const found = list.get(tab.key)
      tab.waiting = false
      tab.unavailable = !found
      if (found) {
        const group = groupOf(found.project)
        if (tab.group.id !== group.id) {
          tab.pane = 0
          changedGroup = true
        }
        tab.group = group
        tab.item = found
        tab.name = type === 'chat' ? agents.nameOf(found) : found.name
      }
    }
    if (changedGroup) {
      if (focused && focused.group.id !== activeGroup) {
        enterGroup(focused.group.id)
        frontTab = focused
        secondFocused = false
      } else recoverActiveGroup()
      refreshWorkspace()
    }
    else if (activeWasWaiting && currentView !== 'activity') renderWorkspace()
    else {
      layoutSplit()
      renderTabs()
    }
  }

  // ---- Terminal ----
  function fitTerminal() {
    fitShell(activeShell())
    if (splitVisible() && splitTab.type === 'ssh') fitShell(splitTab)
  }

  function fitShell(tab) {
    if (!tab?.terminal) return
    const { terminal, fit, shellId } = tab
    try {
      fit.fit()
    } catch {
      return
    }
    if (shellId) send({ type: 'resize', shellId, cols: terminal.cols, rows: terminal.rows })
  }

  function openTerminal(session, project = GENERAL) {
    const group = groupOf(project)
    const existing = openTabs.find(tab => tab.type === 'ssh' && tab.key === session.id && tab.group.id === group.id)
    if (existing && !existing.ended) return openInFocusedPane(existing)
    const tab = existing ?? { type: 'ssh', key: session.id, name: session.name, group, pane: 0 }
    tab.terminal?.dispose()
    tab.ended = null
    tab.pending = `q${++openSequence}`
    const terminal = tab.terminal = createTerminal()
    const fit = tab.fit = new FitAddon.FitAddon()
    const host = tab.host ??= document.createElement('div')
    host.className = 'remote-shell-host'
    terminal.loadAddon(fit)
    if (!existing) openTabs.push(tab)
    openInFocusedPane(tab)
    terminal.open(host)
    fitTerminal()
    terminal.onData(data => sendTerminalInput(data, tab))
    send({ type: 'open', requestId: tab.pending, sessionId: session.id, cols: terminal.cols, rows: terminal.rows })
  }

  function createTerminal(options) {
    return new Terminal({
      fontSize: 13, cursorBlink: true, scrollback: 3000, minimumContrastRatio: 4.5,
      ...terminalPresentation,
      ...options
    })
  }

  function showShell(tab) {
    renderShell(tab, $)
    fitTerminal()
  }

  function renderShell(tab, find) {
    const container = find('terminal-host')
    if (tab.host.parentElement !== container) container.append(tab.host)
    for (const host of container.children) host.hidden = host !== tab.host
    find('terminal-name').textContent = tab.name
    find('terminal-state').textContent = tab.pending ? '접속 중…' : tab.ended || ''
    find('terminal-close').hidden = !tab.shellId && !tab.pending
    find('terminal-reopen').hidden = !tab.ended
    find('keys').hidden = !tab.shellId
  }

  const shellOf = id => typeof id === 'string' ? openTabs.find(tab => tab.shellId === id) : undefined

  function shellOpened(msg) {
    const tab = openTabs.find(tab => tab.pending && tab.pending === msg.requestId)
    if (!tab) {
      if (!shellOf(msg.shellId)) send({ type: 'close', shellId: msg.shellId })
      return
    }
    tab.shellId = msg.shellId
    tab.pending = null
    if (activeShell() === tab) {
      showShell(tab)
    }
    if (splitVisible() && splitTab === tab) {
      renderShell(tab, secondary.find)
      fitShell(tab)
    }
    if (focusedTab() === tab && (activeShell() === tab || splitVisible())) tab.terminal.focus()
    renderStatus()
  }

  function endShell(tab, reason = '연결 종료됨') {
    tab.shellId = null
    tab.pending = null
    tab.ended = reason
    tab.terminal.options.disableStdin = true
    if (activeShell() === tab) showShell(tab)
    if (splitVisible() && splitTab === tab) renderShell(tab, secondary.find)
    renderTabs()
  }

  function endShells() {
    for (const tab of openTabs) if (tab.shellId || tab.pending) endShell(tab)
  }

  function setCtrl(isOn) {
    isCtrlArmed = isOn
    const second = splitVisible() && secondFocused
    $('keys').querySelector('[data-key="ctrl"]').setAttribute('aria-pressed', String(isOn && !second))
    secondary?.find('keys').querySelector('[data-key="ctrl"]').setAttribute('aria-pressed', String(isOn && second))
  }

  function setKeysVisible(visible) {
    $('keys').hidden = !visible
    if (!visible) setCtrl(false)
  }

  function isVisibleTab(tab) {
    return Boolean(tab && !tab.waiting && !tab.unavailable
      && ((tab === primaryTab() && currentView === tabViews[tab.type]) || (splitVisible() && tab === splitTab)))
  }

  function sendToTerminal(data, tab) {
    if (!data || !isVisibleTab(tab)) return
    if (tab.type === 'pc') pcViewerOf(tab)?.input(data)
    else if (tab.shellId) send({ type: 'input', shellId: tab.shellId, data })
  }

  function sendTerminalInput(data, tab) {
    // Ctrl from the key row turns the next letter into its control character.
    if (isCtrlArmed && tab === focusedTab() && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0)
      setCtrl(false)
      if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64)
    }
    sendToTerminal(data, tab)
  }

  const contextMenu = $('workspace-context-menu')
  let contextOrigin = null
  let pendingPress = null
  let ignorePressClick = false
  let clipboardNoteTimer = null
  const clipboardText = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]{1,16000}$/

  function clipboardNote(message) {
    const note = $('workspace-clipboard-status')
    note.textContent = message
    note.hidden = false
    clearTimeout(clipboardNoteTimer)
    clipboardNoteTimer = setTimeout(() => { note.hidden = true }, 3000)
  }

  async function copySelection(text) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error()
      await navigator.clipboard.writeText(text)
    } catch {
      const field = document.createElement('textarea')
      field.className = 'workspace-clipboard-field'
      field.value = text
      field.readOnly = true
      document.body.append(field)
      field.select()
      let copied = false
      try {
        copied = document.execCommand('copy')
      } catch {
        // The browser can block the legacy copy command as well.
      } finally { field.remove() }
      if (!copied) clipboardNote('이 브라우저에서 선택한 텍스트를 복사할 수 없습니다.')
    }
  }

  function pcViewerOf(tab) {
    return splitVisible() && tab === splitTab ? secondary?.pc : pcTabs
  }

  function terminalOf(tab) {
    if (!isVisibleTab(tab)) return null
    return tab.type === 'ssh' ? tab.terminal : tab.type === 'pc' ? pcViewerOf(tab)?.terminal : null
  }

  async function pasteClipboard(tab) {
    let text
    try { text = await navigator.clipboard?.readText() } catch { /* Permission can be denied. */ }
    if (!isVisibleTab(tab)) return
    if (!clipboardText.test(text || '')) {
      clipboardNote('붙여넣을 수 있는 텍스트가 없습니다.')
      return
    }
    if (tab.type === 'pc') pcViewerOf(tab)?.paste(text)
    else if (tab.shellId) tab.terminal.paste(text)
  }

  function contextActions(target) {
    if (!isWorkspace() || approvals.isOpen) return null
    const row = target?.closest?.('.workspace-tab')
    const tab = row && openTabs.find(item => item.row === row)
    if (tab) {
      const tabs = workTabs()
      const peers = splitVisible() ? tabs.filter(item => item.pane === tab.pane) : tabs
      const trailing = peers.slice(peers.indexOf(tab) + 1)
      const options = [
        { text: '탭 닫기', run: () => removeTabs(item => item === tab) },
        { text: '오른쪽 탭 모두 닫기', disabled: !trailing.length, run: () => removeTabs(item => trailing.includes(item)) }
      ]
      if (canArrangeTabs()) {
        if (splitVisible()) options.push({ text: '다른 화면으로 옮기기', run: () => moveTab(tab, 1 - tab.pane) })
        else options.push({ text: '화면 나누기', disabled: tabs.length < 2, run: () => splitWithTab(tab, 1) })
      }
      return { focus: tab.button, options }
    }
    const chip = target?.closest?.('.remote-agent-chip')
    if (chip) return { focus: chip, label: chip.title, options: [{ text: '채팅 열기', run: () => chip.click() }] }
    const xterm = target?.closest?.('.xterm')
    const current = xterm && [primaryTab(), splitTab].find(item => terminalOf(item)?.element === xterm)
    if (!current) return null
    const term = terminalOf(current)
    const canPaste = current.type === 'ssh' ? Boolean(current.shellId) : Boolean(pcViewerOf(current)?.canInput)
    return { focus: term.textarea, options: [
      { text: '복사', disabled: !term.hasSelection(), run: () => void copySelection(term.getSelection()) },
      { text: '붙여넣기', disabled: !canPaste, run: () => void pasteClipboard(current) },
      { text: '모두 선택', run: () => term.selectAll() }
    ] }
  }

  function closeContextMenu(restoreFocus = false) {
    if (contextMenu.hidden) return
    contextMenu.hidden = true
    if (groupSelectors.includes(contextOrigin)) contextOrigin.setAttribute('aria-expanded', 'false')
    if (restoreFocus && contextOrigin?.isConnected) contextOrigin.focus({ preventScroll: true })
    contextOrigin = null
  }

  function openContextMenu(event, menu) {
    contextOrigin = menu.focus
    const buttons = menu.options.map(option => {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = option.text
      if (option.count !== undefined) {
        button.dataset.tabCount = String(option.count)
        button.setAttribute('aria-label', `${option.text} · 탭 ${option.count}개`)
        if (option.current) button.setAttribute('aria-current', 'true')
      }
      button.disabled = Boolean(option.disabled)
      button.addEventListener('click', () => {
        ignorePressClick = false
        closeContextMenu(true)
        option.run()
      })
      return button
    })
    contextMenu.replaceChildren(...buttons)
    if (menu.label) {
      const label = document.createElement('p')
      label.className = 'workspace-context-label'
      label.textContent = menu.label
      contextMenu.insertBefore(label, buttons[0])
      contextMenu.setAttribute('aria-label', menu.label)
    } else contextMenu.setAttribute('aria-label', '작업 메뉴')
    contextMenu.hidden = false
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft || 0
    const top = viewport?.offsetTop || 0
    const right = left + (viewport?.width || window.innerWidth)
    const bottom = top + (viewport?.height || window.innerHeight)
    contextMenu.style.left = `${Math.max(left + 8, Math.min(event.clientX, right - contextMenu.offsetWidth - 8))}px`
    contextMenu.style.top = `${Math.max(top + 8, Math.min(event.clientY, bottom - contextMenu.offsetHeight - 8))}px`
    contextMenu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  }

  function clearPress() {
    if (!pendingPress) return
    clearTimeout(pendingPress.timer)
    pendingPress = null
  }

  document.addEventListener('pointerdown', event => {
    ignorePressClick = false
    clearPress()
    if (contextMenu.contains(event.target)) return
    if (groupSelectors.includes(contextOrigin) && contextOrigin.contains(event.target)) return
    closeContextMenu()
    if (event.pointerType !== 'touch' || !contextActions(event.target)) return
    const press = { x: event.clientX, y: event.clientY }
    press.timer = setTimeout(() => {
      const menu = contextActions(event.target)
      if (!menu) return
      pendingPress = null
      ignorePressClick = true
      openContextMenu(event, menu)
    }, 500)
    pendingPress = press
  }, true)
  document.addEventListener('pointermove', event => {
    if (pendingPress && Math.hypot(event.clientX - pendingPress.x, event.clientY - pendingPress.y) > 8) clearPress()
  }, true)
  document.addEventListener('pointerup', clearPress, true)
  document.addEventListener('pointercancel', clearPress, true)
  document.addEventListener('contextmenu', event => {
    const menu = contextActions(event.target)
    if (!menu) return
    event.preventDefault()
    clearPress()
    openContextMenu(event, menu)
  })
  document.addEventListener('click', event => {
    if (!ignorePressClick || event.detail === 0 || contextMenu.contains(event.target)) return
    ignorePressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }, true)
  document.addEventListener('keydown', event => {
    if (contextMenu.hidden || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closeContextMenu(true)
  }, true)
  contextMenu.addEventListener('keydown', event => {
    const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (!direction) return
    const buttons = [...contextMenu.querySelectorAll('button:not(:disabled)')]
    event.preventDefault()
    buttons[(buttons.indexOf(document.activeElement) + direction + buttons.length) % buttons.length]?.focus()
  })

  const KEYS = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' }
  function bindKeys(keys, tabOf, pc, isSecondary = false) {
    keys.addEventListener('click', event => {
      const button = event.target.closest('button')
      if (!button || keys.hidden) return
      if (splitVisible() && secondFocused !== isSecondary) setPaneFocus(isSecondary)
      const tab = tabOf()
      if (button.dataset.key === 'ctrl') setCtrl(!isCtrlArmed)
      else sendToTerminal(KEYS[button.dataset.key] ?? button.dataset.text ?? '', tab)
      if (tab?.type === 'pc') pc.focus()
      else tab?.terminal.focus()
    })
    // A tap on the key row must not take the keyboard away from the terminal.
    keys.addEventListener('mousedown', event => event.preventDefault())
  }
  bindKeys($('keys'), primaryTab, pcTabs)

  $('terminal-close').addEventListener('click', () => removeTabs(tab => tab === activeShell()))
  $('terminal-reopen').addEventListener('click', () => reopenShell(activeShell()))
  function reopenShell(tab) {
    if (tab?.ended) openTerminal({ id: tab.key, name: tab.name }, tab.group)
  }
  function fitViewport() {
    closeContextMenu()
    const viewport = window.visualViewport
    const root = document.documentElement
    const style = root.style
    keyboardOpen = false
    if (viewport?.height > 0 && (viewport.scale ?? 1) === 1) {
      style.setProperty('--visible-height', `${Math.floor(viewport.height)}px`)
      style.setProperty('--visible-top', `${Math.floor(viewport.offsetTop || 0)}px`)
      const width = root.clientWidth || window.innerWidth
      const height = root.clientHeight || window.innerHeight
      // In resizes-content mode a keyboard can also shrink the layout viewport.
      const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]')
      keyboardBaseline = editing && width === viewportWidth ? Math.max(height, keyboardBaseline) : height
      viewportWidth = width
      keyboardOpen = viewport.height < keyboardBaseline * 0.75
    } else {
      style.removeProperty('--visible-height')
      style.removeProperty('--visible-top')
    }
    // A soft keyboard can temporarily make the layout viewport short or landscape.
    if (!keyboardOpen) {
      if (tabletLayout !== workspaceSize.matches) drawerOpen = false
      tabletLayout = workspaceSize.matches
      stackedPanes = portrait.matches
    }
    refreshWorkspace()
  }
  window.addEventListener('resize', fitViewport)
  workspaceSize.addEventListener('change', fitViewport)
  portrait.addEventListener('change', fitViewport)
  window.visualViewport?.addEventListener('resize', fitViewport)
  window.visualViewport?.addEventListener('scroll', fitViewport)
  if (window.visualViewport) fitViewport()
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelRetry()
      clearTimeout(wakeTimer)
      wakeTimer = null
      pauseViewer()
      pauseSecondary()
    }
    else {
      wake()
      resumeViewer()
      layoutSplit()
    }
  })
  window.addEventListener('online', wake)
  window.addEventListener('pageshow', event => { if (event.persisted) wake() })

  // ---- Start ----
  $('signin-code').addEventListener('input', () => {
    if (/^\d{6}$/.test($('signin-code').value)) $('signin-form').requestSubmit()
  })
  $('signin-form').addEventListener('submit', (event) => {
    event.preventDefault()
    if (signingIn) return
    const code = $('signin-code').value.trim()
    if (!/^\d{6}$/.test(code)) return signinError('6자리 숫자를 입력하세요.')
    signingIn = true
    signinError('')
    const token = readToken()
    const remember = $('signin-remember').checked
    forgetTicketOnReady = !remember
    const payload = { type: 'signin', token, code, remember }
    if (socket && socket.readyState === WebSocket.OPEN) send(payload)
    else connect(() => send(payload))
  })
  $('message-retry').addEventListener('click', start)

  const installButtons = [$('workspace-install')]
  let installPrompt = null
  window.addEventListener('beforeinstallprompt', (event) => {
    if (standalone) return
    event.preventDefault()
    installPrompt = event
    for (const button of installButtons) button.hidden = false
  })
  function hideInstall() {
    installPrompt = null
    for (const button of installButtons) button.hidden = true
  }
  for (const button of installButtons) {
    button.addEventListener('click', async () => {
      const prompt = installPrompt
      if (!prompt) return
      hideInstall()
      try {
        await prompt.prompt()
      } catch {
        // The browser's install menu is still available.
      }
    })
  }
  window.addEventListener('appinstalled', hideInstall)
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
  }

  $('pair-link-form').addEventListener('submit', (event) => {
    event.preventDefault()
    if (!standalone) return
    const input = $('pair-link')
    let code = null
    try {
      const link = new URL(input.value)
      if (link.origin === location.origin && link.pathname === '/' && !link.username && !link.password) {
        code = new URLSearchParams(link.hash.slice(1)).get('pair')
      }
    } catch {
      // Keep the form open so the link can be corrected.
    }
    if (!code || !/^[A-Za-z0-9_-]{24}$/.test(code)) {
      const error = $('pair-link-error')
      error.textContent = '이 ezShell의 새 기기 등록 링크를 붙여넣어 주세요.'
      error.hidden = false
      return
    }
    input.value = ''
    pair(code)
  })

  function pair(code) {
    message('이 기기를 등록하는 중…')
    const payload = { type: 'pair', code, name: deviceName() }
    if (socket?.readyState === WebSocket.OPEN) send(payload)
    else connect(() => send(payload))
  }

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
      pair(pairCode)
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
      message(standalone
        ? 'PC의 ezShell 설정 > 원격 접속에서 새 등록 QR을 만들고 등록 링크를 복사하세요.'
        : '이 기기는 등록되어 있지 않습니다. PC 의 ezShell 설정 > 원격 접속에서 QR 을 찍어 등록하세요.',
      { canPair: true })
    }
  }

  /** A short name for the list of devices on the PC */
  function deviceName() {
    const agent = navigator.userAgent
    const model = /iPhone|iPad|Android|Windows|Macintosh|Linux/.exec(agent)
    const browser = /Edg|Chrome|Firefox|Safari/.exec(agent)
    return [model ? model[0] : '기기', browser ? browser[0].replace('Edg', 'Edge') : ''].filter(Boolean).join(' · ')
  }

  updateTerminalPresentation()
  applySidebarWidth()
  start()
})()
