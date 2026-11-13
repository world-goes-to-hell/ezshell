// The web server of remote access: a small page for a phone's browser and a WebSocket that carries
// terminal input and output. It listens only on this PC's Tailscale address and answers only
// connections from Tailscale addresses; a device must be registered and give the authenticator's
// code before anything else is answered.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')
const { isTailnetAddress } = require('./tailnet.js')
const { readSubscription } = require('./webPush.js')

/** Signed-in connections at once */
const MAX_CLIENTS = 4
/** Connections that have not signed in: they do not take the places above */
const MAX_WAITING = 12
const MAX_WAITING_PER_ADDRESS = 3
/** A connection that has not signed in is dropped after this */
const SIGN_IN_MS = 60 * 1000
/** A signed-in connection without any input is dropped after this */
const IDLE_MS = 15 * 60 * 1000
const MAX_MESSAGE_BYTES = 64 * 1024
/** Failed registrations and sign-ins: a connection is dropped at the first limit, its address refused at the second */
const MAX_FAILURES_PER_CONNECTION = 5
const MAX_FAILURES_PER_ADDRESS = 10
const FAILURE_WINDOW_MS = 5 * 60 * 1000
const MAX_TRACKED_ADDRESSES = 256
/** Shell output is sent in batches, and the shell is paused while the device is this far behind */
const OUTPUT_BATCH_MS = 20
const OUTPUT_FLUSH_CHARS = 64 * 1024
const OUTPUT_PAUSE_BYTES = 1024 * 1024
const OUTPUT_RESUME_BYTES = 128 * 1024
const OUTPUT_POLL_MS = 100
/** Output kept while the shell is still opening (the device has no id for it yet) */
const MAX_EARLY_OUTPUT_CHARS = 256 * 1024
/** An answer to an MCP question is not taken sooner than this after the device was sent it (as in the PC dialog) */
const APPROVAL_ARM_MS = 800
/** MCP activity sent to a device: what one request printed (its end), and all requests together */
const ACTIVITY_OUTPUT_CHARS = 16 * 1024
const ACTIVITY_TOTAL_CHARS = 400 * 1024
const MAX_ACTIVITY_ITEMS = 100

/** What a device gets of a request. Anything else the PC keeps about it (a file change's content) is not sent. */
const ACTIVITY_FIELDS = ['id', 'time', 'sessionId', 'sessionName', 'command', 'level', 'reasons', 'state', 'startedAt', 'finishedAt', 'cwd', 'exitCode', 'timedOut', 'truncated', 'error', 'background', 'jobId', 'transfer', 'outputTrimmed']
/** A device that has this much unread data gets no more activity until it has caught up (questions are always sent) */
const ACTIVITY_BACKLOG_BYTES = 1024 * 1024

/**
 * A request as a device gets it: the named fields, and the end of what it printed and of its
 * result text, within `budget` characters; `outputTrimmed` when the start of the output was dropped.
 */
function trimOutput(item, budget = ACTIVITY_OUTPUT_CHARS) {
  if (!item || typeof item !== 'object') return item
  const picked = {}
  for (const field of ACTIVITY_FIELDS) if (item[field] !== undefined) picked[field] = item[field]
  if (typeof item.output === 'string') picked.output = item.output.slice(-Math.max(1, Math.min(ACTIVITY_OUTPUT_CHARS, budget || 1)))
  if (!Array.isArray(item.outputParts)) return picked
  item = { ...picked, outputParts: item.outputParts }
  const parts = item.outputParts.map((part) => ({ stream: part?.stream === 'stderr' ? 'stderr' : 'stdout', text: String(part?.text ?? '') }))
  const total = parts.reduce((sum, part) => sum + part.text.length, 0)
  const limit = Math.max(0, budget)
  const kept = []
  let left = limit
  for (let i = parts.length - 1; i >= 0 && left > 0; i--) {
    const text = parts[i].text.slice(-left)
    kept.unshift({ stream: parts[i].stream, text })
    left -= text.length
  }
  return { ...item, outputParts: kept, ...(total > limit ? { outputTrimmed: true } : {}) }
}

