// SSH connections used by the MCP tools: one reusable connection per session, commands
// run one at a time per session, each from the working directory the gateway remembers.
const fs = require('fs')
const { Client } = require('ssh2')
const { buildOptions, describeSshError } = require('../sshConnectionTest.js')
const { shellQuote, quoteCdTarget } = require('./shellQuote.js')

const DEFAULT_IDLE_MS = 5 * 60 * 1000
const DEFAULT_EXEC_TIMEOUT_MS = 30 * 1000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
/** Same default as the connect dialog and the terminal path (sshConnectConfig.ts) */
const DEFAULT_CONNECT_TIMEOUT_SEC = 20
/** How long to wait for a stopped channel to report that it closed */
const CLOSE_GRACE_MS = 2000
/** Detect a dead peer within about 45s instead of waiting for TCP to give up */
const KEEPALIVE_OPTIONS = { keepaliveInterval: 15000, keepaliveCountMax: 3 }
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g
const CANCELLED_MESSAGE = '요청이 취소되었습니다.'
const DROPPED_MESSAGE = '서버와의 연결이 끊겼습니다.'
const CLOSED_MESSAGE = '세션 연결이 닫혔습니다.'
const HOME_FAILED_MESSAGE = '홈 디렉터리를 확인하지 못했습니다.'
const CD_FAILED_MESSAGE = '디렉터리로 이동할 수 없습니다.'
const CD_TIMEOUT_MESSAGE = '디렉터리 이동이 시간 제한을 넘었습니다.'
const CWD_CHANGED_MESSAGE = '작업 디렉터리가 바뀌어 실행하지 않았습니다. 다시 요청하세요.'
const CWD_MISSING_MESSAGE = (cwd) => `작업 디렉터리 ${cwd} 에 들어갈 수 없습니다. cd 로 다른 위치를 지정하세요.`
/** Printed by the cd guard when the remembered directory cannot be entered */
const CWD_MISSING_MARKER = '__EZSHELL_CWD_MISSING__'

class GatewayError extends Error {
  constructor(userMessage, detail) {
    super(userMessage)
    this.userMessage = userMessage
    this.detail = detail
  }
}

function createOutputBuffer(limit) {
  const chunks = []
  let size = 0
  let truncated = false
  return {
    push(chunk) {
      if (size >= limit) { truncated = true; return }
      const piece = chunk.length > limit - size ? chunk.subarray(0, limit - size) : chunk
      if (piece.length < chunk.length) truncated = true
      chunks.push(piece)
      size += piece.length
    },
    text: () => Buffer.concat(chunks).toString('utf8').replace(ANSI_PATTERN, ''),
    isTruncated: () => truncated
  }
}

const endQuietly = (client) => {
  try { client.end() } catch { /* already closed */ }
}
const lastLine = (text) => text.trim().split('\n').pop().trim()
const assertNotCancelled = (signal) => {
  if (signal && signal.aborted) throw new GatewayError(CANCELLED_MESSAGE)
}
const STDIN_OFF = 'exec </dev/null'
const cdGuard = (cwd) => `cd -- ${shellQuote(cwd)} || { echo '${CWD_MISSING_MARKER}' >&2; exit 1; }`
const isAnchoredPath = (target) => target.startsWith('/') || target === '~' || target.startsWith('~/')

/** The guard exits 1 right after printing the marker, so it is the last stderr line of a failed guard. */
function assertGuardPassed(result, cwd) {
  if (result.exitCode !== 1 || lastLine(result.stderr) !== CWD_MISSING_MARKER) return
  throw new GatewayError(CWD_MISSING_MESSAGE(cwd), result.stderr.split(CWD_MISSING_MARKER).join('').trim())
}

