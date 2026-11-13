// The phone page of ezShell's remote access: register once (the address carries a one-time code),
// sign in with the authenticator's code, pick a session, use its terminal.
// Plain script (no build step): served as it is by src/remoteAccess/server.js.
(() => {
  'use strict'
  const TOKEN_KEY = 'ezshell-device-token'
  const $ = (id) => document.getElementById(id)
  const views = ['signin', 'message', 'sessions', 'terminal']
  const show = (name) => views.forEach((view) => { $(`view-${view}`).hidden = view !== name })

  let socket = null
  let sessions = []
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

  const send = (message) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

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
    const next = new WebSocket(`ws://${location.host}/ws`)
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
      case 'ready':
        wasReady = true
        sessions = msg.sessions
        $('device-name').textContent = msg.device
        renderSessions()
        show('sessions')
        break
      case 'sessions':
        sessions = msg.sessions
        renderSessions()
        break
      case 'error':
        if (!readToken() || msg.code === 'unknown-device') message(msg.message)
        else {
          show('signin')
          signinError(msg.message)
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

  // ---- Sessions ----
  function renderSessions() {
    const list = $('session-list')
    const filter = $('session-filter').value.trim().toLowerCase()
    list.textContent = ''
    const shown = sessions.filter((s) => !filter || s.name.toLowerCase().includes(filter) || s.folder.toLowerCase().includes(filter))
    if (shown.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = sessions.length === 0 ? '저장된 세션이 없습니다.' : '찾는 세션이 없습니다.'
      list.append(empty)
      return
    }
    let folder = null
    for (const session of shown) {
      if (session.folder !== folder) {
        folder = session.folder
        const title = document.createElement('div')
        title.className = 'folder'
        title.textContent = folder || '폴더 없음'
        list.append(title)
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'session'
      button.textContent = session.name
      button.addEventListener('click', () => openTerminal(session))
      list.append(button)
    }
  }

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
  $('session-filter').addEventListener('input', renderSessions)
  window.addEventListener('resize', fitTerminal)
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitTerminal)

  // ---- Start ----
  $('signin-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const code = $('signin-code').value.trim()
    if (!/^\d{6}$/.test(code)) return signinError('6자리 숫자를 입력하세요.')
    signinError('')
    const token = readToken()
    if (socket && socket.readyState === WebSocket.OPEN) send({ type: 'signin', token, code })
    else connect(() => send({ type: 'signin', token, code }))
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
      $('signin-note').textContent = '인증 앱의 6자리 코드를 입력하세요.'
      show('signin')
      $('signin-code').focus()
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
