// The phone page of ezShell's remote access: register once (the address carries a one-time code),
// sign in with the authenticator's code, pick a session, use its terminal; answer MCP approval
// requests (approvals.js), watch MCP activity (activity.js), turn on notifications (push.js).
// Plain script (no build step): served as it is by src/remoteAccess/server.js.
(() => {
  'use strict'
  const TOKEN_KEY = 'ezshell-device-token'
  // A ticket from a code sign-in that lets this device resume without a code for a day
  const TRUST_KEY = 'ezshell-device-trust'
  const $ = (id) => document.getElementById(id)
  const views = ['signin', 'message', 'sessions', 'activity', 'terminal']
  const TABBED = new Set(['sessions', 'activity'])
  let currentView = null
  const show = (name) => {
    views.forEach((view) => { $(`view-${view}`).hidden = view !== name })
    $('tabs').hidden = !TABBED.has(name)
    for (const tab of $('tabs').querySelectorAll('button')) {
      if (tab.dataset.view === name) tab.setAttribute('aria-current', 'page')
      else tab.removeAttribute('aria-current')
    }
    // Activity is sent only while it is on screen
    if (currentView === 'activity' && name !== 'activity') activity.leave()
    if (name === 'activity' && currentView !== 'activity') activity.enter()
    currentView = name
  }

  let socket = null
  let terminal = null
  let fit = null
  let shellId = null
  let pendingOpen = null
  let isCtrlArmed = false
  let wasReady = false
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

  const ez = window.ezRemote
  const tree = ez.createSessionTree({ list: $('session-list'), filter: $('session-filter'), onOpen: (session) => openTerminal(session) })
  const approvals = ez.createApprovals({ send })
  const activity = ez.createActivity({ list: $('activity-list'), send })
  const push = ez.createPush({ button: $('push-toggle'), status: $('push-status'), send })

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

  // ---- Connection ----
  function connect(onOpen) {
    // HTTPS (a Tailscale certificate) needs the secure socket on the same name
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const next = new WebSocket(`${scheme}://${location.host}/ws`)
    let didOpen = false
    socket = next
    next.addEventListener('open', () => {
      didOpen = true
      onOpen()
    })
    next.addEventListener('message', (event) => handle(JSON.parse(event.data)))
    next.addEventListener('close', () => {
      if (socket === next) socket = null
      closeTerminal()
      approvals.reset()
      activity.reset()
      push.reset()
      // Whatever the reason, signing in again needs a new code
      if (wasReady) message('연결이 끊겼습니다.', { canRetry: true })
      else if (!didOpen) {
        // Never reached the PC: said where the person is looking
        if (!$('view-signin').hidden) signinError(CONNECT_FAILED)
        else message(CONNECT_FAILED, { canRetry: true })
      }
      wasReady = false
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
        // A fresh ticket, sent right after a code sign-in that asked to be remembered
        saveTrust(msg)
        break
      case 'ready':
        wasReady = true
        $('device-name').textContent = msg.device
        tree.update(msg.folders, msg.sessions)
        show('sessions')
        for (const request of Array.isArray(msg.approvals) ? msg.approvals : []) approvals.add(request)
        void push.setAvailability(msg.push)
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
      case 'push-result':
        push.result(msg)
        break
      case 'error':
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
          fitTerminal()
          terminal.focus()
        }
        break
      case 'open-failed':
        if (pendingOpen && msg.requestId === pendingOpen) {
          pendingOpen = null
          $('terminal-state').textContent = ''
          terminal.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`)
        }
        break
      case 'data':
        if (msg.shellId === shellId && terminal) terminal.write(msg.data)
        break
      case 'closed':
        if (msg.shellId === shellId) {
          shellId = null
          $('terminal-state').textContent = '종료됨'
          terminal.write('\r\n\x1b[2m연결이 종료되었습니다.\x1b[0m\r\n')
        }
        break
      case 'bye':
        wasReady = false
        message(msg.message, { canRetry: true })
        break
    }
  }

  // ---- Screens ----
  $('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('button[data-view]')
    if (!tab || tab.dataset.view === currentView) return
    show(tab.dataset.view)
    if (tab.dataset.view === 'sessions') send({ type: 'sessions' })
  })
  $('sessions-refresh').addEventListener('click', () => send({ type: 'sessions' }))

  // ---- Terminal ----
  function fitTerminal() {
    if (!terminal || !fit) return
    try {
      fit.fit()
    } catch {
      return
    }
    if (shellId) send({ type: 'resize', shellId, cols: terminal.cols, rows: terminal.rows })
  }

  function openTerminal(session) {
    $('terminal-name').textContent = session.name
    $('terminal-state').textContent = '접속 중…'
    show('terminal')
    terminal = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, Menlo, Consolas, "D2Coding", monospace', cursorBlink: true, scrollback: 3000, theme: { background: '#16181c', foreground: '#e6e8eb' } })
    fit = new FitAddon.FitAddon()
    terminal.loadAddon(fit)
    terminal.open($('terminal-host'))
    try {
      fit.fit()
    } catch {
      // Sized again once the shell is open
    }
    terminal.onData((data) => {
      if (!shellId) return
      // Ctrl from the key row turns the next letter into its control character
      if (isCtrlArmed && data.length === 1) {
        const code = data.toUpperCase().charCodeAt(0)
        setCtrl(false)
        if (code >= 64 && code <= 95) {
          send({ type: 'input', shellId, data: String.fromCharCode(code - 64) })
          return
        }
      }
      send({ type: 'input', shellId, data })
    })
    pendingOpen = `q${Date.now()}`
    send({ type: 'open', requestId: pendingOpen, sessionId: session.id, cols: terminal.cols, rows: terminal.rows })
  }

  function closeTerminal() {
    if (shellId) send({ type: 'close', shellId })
    shellId = null
    pendingOpen = null
    setCtrl(false)
    if (terminal) terminal.dispose()
    terminal = null
    fit = null
    $('terminal-host').textContent = ''
  }

  function setCtrl(isOn) {
    isCtrlArmed = isOn
    document.querySelector('[data-key="ctrl"]').setAttribute('aria-pressed', String(isOn))
  }

  const KEYS = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' }
  $('keys').addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button) return
    if (button.dataset.key === 'ctrl') setCtrl(!isCtrlArmed)
    else if (shellId) send({ type: 'input', shellId, data: KEYS[button.dataset.key] ?? button.dataset.text ?? '' })
    if (terminal) terminal.focus()
  })
  // A tap on the key row must not take the keyboard away from the terminal
  $('keys').addEventListener('mousedown', (event) => event.preventDefault())

  $('terminal-back').addEventListener('click', () => {
    closeTerminal()
    show('sessions')
    send({ type: 'sessions' })
  })
  window.addEventListener('resize', fitTerminal)
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitTerminal)

  // ---- Start ----
  $('signin-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const code = $('signin-code').value.trim()
    if (!/^\d{6}$/.test(code)) return signinError('6자리 숫자를 입력하세요.')
    signinError('')
    const token = readToken()
    const remember = $('signin-remember').checked
    const payload = { type: 'signin', token, code, remember }
    if (socket && socket.readyState === WebSocket.OPEN) send(payload)
    else connect(() => send(payload))
  })
  $('message-retry').addEventListener('click', start)

  function start() {
    const pairCode = new URLSearchParams(location.hash.slice(1)).get('pair')
    signinError('')
    $('signin-code').value = ''
    if (pairCode) {
      message('이 기기를 등록하는 중…')
      connect(() => send({ type: 'pair', code: pairCode, name: deviceName() }))
    } else if (readToken()) {
      const trust = readTrust()
      // Within the day the device was remembered: come straight in with the ticket, no code
      if (trust && trust.expiresAt > Date.now()) {
        message('접속하는 중…')
        connect(() => send({ type: 'resume', token: readToken(), ticket: trust.ticket }))
      } else {
        if (trust) clearTrust()
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