function createSessionGateway({
  createClient = () => new Client(),
  readFile = fs.readFileSync,
  idleMs = DEFAULT_IDLE_MS,
  execTimeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
} = {}) {
  const entries = new Map()
  /** Working directory per session id; kept across reconnects, idle drops and closeAll() */
  const cwds = new Map()

  function connect(session) {
    let options
    try {
      // Saved sessions keep connectTimeout in seconds; buildOptions hands it to ssh2 as milliseconds.
      const seconds = Number(session.connectTimeout)
      const connectTimeout = (seconds > 0 ? seconds : DEFAULT_CONNECT_TIMEOUT_SEC) * 1000
      options = buildOptions({ ...session, connectTimeout }, readFile)
    } catch (err) {
      return Promise.reject(new GatewayError(err.userMessage || '접속 정보를 읽지 못했습니다.', err.detail))
    }
    return new Promise((resolve, reject) => {
      const clients = []
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        clients.forEach(endQuietly)
        reject(new GatewayError(describeSshError(err).error, err.message))
      }
      const connectTarget = (sock) => {
        const client = createClient()
        clients.push(client)
        client.on('ready', () => {
          if (settled) return
          settled = true
          resolve({ client, clients })
        })
        client.on('error', fail)
        client.connect({ ...KEEPALIVE_OPTIONS, ...options.target, ...(sock ? { sock } : {}) })
      }
      if (!options.jump) { connectTarget(null); return }
      const jump = createClient()
      clients.push(jump)
      jump.on('ready', () => {
        jump.forwardOut('127.0.0.1', 0, options.target.host, options.target.port, (err, stream) => (err ? fail(err) : connectTarget(stream)))
      })
      jump.on('error', fail)
      jump.connect({ ...KEEPALIVE_OPTIONS, ...options.jump })
    })
  }

  /**
   * Run one command. Abort handling and the timeout start before the channel is requested, so an abort
   * or timeout that happens while the channel is still opening is applied as soon as it opens.
   */
  function exec(client, command, signal) {
    return new Promise((resolve, reject) => {
      const stdout = createOutputBuffer(maxOutputBytes)
      const stderr = createOutputBuffer(maxOutputBytes)
      let stream = null
      let timedOut = false
      let cancelled = false
      let stopped = false
      let done = false
      let graceTimer = null
      let timer = null
      const cleanup = () => {
        clearTimeout(timer)
        clearTimeout(graceTimer)
        if (signal) signal.removeEventListener('abort', onAbort)
        client.removeListener('close', onDrop)
        client.removeListener('error', onDrop)
      }
      const settle = (action, value) => {
        if (done) return
        done = true
        cleanup()
        action(value)
      }
      const finish = (code, signalName) => {
        if (done) return
        if (typeof code !== 'number' && !signalName && !stopped) {
          settle(reject, new GatewayError(DROPPED_MESSAGE))
          return
        }
        settle(resolve, {
          exitCode: typeof code === 'number' ? code : null,
          signal: signalName || null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.isTruncated() || stderr.isTruncated(),
          timedOut,
          cancelled
        })
      }
      const killStream = () => {
        try { stream.signal('KILL') } catch { /* server may not support signals */ }
        try { stream.close() } catch { /* already closed */ }
      }
      const stop = () => {
        stopped = true
        if (!graceTimer) graceTimer = setTimeout(() => finish(null, null), CLOSE_GRACE_MS)
        if (stream) killStream()
      }
      function onAbort() { cancelled = true; stop() }
      function onDrop() { settle(reject, new GatewayError(DROPPED_MESSAGE)) }

      if (signal && signal.aborted) { cancelled = true; stopped = true; finish(null, null); return }
      timer = setTimeout(() => { timedOut = true; stop() }, execTimeoutMs)
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      client.on('close', onDrop)
      client.on('error', onDrop)
      try {
        client.exec(command, (err, opened) => {
          if (err) { settle(reject, new GatewayError('명령을 실행할 채널을 열지 못했습니다.', err.message)); return }
          stream = opened
          stream.on('data', (chunk) => stdout.push(chunk))
          stream.stderr.on('data', (chunk) => stderr.push(chunk))
          stream.on('close', (code, signalName) => finish(code, signalName))
          stream.on('error', () => finish(null, null))
          // stdin stays open on purpose: ssh2 drops every signal (KILL) once the channel's stdin is ended.
          if (stopped) killStream()
        })
      } catch (err) {
        settle(reject, new GatewayError(DROPPED_MESSAGE, err.message))
      }
    })
  }

  function drop(sessionId, entry) {
    if (entries.get(sessionId) !== entry) return
    entries.delete(sessionId)
    clearTimeout(entry.idleTimer)
    entry.connection.then((conn) => conn.clients.forEach(endQuietly), () => {})
  }

  function getEntry(session) {
    const existing = entries.get(session.id)
    if (existing) return existing
    const entry = { idleTimer: null, queue: Promise.resolve(), connection: null }
    entry.connection = connect(session).then((conn) => {
      conn.client.on('close', () => drop(session.id, entry))
      conn.client.on('error', () => drop(session.id, entry))
      return conn
    })
    entry.connection.catch(() => drop(session.id, entry))
    entries.set(session.id, entry)
    return entry
  }

  function touch(sessionId, entry) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => drop(sessionId, entry), idleMs)
  }

  /** Queue a task on the session's connection; tasks of one session run one at a time. */
  function enqueue(session, signal, task) {
    if (signal && signal.aborted) return Promise.reject(new GatewayError(CANCELLED_MESSAGE))
    const entry = getEntry(session)
    const result = entry.queue.then(() => task(entry))
    entry.queue = result.catch(() => {})
    return result
  }

  const assertCurrent = (sessionId, entry) => {
    if (entries.get(sessionId) !== entry) throw new GatewayError(CLOSED_MESSAGE)
  }

  /**
   * Connect, learn the home directory the first time, and check the directory the user approved
   * (`expectedCwd`) is still the one the command would run in.
   */
  async function prepare(session, entry, signal, expectedCwd) {
    assertNotCancelled(signal)
    const { client } = await entry.connection
    assertNotCancelled(signal)
    assertCurrent(session.id, entry)
    if (!cwds.has(session.id)) {
      const home = await exec(client, 'pwd', signal)
      assertNotCancelled(signal)
      const dir = lastLine(home.stdout)
      if (home.cancelled || home.timedOut || home.exitCode !== 0 || !dir.startsWith('/')) {
        throw new GatewayError(HOME_FAILED_MESSAGE)
      }
      assertCurrent(session.id, entry)
      cwds.set(session.id, dir)
    }
    assertCurrent(session.id, entry)
    const cwd = cwds.get(session.id)
    if (expectedCwd !== undefined && cwd !== expectedCwd) throw new GatewayError(CWD_CHANGED_MESSAGE)
    touch(session.id, entry)
    return { client, cwd }
  }

  function resolveCwd(session, { signal } = {}) {
    return enqueue(session, signal, async (entry) => (await prepare(session, entry, signal)).cwd)
  }

  function run(session, command, { signal, expectedCwd } = {}) {
    return enqueue(session, signal, async (entry) => {
      const { client, cwd } = await prepare(session, entry, signal, expectedCwd)
      // The guard sits on its own line: `cd && cmd` would only guard the first pipeline of `a; b`.
      // STDIN_OFF gives `cat`, `grep x` or a password prompt EOF at once instead of hanging until the timeout.
      const result = await exec(client, `${cdGuard(cwd)}\n${STDIN_OFF}\n${command}`, signal)
      assertGuardPassed(result, cwd)
      touch(session.id, entry)
      return { cwd, ...result }
    })
  }

  function changeDirectory(session, target, { signal, expectedCwd } = {}) {
    return enqueue(session, signal, async (entry) => {
      const { client, cwd } = await prepare(session, entry, signal, expectedCwd)
      // An absolute or home path does not depend on the current directory, so it still works when that one is gone.
      const move = `cd -- ${quoteCdTarget(target)} && pwd`
      const result = await exec(client, isAnchoredPath(target) ? move : `${cdGuard(cwd)}\n${move}`, signal)
      if (result.cancelled) throw new GatewayError(CANCELLED_MESSAGE)
      if (result.timedOut) throw new GatewayError(CD_TIMEOUT_MESSAGE)
      assertGuardPassed(result, cwd)
      if (result.exitCode !== 0) throw new GatewayError(lastLine(result.stderr) || CD_FAILED_MESSAGE)
      const dir = lastLine(result.stdout)
      if (!dir.startsWith('/')) throw new GatewayError(CD_FAILED_MESSAGE)
      assertCurrent(session.id, entry)
      cwds.set(session.id, dir)
      touch(session.id, entry)
      return { cwd: dir }
    })
  }

  return {
    run,
    changeDirectory,
    resolveCwd,
    getCwd: (sessionId) => (cwds.has(sessionId) ? cwds.get(sessionId) : null),
    /** Directories outlive connections; this resets every session to its home directory (after a lock). */
    forgetCwds: () => cwds.clear(),
    close: (sessionId) => { const entry = entries.get(sessionId); if (entry) drop(sessionId, entry) },
    closeAll: () => [...entries.entries()].forEach(([sessionId, entry]) => drop(sessionId, entry))
  }
}

module.exports = { createSessionGateway, GatewayError }