/** The newest requests, oldest first, with their output cut to fit a phone */
function activityForDevice(items) {
  const recent = (Array.isArray(items) ? items : []).slice(-MAX_ACTIVITY_ITEMS)
  let left = ACTIVITY_TOTAL_CHARS
  const out = []
  // The newest requests get their output first; older ones lose it when the total is used up
  for (let i = recent.length - 1; i >= 0; i--) {
    const trimmed = trimOutput(recent[i], Math.min(ACTIVITY_OUTPUT_CHARS, left))
    left -= (trimmed.outputParts ?? []).reduce((sum, part) => sum + part.text.length, 0) + (trimmed.output?.length ?? 0)
    left = Math.max(0, left)
    out.unshift(trimmed)
  }
  return out
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  // The parts of the page (plain scripts, no build step) and its service worker (notifications)
  '/sessions.js': ['sessions.js', 'text/javascript; charset=utf-8'],
  '/approvals.js': ['approvals.js', 'text/javascript; charset=utf-8'],
  '/activity.js': ['activity.js', 'text/javascript; charset=utf-8'],
  '/push.js': ['push.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8']
}
// The terminal library: [file in web/vendor (copied there by the build), the package file it comes from, type]
const VENDOR = {
  '/vendor/xterm.js': ['xterm.js', 'xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': ['xterm.css', 'xterm/css/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/xterm-addon-fit.js': ['xterm-addon-fit.js', 'xterm-addon-fit/lib/xterm-addon-fit.js', 'text/javascript; charset=utf-8']
}

/**
 * Where a vendor file is: next to the page in a built app; in node_modules when running from the
 * source tree (tests). The packaged app has no node_modules/xterm, so the copy is looked for first.
 */
function vendorPath(webDir, [name, source]) {
  const copied = path.join(webDir, 'vendor', name)
  if (fs.existsSync(copied)) return copied
  try {
    return require.resolve(source)
  } catch {
    return copied
  }
}

/** The page may talk only to this server: 'self' does not cover ws: in every browser, so the socket's address is named */
const headersFor = (scheme, name, port) => ({
  'Content-Security-Policy': `default-src 'self'; connect-src 'self' ${scheme === 'https' ? 'wss' : 'ws'}://${name}:${port}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
})

/** A closing socket waits for the other side's answer (up to 30 s in ws); after this it is cut */
const CLOSE_GRACE_MS = 2000
function closeSocket(socket) {
  socket.close()
  setTimeout(() => socket.terminate(), CLOSE_GRACE_MS).unref()
}

const ERRORS = {
  locked: '여러 번 틀려서 잠시 막혔습니다. 5분 뒤에 다시 시도하세요.',
  'bad-code': '코드가 맞지 않습니다.',
  'unknown-device': '등록되지 않은 기기입니다. PC 의 ezShell 설정에서 다시 등록하세요.',
  'too-many': '등록할 수 있는 기기 수를 넘었습니다. PC 에서 쓰지 않는 기기를 해제하세요.',
  full: '접속한 기기가 너무 많습니다.',
  appLocked: 'PC 의 ezShell 이 잠겨 있습니다.',
  tooManyFailures: '여러 번 실패해서 연결을 끊었습니다. 잠시 뒤에 다시 시도하세요.'
}

/**
 * @param {object} deps
 * @param {object} deps.store accessStore
 * @param {object} deps.shells remote shells
 * @param {() => { folders: object[], sessions: object[] }} deps.listSessions names, colours and order only
 * @param {() => boolean} deps.isLocked the app is locked (nothing is answered)
 * @param {{ current: () => object | null, respond: (id: string, approved: boolean, device: string) => boolean }} [deps.approvals]
 *   MCP questions: the one being asked now, and answering it as a device. Without it devices get none.
 * @param {{ list: () => object[], cancel: (id: string) => boolean }} [deps.activity] MCP requests and stopping one
 * @param {(event: string, detail?: object) => void} [deps.log]
 * @param {() => void} [deps.onChange] connected devices changed
 */
function createAccessServer({ store, shells, listSessions, isLocked, approvals = null, activity = null, log = () => {}, onChange = () => {}, webDir = path.join(__dirname, 'web'), now = Date.now, isAllowedAddress = isTailnetAddress }) {
  let server = null
  let sockets = null
  let address = null
  let headers = {}
  /** A start that has not finished listening yet (two callers must not both listen) */
  let starting = null
  const clients = new Set()
  /** Failed attempts by address: Map<address, { count, until }> */
  const failures = new Map()

  const isRefused = (remote) => {
    const entry = failures.get(remote)
    if (!entry) return false
    if (now() >= entry.until) {
      failures.delete(remote)
      return false
    }
    return entry.count >= MAX_FAILURES_PER_ADDRESS
  }
  function countFailure(remote) {
    const entry = failures.get(remote)
    if (entry && now() < entry.until) {
      entry.count += 1
      return
    }
    // A full table is emptied rather than grown: the limits start over, which only helps for a moment
    if (failures.size >= MAX_TRACKED_ADDRESSES) failures.clear()
    failures.set(remote, { count: 1, until: now() + FAILURE_WINDOW_MS })
  }

  /** A question as a device gets it: with the time left, since the phone's clock may differ from this PC's */
  const forDevice = (request) => ({ ...request, remainingMs: Math.max(0, Number(request.expiresAt) - now()) })
  const signedIn = () => [...clients].filter((c) => c.device)
  const sendTo = (client, message) => {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(message))
  }

  /** The only name this server answers to. A page reached by another name (DNS rebinding) gets nothing. */
  const ownHost = () => (address ? `${address.name}:${address.port}` : null)
  const ownOrigin = () => (address ? `${address.scheme}://${address.name}:${address.port}` : null)
  /** Notifications need a page served over HTTPS (a service worker); the key is the one devices subscribe with */
  const pushInfo = () => (address && address.scheme === 'https' ? { available: true, publicKey: store.vapidKeys().publicKey } : { available: false, publicKey: null })

  function serve(req, res) {
    // Anything not from Tailscale gets nothing, not even an error page
    if (!isAllowedAddress(req.socket.remoteAddress)) {
      req.socket.destroy()
      return
    }
    const url = (req.url || '/').split('?')[0]
    if (req.headers.host !== ownHost()) {
      // Opened by a name (MagicDNS): sent to the address, so the page's origin is the one the socket accepts
      if (req.method === 'GET' && url === '/') res.writeHead(302, { ...headers, Location: `${ownOrigin()}/` })
      else res.writeHead(421, headers)
      res.end()
      return
    }
    const file = STATIC[url] ? [path.join(webDir, STATIC[url][0]), STATIC[url][1]]
      : VENDOR[url] ? [vendorPath(webDir, VENDOR[url]), VENDOR[url][2]]
        : null
    if (req.method !== 'GET' || !file) {
      res.writeHead(404, headers)
      res.end()
      return
    }
    fs.readFile(file[0], (err, body) => {
      if (err) {
        // A listed file that is not there (a part of the page not written yet) is simply not found
        res.writeHead(err.code === 'ENOENT' ? 404 : 500, headers)
        res.end()
        return
      }
      res.writeHead(200, { ...headers, 'Content-Type': file[1] })
      res.end(body)
    })
  }

  function accept(socket, remote) {
    const client = { socket, remote, device: null, timer: null, failures: 0, outputs: new Set(), askedAt: new Map(), watchesActivity: false }
    // First of all: a socket without an error listener throws into the main process
    socket.on('error', () => socket.terminate())
    const send = (message) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
    }
    const drop = (reason) => {
      if (reason) send({ type: 'bye', message: reason })
      closeSocket(socket)
    }
    client.drop = drop
    const arm = (ms) => {
      clearTimeout(client.timer)
      client.timer = setTimeout(() => drop(client.device ? '입력이 없어 연결을 끊었습니다.' : null), ms)
    }
    const waiting = [...clients].filter((c) => !c.device)
    if (waiting.length >= MAX_WAITING || waiting.filter((c) => c.remote === remote).length >= MAX_WAITING_PER_ADDRESS) {
      drop(ERRORS.full)
      return
    }
    clients.add(client)
    arm(SIGN_IN_MS)

    socket.on('close', () => {
      clearTimeout(client.timer)
      clients.delete(client)
      for (const stop of [...client.outputs]) stop()
      shells.closeAll(client)
      if (client.device) {
        log('disconnect', { device: client.device.name })
        onChange()
      }
    })

    /** A failed registration or sign-in: answered, counted, and the connection dropped when there are too many */
    function refuse(kind, code) {
      log(kind, { reason: code, from: remote })
      client.failures += 1
      countFailure(remote)
      send({ type: 'error', code, message: ERRORS[code] })
      if (client.failures >= MAX_FAILURES_PER_CONNECTION || isRefused(remote)) drop(ERRORS.tooManyFailures)
    }

    /** Output of one shell: batched, and the shell paused while the device cannot keep up */
    function outputOf(getShellId) {
      let buffer = ''
      let timer = null
      let poll = null
      const flush = () => {
        clearTimeout(timer)
        timer = null
        if (!buffer) return
        send({ type: 'data', shellId: getShellId(), data: buffer })
        buffer = ''
        if (!poll && socket.bufferedAmount > OUTPUT_PAUSE_BYTES) {
          shells.setPaused(getShellId(), client, true)
          poll = setInterval(() => {
            if (socket.bufferedAmount > OUTPUT_RESUME_BYTES) return
            clearInterval(poll)
            poll = null
            shells.setPaused(getShellId(), client, false)
          }, OUTPUT_POLL_MS)
        }
      }
      const stop = () => {
        clearTimeout(timer)
        clearInterval(poll)
        client.outputs.delete(stop)
      }
      client.outputs.add(stop)
      return {
        push(data) {
          buffer += data
          if (buffer.length >= OUTPUT_FLUSH_CHARS) flush()
          else if (!timer) timer = setTimeout(flush, OUTPUT_BATCH_MS)
        },
        flush,
        stop
      }
    }

    function openShell(message) {
      const requestId = String(message.requestId ?? '').slice(0, 40)
      // Output of this shell that arrives before the device knows its id (only the newest part is kept)
      let early = ''
      let opened = null
      const output = outputOf(() => opened)
      shells.open(String(message.sessionId ?? ''), {
        cols: message.cols,
        rows: message.rows,
        owner: client,
        onData: (data) => {
          if (opened) output.push(data)
          else early = (early + data).slice(-MAX_EARLY_OUTPUT_CHARS)
        },
        onClose: () => {
          output.flush()
          output.stop()
          if (opened) send({ type: 'closed', shellId: opened })
        }
      }).then(({ shellId, name }) => {
        opened = shellId
        log('open', { device: client.device.name, session: name })
        send({ type: 'opened', requestId, shellId, name })
        if (early) output.push(early)
        early = ''
        output.flush()
      }, (err) => {
        output.stop()
        send({ type: 'open-failed', requestId, message: err.message })
      })
    }

    function handle(raw, isBinary) {
      if (isBinary) return drop()
      let message
      try {
        message = JSON.parse(raw.toString('utf-8'))
      } catch {
        return drop()
      }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return drop()
      if (isLocked()) return drop(ERRORS.appLocked)

      // ---- Before signing in: register, or sign in ----
      if (!client.device) {
        if (message.type === 'pair') {
          const result = store.redeemPairing(message.code, message.name)
          if (result.error) return refuse('pair-failed', result.error)
          log('pair', { device: result.name })
          onChange()
          return send({ type: 'paired', token: result.token })
        }
        if (message.type === 'signin') {
          const result = store.signIn(message.token, message.code)
          if (result.error) return refuse('signin-failed', result.error)
          if ([...clients].filter((c) => c.device).length >= MAX_CLIENTS) return drop(ERRORS.full)
          client.device = result.device
          arm(IDLE_MS)
          log('signin', { device: result.device.name })
          onChange()
          // A question that was already being asked when the device came in
          const asked = approvals ? approvals.current() : null
          if (asked) client.askedAt.set(asked.id, now())
          return send({ type: 'ready', device: result.device.name, ...listSessions(), approvals: asked ? [forDevice(asked)] : [], push: pushInfo() })
        }
        return drop()
      }

      // ---- Signed in ----
      // The device may have been removed on the PC meanwhile
      if (!store.hasDevice(client.device.id)) return drop('이 기기는 PC 에서 등록이 해제되었습니다.')
      arm(IDLE_MS)
      switch (message.type) {
        case 'sessions':
          return send({ type: 'sessions', ...listSessions() })
        case 'approval-respond': {
          const id = String(message.id ?? '')
          const askedAt = client.askedAt.get(id)
          // Only a question this device was sent, and not in the first moment after it appeared
          if (!approvals || askedAt === undefined || typeof message.approved !== 'boolean') return send({ type: 'approval-result', id, ok: false, message: '이미 끝난 요청입니다.' })
          if (now() - askedAt < APPROVAL_ARM_MS) return send({ type: 'approval-result', id, ok: false, message: '요청을 확인한 뒤 다시 눌러 주세요.' })
          const ok = approvals.respond(id, message.approved, client.device.name) === true
          if (ok) log('approval', { device: client.device.name, approved: message.approved })
          return send({ type: 'approval-result', id, ok, ...(ok ? {} : { message: '이미 끝난 요청입니다.' }) })
        }
        case 'push-subscribe': {
          // The browser's subscription: where to send, and the keys only that browser can read with
          const subscription = pushInfo().available ? readSubscription(message.subscription) : null
          if (!subscription) return send({ type: 'push-result', ok: false, message: '알림을 켤 수 없습니다.' })
          // The page sends its subscription again every time it signs in: saved and logged only when it changed
          const kept = store.pushTargets().find((target) => target.deviceId === client.device.id)?.subscription
          const isSame = Boolean(kept) && kept.endpoint === subscription.endpoint && kept.p256dh === subscription.p256dh && kept.auth === subscription.auth
          if (!isSame) {
            store.setPush(client.device.id, subscription)
            log('push-on', { device: client.device.name })
            onChange()
          }
          return send({ type: 'push-result', ok: true })
        }
        case 'push-unsubscribe':
          store.setPush(client.device.id, null)
          log('push-off', { device: client.device.name })
          onChange()
          return send({ type: 'push-result', ok: true })
        case 'activity-list':
          // Not while the device is far behind: the list is large and it would only pile up
          if (socket.bufferedAmount > ACTIVITY_BACKLOG_BYTES) return undefined
          return send({ type: 'activity', items: activity ? activityForDevice(activity.list()) : [] })
        case 'activity-watch':
          client.watchesActivity = message.on === true
          return undefined
        case 'activity-stop': {
          const id = String(message.id ?? '')
          const ok = Boolean(activity) && activity.cancel(id, client.device.name) === true
          if (ok) log('activity-stop', { device: client.device.name })
          return send({ type: 'activity-stop-result', id, ok, ...(ok ? {} : { message: '중지할 수 없는 요청입니다.' }) })
        }
        case 'open':
          return openShell(message)
        case 'input':
          return shells.write(String(message.shellId), client, message.data)
        case 'resize':
          return shells.resize(String(message.shellId), client, message.cols, message.rows)
        case 'close':
          return shells.close(String(message.shellId), client)
        default:
          return undefined
      }
    }

    socket.on('message', (raw, isBinary) => {
      // A connection being closed (dropped, unregistered, switched off) is not answered any more
      if (socket.readyState !== socket.OPEN) return
      // Whatever a device sends must not reach the main process as an exception
      try {
        handle(raw, isBinary)
      } catch (err) {
        log('error', { message: String(err && err.message).slice(0, 200) })
        drop()
      }
    })
  }

  /**
   * Starts listening on the Tailscale address. With `tls` ({ cert, key } for `name`, the PC's
   * tailnet name) the page is served over HTTPS under that name; without it over HTTP under the
   * address. Rejects when the port cannot be opened.
   */
  function start(host, port, { name = host, tls = null } = {}) {
    if (server) return Promise.resolve({ host: address.host, port: address.port })
    if (starting) return starting
    starting = listen(host, port, name, tls).finally(() => { starting = null })
    return starting
  }

  function listen(host, port, name, tls) {
    return new Promise((resolve, reject) => {
      const scheme = tls ? 'https' : 'http'
      const handler = (req, res) => {
        try {
          serve(req, res)
        } catch {
          req.socket.destroy()
        }
      }
      const next = tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : http.createServer(handler)
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })
      next.on('upgrade', (req, socket, head) => {
        const remote = String(socket.remoteAddress ?? '')
        // Only Tailscale addresses, and only the page this server served under its own address: the
        // Origin and Host are compared with the address it listens on, never with each other (a page
        // of another site, or one reached through a name that was pointed here, must not open the socket)
        const isOwnPage = req.headers.origin === `${scheme}://${name}:${port}` && req.headers.host === `${name}:${port}`
        if (!isAllowedAddress(remote) || !isOwnPage || (req.url || '').split('?')[0] !== '/ws' || isLocked() || isRefused(remote)) {
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => accept(ws, remote))
      })
      // Before anything is read, and before a TLS handshake: an address that is not Tailscale's gets nothing
      next.on('connection', (socket) => {
        if (!isAllowedAddress(socket.remoteAddress)) socket.destroy()
      })
      next.on('clientError', (err, socket) => socket.destroy())
      next.on('tlsClientError', (err, socket) => socket.destroy())
      next.once('error', reject)
      next.listen(port, host, () => {
        server = next
        sockets = wss
        address = { host, port, name, scheme }
        headers = headersFor(scheme, name, port)
        log('start', { port, scheme })
        resolve({ host, port })
      })
    })
  }

  /** Drops every device (the app locked, or remote access was switched off) */
  function disconnectAll(reason) {
    for (const client of [...clients]) client.drop(reason)
    shells.closeAll()
  }

  /** `reason` is what the connected devices are told */
  function stop(reason = '원격 접속이 꺼졌습니다.') {
    if (!server) return
    disconnectAll(reason)
    sockets.close()
    server.close()
    server = null
    sockets = null
    address = null
    log('stop')
  }

  return {
    start,
    stop,
    disconnectAll,
    /** Removes one device's connections (it was unregistered) */
    disconnectDevice: (deviceId) => {
      for (const client of [...clients]) {
        if (client.device?.id !== deviceId) continue
        // Its shells end now, not when the device gets round to answering the close
        shells.closeAll(client)
        client.drop('이 기기는 PC 에서 등록이 해제되었습니다.')
      }
    },
    /** An MCP question started on the PC: every signed-in device gets it */
    showApproval: (request) => {
      if (!request || typeof request.id !== 'string') return
      for (const client of signedIn()) {
        client.askedAt.set(request.id, now())
        sendTo(client, { type: 'approval', request: forDevice(request) })
      }
    },
    /** It ended, whoever answered: `by` is 'pc', 'device' or null (time ran out, cancelled) */
    closeApproval: (id, outcome, by = null) => {
      for (const client of signedIn()) {
        if (!client.askedAt.delete(id)) continue
        sendTo(client, { type: 'approval-closed', id, outcome, by })
      }
    },
    /** An MCP request appeared or changed: to devices that are looking at the activity */
    activityItem: (item) => {
      const watchers = signedIn().filter((c) => c.watchesActivity && c.socket.bufferedAmount <= ACTIVITY_BACKLOG_BYTES)
      if (watchers.length === 0) return
      const message = { type: 'activity-item', item: trimOutput(item) }
      watchers.forEach((client) => sendTo(client, message))
    },
    /** Live output of a running request ({ id, parts }), to the same devices */
    activityOutput: (payload) => {
      if (!payload || !Array.isArray(payload.parts)) return
      const watchers = signedIn().filter((c) => c.watchesActivity && c.socket.bufferedAmount <= ACTIVITY_BACKLOG_BYTES)
      if (watchers.length === 0) return
      const parts = trimOutput({ outputParts: payload.parts }).outputParts
      watchers.forEach((client) => sendTo(client, { type: 'activity-output', id: payload.id, parts }))
    },
    get isRunning() { return server !== null },
    get address() { return address },
    connected: () => [...clients].filter((c) => c.device).map((c) => ({ id: c.device.id, name: c.device.name }))
  }
}

module.exports = { createAccessServer, trimOutput, activityForDevice, APPROVAL_ARM_MS, MAX_CLIENTS, MAX_WAITING_PER_ADDRESS, MAX_FAILURES_PER_CONNECTION, MAX_FAILURES_PER_ADDRESS, IDLE_MS, ERRORS }
