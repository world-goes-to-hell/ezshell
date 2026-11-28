// The session host: owns the local shells (node-pty) so they can outlive the app while it restarts to
// install an update. It runs from the runtime copy outside the install folder (runtimeCopy.js) with
// ELECTRON_RUN_AS_NODE, so the installer can replace every file of the app while the shells go on.
//
// One client at a time (the app), on a named pipe, after a hello with the token the app gave in the
// environment. A second app is let in only after the first said `keep`; until then it is turned away. When the client goes away the shells end with it, as they did inside the app, unless the
// app said `keep` first (quitting to install an update): then they wait for the next app for that long.
//
// Self-contained on purpose: only Node's own modules and the node-pty folder it is given, both inside
// the copy. Design: docs/plan/2026-11-26-sessions-survive-update.md
const net = require('node:net')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { timingSafeEqual, createHash } = require('node:crypto')

const FORMAT = 1
const BUFFER_CHARS = 256 * 1024
const MAX_LINE_CHARS = 8 * 1024 * 1024
const MAX_WRITE_CHARS = 1024 * 1024
const MAX_META_CHARS = 64 * 1024
const MAX_LAYOUT_CHARS = 512 * 1024
const MAX_KEEP_MS = 5 * 60 * 1000
const FIRST_CLIENT_MS = 30 * 1000
const HELLO_MS = 5000
const SHELL_ID = /^[\w:.-]{1,64}$/
const TERMINAL_SIZE = value => Number.isInteger(value) && value >= 2 && value <= 500

const digest = text => createHash('sha256').update(String(text)).digest()
const sameToken = (given, expected) => typeof given === 'string' && timingSafeEqual(digest(given), digest(expected))
const strings = list => Array.isArray(list) && list.length <= 256 && list.every(item => typeof item === 'string' && item.length <= 32768 && !item.includes('\0'))
const stringMap = value => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.entries(value).every(([key, item]) => key.length <= 4096 && typeof item === 'string' && item.length <= 32768 && !key.includes('\0') && !item.includes('\0'))

/** The spawn request's options, checked: only what node-pty needs, nothing passed through unseen */
function spawnOptions(options) {
  if (!options || typeof options !== 'object') return null
  const { name, cols, rows, cwd, env } = options
  if (typeof name !== 'string' || name.length > 64 || !TERMINAL_SIZE(cols) || !TERMINAL_SIZE(rows)) return null
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0') || !stringMap(env)) return null
  return { name, cols, rows, cwd, env }
}

/**
 * @param {object} deps
 * @param {Function} deps.spawn node-pty's spawn
 * @param {string} deps.token what the app's hello must carry
 * @param {(pid: number) => void} deps.killTree ends a shell and everything started in it
 * @param {() => void} deps.exit the host's process ends
 */
