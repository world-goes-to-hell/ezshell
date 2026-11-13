// Shells opened for a remote-access device: the PC connects to a saved session and opens a shell;
// the device only gets the shell's output and sends its input. Credentials never leave the PC.
// Nobody is at the PC to look at a new host key, so only saved keys are accepted (like MCP).
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const fs = require('fs')
const { StringDecoder } = require('string_decoder')
const { Client } = require('ssh2')
const { buildOptions, describeSshError } = require('../sshConnectionTest.js')
const { withHostKeyCheck, isHostKeyError } = require('../hostKeys/hostKeyCheck.js')
const { switchToRoot } = require('../rootSwitch.js')

const MAX_SHELLS = 6
const DEFAULT_CONNECT_TIMEOUT_SEC = 20
const KEEPALIVE_OPTIONS = { keepaliveInterval: 15000, keepaliveCountMax: 3 }
const MIN_SIZE = 10
const MAX_SIZE = 400

const MESSAGES = {
  tooMany: `원격 터미널은 ${MAX_SHELLS}개까지 열 수 있습니다.`,
  unknownSession: '세션을 찾을 수 없습니다.',
  hostKey: '이 서버의 호스트 키가 저장되어 있지 않거나 바뀌었습니다. PC 의 ezShell 에서 한 번 접속해 확인한 뒤 다시 시도하세요.',
  badConfig: '접속 정보를 읽지 못했습니다.',
  gone: '연결이 끊겨 터미널을 열지 않았습니다.'
}

const size = (value, fallback) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, n)) : fallback
}

const endQuietly = (client) => {
  try {
    client.end()
  } catch {
    // Already closed
  }
}

/**
 * @param {object} deps
 * @param {(id: string) => object | null} deps.findSession decrypted saved session (with its credentials)
 * @param {object} deps.hostKeys the app's host key store
 */
