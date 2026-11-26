// The app's side of the session host (host.js): starts it from the runtime copy, connects on its pipe,
// and gives localShell.js a `spawn` with node-pty's shape, so a shell there works like one in the app.
// Shells of an earlier app that quit to install an update are listed (`adoptable`) for localShell.js to
// take back. Design: docs/plan/2026-11-26-sessions-survive-update.md
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { spawn: spawnProcess } = require('node:child_process')

const STATE_FILE = 'session-host.json'
const CONNECT_TRIES = 40
const CONNECT_GAP_MS = 150
const REPLY_MS = 5000

const readState = file => {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof state?.pipe === 'string' && typeof state.token === 'string' ? state : null
  } catch { return null }
}

function writeState(file, state) {
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

/** A node-pty-shaped shell whose process lives in the host */
function remotePty(id, send) {
  const dataListeners = []
  const exitListeners = []
  const pty = {
    pid: 0,
    onData: listener => { dataListeners.push(listener); return { dispose() { dataListeners.splice(dataListeners.indexOf(listener) >>> 0, 1) } } },
    onExit: listener => { exitListeners.push(listener); return { dispose() { exitListeners.splice(exitListeners.indexOf(listener) >>> 0, 1) } } },
    write: data => send({ type: 'write', id, data }),
    resize: (cols, rows) => send({ type: 'resize', id, cols, rows }),
    kill: () => send({ type: 'kill', id }),
    hosted: true
  }
  let ended = false
  const control = {
    pty,
    data: data => dataListeners.forEach(listener => listener(data)),
    exit: exitCode => {
      if (ended) return
      ended = true
      exitListeners.forEach(listener => listener({ exitCode }))
    }
  }
  return control
}

/**
 * @param {object} deps
 * @param {string} deps.stateFolder where the pipe name and token are kept for the next app (userData)
 * @param {() => ({ exe: string, ptyDir: string, hostScript: string } | null)} deps.runtime the runtime copy (runtimeCopy.js)
 */
function createSessionHostClient({ stateFolder, runtime, spawn = spawnProcess, connect = net.connect, platform = process.platform, env = process.env }) {
  const stateFile = path.join(stateFolder, STATE_FILE)
  const remotes = new Map()
  let socket = null
  let adoptable = []
  let keptLayout = null
  let waiting = []
  let lost = false

  function send(message) {
    if (socket && !socket.destroyed) socket.write(JSON.stringify(message) + '\n')
  }

  function nextReply(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting = waiting.filter(entry => entry.resolve !== resolve)
        reject(new Error(`no ${type} from the session host`))
      }, REPLY_MS)
      waiting.push({ type, resolve: value => { clearTimeout(timer); resolve(value) } })
    })
  }

  function received(message) {
    const remote = typeof message.id === 'string' ? remotes.get(message.id) : undefined
    if (message.type === 'data') return remote?.data(message.data)
    if (message.type === 'exit') return remote?.exit(message.exitCode)
    if (message.type === 'spawned' && remote) remote.pty.pid = message.pid
    if (message.type === 'spawn-error' && remote) {
      remote.data(`\r\n[셸을 열지 못했습니다: ${message.message}]\r\n`)
      remote.exit(-1)
    }
    const index = waiting.findIndex(entry => entry.type === message.type)
    if (index >= 0) waiting.splice(index, 1)[0].resolve(message)
  }

  function attachSocket(connection) {
    let pending = ''
    connection.setEncoding('utf8')
    connection.on('data', chunk => {
      pending += chunk
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        try { received(JSON.parse(line)) } catch { /* a broken line is dropped */ }
      }
    })
    connection.on('error', () => {})
    connection.on('close', () => {
      if (socket !== connection) return
      socket = null
      lost = true
      // The host went away: its shells went with it
      for (const remote of remotes.values()) remote.exit(-1)
    })
  }

  function tryConnect(pipe) {
    return new Promise(resolve => {
      const connection = connect(pipe)
      connection.once('connect', () => resolve(connection))
      connection.once('error', () => resolve(null))
    })
  }

  async function greet(connection, token) {
    socket = connection
    attachSocket(connection)
    const hello = nextReply('hello')
    send({ type: 'hello', token })
    await hello
  }

  /** The host of an earlier app that kept its shells for this one, if there is one */
  async function reattach() {
    const state = readState(stateFile)
    if (!state) return false
    const connection = await tryConnect(state.pipe)
    if (!connection) return false
    try {
      await greet(connection, state.token)
      const reply = nextReply('list')
      send({ type: 'list' })
      const kept = await reply
      adoptable = kept.shells.filter(shell => !shell.exited)
      keptLayout = adoptable.length ? kept.layout ?? null : null
      return true
    } catch {
      connection.destroy()
      socket = null
      return false
    }
  }

  async function launch() {
    const copy = runtime()
    if (!copy) return false
    const pipe = `\\\\.\\pipe\\ezshell-sessions-${randomBytes(16).toString('hex')}`
    const token = randomBytes(32).toString('base64url')
    const child = spawn(copy.exe, [copy.hostScript], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', EZSHELL_SESSIONS_PIPE: pipe, EZSHELL_SESSIONS_TOKEN: token, EZSHELL_SESSIONS_PTY: copy.ptyDir }
    })
    child.on('error', () => {})
    child.unref()
    for (let tries = 0; tries < CONNECT_TRIES; tries++) {
      const connection = await tryConnect(pipe)
      if (connection) {
        await greet(connection, token)
        writeState(stateFile, { pipe, token, pid: child.pid })
        return true
      }
      await new Promise(resolve => setTimeout(resolve, CONNECT_GAP_MS))
    }
    return false
  }

  let starting = null
  /** Connects (taking back a kept host first). Resolves false when shells stay in the app. */
  function start() {
    if (platform !== 'win32') return Promise.resolve(false)
    starting ??= (async () => (await reattach()) || (await launch()))().catch(() => false)
    return starting
  }

  const ready = () => Boolean(socket) && !lost

  /** node-pty's spawn, with the shell's id and what the next app needs to take it back */
  function spawnShell(id, file, args, options, meta) {
    const remote = remotePty(id, send)
    remotes.set(id, remote)
    send({ type: 'spawn', id, file, args, options: { name: options.name, cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env }, meta })
    return remote.pty
  }

  /** A kept shell of the earlier app, as a node-pty-shaped shell again */
  function adopt(shell) {
    const remote = remotePty(shell.id, send)
    remote.pty.pid = shell.pid
    remotes.set(shell.id, remote)
    return remote.pty
  }

  return {
    start,
    ready,
    spawn: spawnShell,
    adopt,
    takeAdoptable: () => { const shells = adoptable; adoptable = []; return shells },
    setMeta: (id, meta) => send({ type: 'meta', id, meta }),
    /** The window's tab layout, for the window of the next app (given once) */
    setLayout: layout => send({ type: 'layout', layout }),
    takeKeptLayout: () => { const layout = keptLayout; keptLayout = null; return layout },
    forget: id => { remotes.delete(id); send({ type: 'forget', id }) },
    /**
     * Before quitting to install an update: the host waits this long for the next app. Awaited before
     * the quit starts, since a write left in the pipe when the app ends could be lost (the host would
     * then end the shells, as for any quit).
     */
    keep: async ms => {
      if (!ready()) return false
      const reply = nextReply('kept')
      send({ type: 'keep', ms })
      try { await reply; return true } catch { return false }
    },
    /** Quitting: the host ends every shell and itself */
    shutdown: () => {
      send({ type: 'shutdown' })
      try { fs.rmSync(stateFile, { force: true }) } catch { /* the next start finds no host there */ }
    },
    /** For the update path: lets the socket go without shutdown, so keep applies */
    release: () => { socket?.end(); socket = null }
  }
}

module.exports = { createSessionHostClient, remotePty, STATE_FILE }