function createSessionHost({ spawn, token, killTree, exit, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const shells = new Map()
  let client = null
  let keepUntil = 0
  // Which shell sits in which pane of which tab: the window's, kept for the next app's window
  let layout = null
  let waitTimer = setTimer(() => { if (!client) endAll() }, FIRST_CLIENT_MS)
  let ended = false

  const send = (socket, message) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n') }
  const emit = message => { if (client) send(client, message) }

  function spawnShell({ id, file, args, options, meta }) {
    const checked = spawnOptions(options)
    if (typeof id !== 'string' || !SHELL_ID.test(id) || shells.has(id) || typeof file !== 'string' || !file || file.includes('\0') || !strings(args) || !checked) {
      return { type: 'spawn-error', id, message: '셸 요청이 올바르지 않습니다.' }
    }
    if (meta !== undefined && JSON.stringify(meta).length > MAX_META_CHARS) return { type: 'spawn-error', id, message: '셸 정보가 너무 깁니다.' }
    let pty
    try {
      pty = spawn(file, args, checked)
    } catch (error) {
      return { type: 'spawn-error', id, message: String(error?.message ?? error) }
    }
    const shell = { pty, pid: pty.pid, meta: meta ?? null, buffer: '', cols: checked.cols, rows: checked.rows, exited: false, exitCode: null }
    shells.set(id, shell)
    pty.onData(data => {
      shell.buffer += data
      // Trimmed now and then: cutting on every chunk copies the whole buffer each time
      if (shell.buffer.length > BUFFER_CHARS * 2) shell.buffer = shell.buffer.slice(-BUFFER_CHARS)
      emit({ type: 'data', id, data })
    })
    pty.onExit(({ exitCode }) => {
      shell.exited = true
      shell.exitCode = exitCode ?? null
      emit({ type: 'exit', id, exitCode: shell.exitCode })
    })
    return { type: 'spawned', id, pid: shell.pid }
  }

  function list() {
    return [...shells].map(([id, shell]) => ({
      id, pid: shell.pid, meta: shell.meta, buffer: shell.buffer.slice(-BUFFER_CHARS), cols: shell.cols, rows: shell.rows, exited: shell.exited, exitCode: shell.exitCode
    }))
  }

  function handle(socket, message) {
    const shell = typeof message.id === 'string' ? shells.get(message.id) : undefined
    switch (message.type) {
      case 'spawn': return send(socket, spawnShell(message))
      case 'write':
        if (shell && !shell.exited && typeof message.data === 'string' && message.data.length <= MAX_WRITE_CHARS) shell.pty.write(message.data)
        return
      case 'resize':
        if (shell && !shell.exited && TERMINAL_SIZE(message.cols) && TERMINAL_SIZE(message.rows)) {
          shell.cols = message.cols
          shell.rows = message.rows
          try { shell.pty.resize(message.cols, message.rows) } catch { /* ended meanwhile */ }
        }
        return
      case 'kill':
        if (shell && !shell.exited) try { shell.pty.kill() } catch { /* already gone */ }
        return
      case 'meta':
        if (shell && JSON.stringify(message.meta ?? null).length <= MAX_META_CHARS) shell.meta = message.meta ?? null
        return
      case 'forget':
        if (shell?.exited) shells.delete(message.id)
        return
      case 'layout':
        if (JSON.stringify(message.layout ?? null).length <= MAX_LAYOUT_CHARS) layout = message.layout ?? null
        return
      case 'list': return send(socket, { type: 'list', shells: list(), layout })
      case 'keep':
        keepUntil = now() + Math.min(MAX_KEEP_MS, Math.max(0, Number(message.ms) || 0))
        return send(socket, { type: 'kept', until: keepUntil })
      case 'shutdown': return endAll()
      default:
    }
  }

  /** Every shell ends with everything started in it, then the host */
  function endAll() {
    if (ended) return
    ended = true
    clearTimer(waitTimer)
    for (const shell of shells.values()) {
      if (shell.exited) continue
      if (Number.isInteger(shell.pid) && shell.pid > 0) try { killTree(shell.pid) } catch { /* gone */ }
      try { shell.pty.kill() } catch { /* gone */ }
    }
    client?.destroy()
    exit()
  }

  function disconnected(socket) {
    if (client !== socket || ended) return
    client = null
    const left = keepUntil - now()
    keepUntil = 0
    if (left <= 0) return endAll()
    clearTimer(waitTimer)
    waitTimer = setTimer(() => { if (!client) endAll() }, left)
  }

  /** A new connection: it must say hello with the token first, then it becomes the client */
  function connection(socket) {
    let pending = ''
    let greeted = false
    socket.setEncoding?.('utf8')
    const helloTimer = setTimer(() => { if (!greeted) socket.destroy() }, HELLO_MS)
    socket.on('data', chunk => {
      pending += chunk
      if (pending.length > MAX_LINE_CHARS) return socket.destroy()
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        let message
        try { message = JSON.parse(line) } catch { return socket.destroy() }
        if (!message || typeof message !== 'object') return socket.destroy()
        if (!greeted) {
          if (message.type !== 'hello' || !sameToken(message.token, token)) return socket.destroy()
          // Another app may take over only from one quitting to install an update (it said keep). A second
          // app that found the pipe while the first still works in it (a dev run sharing the user data
          // folder) took every shell away from it, and they all ended when it quit (2026-11-27 user report).
          if (client && !client.destroyed && keepUntil === 0) {
            send(socket, { type: 'busy' })
            return socket.destroy()
          }
          greeted = true
          clearTimer(helloTimer)
          // The next app is the one that counts: the connection of the app that is quitting is let go
          const previous = client
          client = socket
          if (previous) previous.destroy()
          clearTimer(waitTimer)
          keepUntil = 0
          send(socket, { type: 'hello', format: FORMAT, pid: process.pid })
          continue
        }
        if (client === socket) handle(socket, message)
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimer(helloTimer)
      if (greeted) disconnected(socket)
    })
  }

  return { connection, list, endAll, shells }
}

function killTreeWindows(pid) {
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
  execFileSync(taskkill, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
}

function main() {
  const pipe = process.env.EZSHELL_SESSIONS_PIPE
  const token = process.env.EZSHELL_SESSIONS_TOKEN
  const ptyFolder = process.env.EZSHELL_SESSIONS_PTY
  // Nothing of this reaches the shells
  for (const name of ['EZSHELL_SESSIONS_PIPE', 'EZSHELL_SESSIONS_TOKEN', 'EZSHELL_SESSIONS_PTY', 'ELECTRON_RUN_AS_NODE']) delete process.env[name]
  if (!pipe || !/^\\\\\.\\pipe\\ezshell-sessions-[0-9a-f]{32}$/.test(pipe) || !token || token.length < 32 || !ptyFolder || !path.isAbsolute(ptyFolder)) process.exit(2)
  const pty = require(ptyFolder)
  const server = net.createServer()
  const host = createSessionHost({
    spawn: pty.spawn,
    token,
    killTree: process.platform === 'win32' ? killTreeWindows : pid => process.kill(-pid, 'SIGKILL'),
    exit: () => { server.close(); setTimeout(() => process.exit(0), 200).unref() }
  })
  server.on('connection', socket => host.connection(socket))
  server.on('error', () => process.exit(3))
  server.listen(pipe)
}

if (require.main === module) main()

module.exports = { createSessionHost, spawnOptions, FORMAT, BUFFER_CHARS }