function createRemoteShells({ findSession, hostKeys, createClient = () => new Client(), readFile = fs.readFileSync }) {
  const shells = new Map()
  let nextId = 1
  /** Shells still connecting: they count toward the limit */
  let opening = 0
  // A shell takes seconds to open. Its device may leave, or the app may lock, meanwhile: closeAll
  // cannot close what is not in the map yet, so the opening shell checks these when it is ready.
  const goneOwners = new WeakSet()
  let epoch = 0

  function connectOnce(options, verifierFor) {
    return new Promise((resolve, reject) => {
      const clients = []
      let isSettled = false
      const fail = (err) => {
        if (isSettled) return
        isSettled = true
        clients.forEach(endQuietly)
        reject(err)
      }
      const connectTarget = (sock) => {
        const client = createClient()
        clients.push(client)
        client.on('ready', () => {
          if (isSettled) return
          isSettled = true
          resolve({ client, clients })
        })
        client.on('error', fail)
        client.connect({ ...KEEPALIVE_OPTIONS, ...options.target, hostVerifier: verifierFor(options.target.host, options.target.port), ...(sock ? { sock } : {}) })
      }
      if (!options.jump) {
        connectTarget(null)
        return
      }
      const jump = createClient()
      clients.push(jump)
      jump.on('ready', () => {
        jump.forwardOut('127.0.0.1', 0, options.target.host, options.target.port, (err, stream) => (err ? fail(err) : connectTarget(stream)))
      })
      jump.on('error', fail)
      jump.connect({ ...KEEPALIVE_OPTIONS, ...options.jump, hostVerifier: verifierFor(options.jump.host, options.jump.port) })
    })
  }

  /**
   * Opens a shell of a saved session. `onData` gets its output (text), `onClose` is called once
   * when it ends. Resolves with { shellId, name }; rejects with an Error whose message is for the screen.
   */
  async function open(sessionId, options) {
    if (shells.size + opening >= MAX_SHELLS) throw new Error(MESSAGES.tooMany)
    opening += 1
    try {
      return await connectShell(sessionId, options)
    } finally {
      opening -= 1
    }
  }

  async function connectShell(sessionId, { cols, rows, owner, onData, onClose }) {
    const startedIn = epoch
    const isGone = () => epoch !== startedIn || (owner !== undefined && owner !== null && goneOwners.has(owner))
    const session = findSession(sessionId)
    if (!session) throw new Error(MESSAGES.unknownSession)
    let options
    try {
      const seconds = Number(session.connectTimeout)
      options = buildOptions({ ...session, connectTimeout: (seconds > 0 ? seconds : DEFAULT_CONNECT_TIMEOUT_SEC) * 1000 }, readFile)
    } catch (err) {
      throw new Error(err.userMessage || MESSAGES.badConfig)
    }
    let connection
    try {
      connection = await withHostKeyCheck({ store: hostKeys }, (verifierFor) => connectOnce(options, verifierFor))
    } catch (err) {
      // The device is told why, without the server's address
      throw new Error(isHostKeyError(err) ? MESSAGES.hostKey : describeSshError(err).error)
    }
    if (isGone()) {
      connection.clients.forEach(endQuietly)
      throw new Error(MESSAGES.gone)
    }
    const stream = await new Promise((resolve, reject) => {
      connection.client.shell({ term: 'xterm-256color', cols: size(cols, 80), rows: size(rows, 24) }, (err, channel) => (err ? reject(err) : resolve(channel)))
    }).catch((err) => {
      connection.clients.forEach(endQuietly)
      throw new Error(describeSshError(err).error)
    })
    if (isGone()) {
      connection.clients.forEach(endQuietly)
      throw new Error(MESSAGES.gone)
    }

    const shellId = `r${nextId++}`
    let isClosed = false
    const close = () => {
      if (isClosed) return
      isClosed = true
      shells.delete(shellId)
      try {
        stream.close()
      } catch {
        // Already closed
      }
      connection.clients.forEach(endQuietly)
      onClose()
    }
    shells.set(shellId, { stream, owner, close })
    // A character of several bytes (한글) can be cut by a chunk's end: the decoder keeps the first half
    const text = new StringDecoder('utf8')
    const errorText = new StringDecoder('utf8')
    const pass = (decoder) => (chunk) => {
      const part = decoder.write(chunk)
      if (part) onData(part)
    }
    stream.on('data', pass(text))
    stream.stderr?.on('data', pass(errorText))
    stream.on('close', close)
    connection.client.on('close', close)
    connection.client.on('error', close)

    // Same as a tab: sessions set to become root do so right after the shell opens
    if (session.suRoot && session.suPassword) await switchToRoot(stream, { password: session.suPassword })
    return { shellId, name: String(session.name || '') }
  }

  const owned = (shellId, owner) => {
    const shell = shells.get(shellId)
    return shell && shell.owner === owner ? shell : null
  }

  function write(shellId, owner, data) {
    const shell = owned(shellId, owner)
    if (shell && typeof data === 'string') shell.stream.write(data)
  }

  function resize(shellId, owner, cols, rows) {
    const shell = owned(shellId, owner)
    if (shell) shell.stream.setWindow(size(rows, 24), size(cols, 80), 0, 0)
  }

  /** Stops reading the shell (the server's send window fills and the program waits) or reads on */
  function setPaused(shellId, owner, isPaused) {
    const shell = owned(shellId, owner)
    if (!shell) return
    if (isPaused) shell.stream.pause()
    else shell.stream.resume()
  }

  function close(shellId, owner) {
    owned(shellId, owner)?.close()
  }

  /** Every shell of one device connection (when it disconnects), or all of them (lock, switch off) */
  function closeAll(owner) {
    if (owner === undefined) epoch += 1
    else if (owner !== null && typeof owner === 'object') goneOwners.add(owner)
    for (const shell of [...shells.values()]) {
      if (owner === undefined || shell.owner === owner) shell.close()
    }
  }

  return { open, write, resize, setPaused, close, closeAll, count: () => shells.size }
}

module.exports = { createRemoteShells, MAX_SHELLS, MESSAGES }
