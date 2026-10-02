// One background job on its own exec channel: output is passed on as it arrives, and the job is
// stopped when asked to, at its time limit, or when it prints too much.
const { GatewayError, createReporter, CLOSE_GRACE_MS, CANCELLED_MESSAGE, DROPPED_MESSAGE, OPEN_FAILED_MESSAGE } = require('./gatewayShared.js')

/** A job that prints more than this is stopped: nobody reads that much, and decoding it keeps the main process busy */
const DEFAULT_MAX_JOB_OUTPUT_BYTES = 16 * 1024 * 1024
const PID_MARKER = '__EZSHELL_JOB_PID__'
/**
 * First line of every job script: the shell tells its pid on stderr. sshd starts a command without a
 * terminal as the leader of a new process group, so this pid is also the id of the job's process group.
 */
const PID_LINE = `echo "${PID_MARKER}$$" >&2`
const PID_PATTERN = new RegExp(`^${PID_MARKER}(\\d{1,7})\\r?$`)
/** Login scripts may print to stderr before the pid line; it is looked for within this much output */
const MAX_PID_SCAN_BYTES = 4096
const MAX_PID_LINE_BYTES = 256
const NEWLINE = 0x0a
/** A job stopped before its pid line arrived keeps its channel open this long, waiting for the line */
const DEFAULT_PID_WAIT_MS = 1000
/** Output is handed on in batches: a job that prints a byte at a time must not cost one event per byte */
const OUTPUT_BATCH_MS = 50
/** Pieces per batch; beyond this, output joins the last piece whichever stream it came from */
const MAX_BATCH_PARTS = 64

/**
 * Finds the pid line in the first stderr output and takes it out. `push(chunk)` returns the bytes
 * to pass on as output; `flush()` returns what is still held back.
 */
function createPidScanner(onPid) {
  let pending = Buffer.alloc(0)
  let scanned = 0
  let scanning = true
  const giveUp = () => {
    scanning = false
    const rest = pending
    pending = Buffer.alloc(0)
    return rest
  }
  return {
    push(chunk) {
      if (!scanning) return chunk
      pending = Buffer.concat([pending, chunk])
      const passed = []
      let newline = pending.indexOf(NEWLINE)
      while (scanning && newline !== -1) {
        const line = pending.subarray(0, newline)
        pending = pending.subarray(newline + 1)
        scanned += newline + 1
        const match = PID_PATTERN.exec(line.toString('latin1'))
        if (match) {
          scanning = false
          // 0 and 1 are never a job's own group: `kill -- -1` would signal every process of the account
          const pid = Number(match[1])
          if (pid > 1) onPid(pid)
        } else {
          passed.push(line, Buffer.from('\n'))
          if (scanned > MAX_PID_SCAN_BYTES) scanning = false
        }
        newline = pending.indexOf(NEWLINE)
      }
      if (!scanning || pending.length > MAX_PID_LINE_BYTES) passed.push(giveUp())
      return Buffer.concat(passed)
    },
    flush: giveUp,
    /** Whether the pid line may still come */
    isScanning: () => scanning
  }
}

/** Collects output for OUTPUT_BATCH_MS and hands it on as a few pieces, in arrival order. */
function createBatcher(onOutput) {
  if (typeof onOutput !== 'function') return { add() {}, flush() {} }
  let parts = []
  let timer = null
  const flush = () => {
    clearTimeout(timer)
    timer = null
    const batch = parts
    parts = []
    for (const part of batch) {
      try {
        onOutput(part.stream, part.text)
      } catch {
        // Watching must never affect the job
      }
    }
  }
  return {
    add(stream, text) {
      const last = parts[parts.length - 1]
      if (last && (last.stream === stream || parts.length >= MAX_BATCH_PARTS)) {
        parts = [...parts.slice(0, -1), { stream: last.stream, text: last.text + text }]
      } else {
        parts = [...parts, { stream, text }]
      }
      if (timer === null) timer = setTimeout(flush, OUTPUT_BATCH_MS)
    },
    flush
  }
}

/**
 * Open a channel and start `script` (it must begin with PID_LINE). Resolves once the channel is open
 * with `{ stop(), done }`; `done` resolves (never rejects) with
 * `{ exitCode, signal, timedOut, cancelled, dropped, overflow, unconfirmed }`. `unconfirmed` means the
 * job was stopped but neither did the server report its end nor could it be killed by pid: it may
 * still be running there.
 * `signal` and `openTimeoutMs` only apply until the channel is open; a channel that opens after the
 * caller gave up is stopped right away. `onEnd()` is called once when nothing of this job is left on
 * the connection (it never opened, or it ended), also for a job the caller gave up on.
 */
function openJobChannel(client, script, { limitMs, openTimeoutMs, signal, onOutput, onEnd = () => {}, maxOutputBytes = DEFAULT_MAX_JOB_OUTPUT_BYTES, pidWaitMs = DEFAULT_PID_WAIT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const batch = createBatcher(onOutput)
    const reportStdout = createReporter(batch.add, 'stdout')
    const reportStderr = createReporter(batch.add, 'stderr')
    const flags = { timedOut: false, cancelled: false, dropped: false, overflow: false }
    let stream = null
    let pid = null
    let received = 0
    let abandoned = false
    let stopped = false
    let closeSent = false
    let killSent = false
    let killInFlight = false
    /** How the channel closed, kept while the kill command is still on its way */
    let heldEnd = null
    let done = false
    let ended = false
    let limitTimer = null
    let graceTimer = null
    let pidTimer = null
    let settleDone = () => {}
    const whenDone = new Promise((settle) => { settleDone = settle })
    const end = () => {
      if (ended) return
      ended = true
      onEnd()
    }

    /**
     * The job is over. While the kill command is in flight this waits for it (unless `force`): the
     * caller may close the connection as soon as the job is reported as ended, and a kill that has
     * not reached the server by then would be lost.
     */
    const finish = (code, signalName, force = false) => {
      if (done) return
      if (killInFlight && !force) { heldEnd = heldEnd || [code, signalName]; return }
      const [endCode, endSignal] = heldEnd || [code, signalName]
      done = true
      clearTimeout(limitTimer)
      clearTimeout(graceTimer)
      clearTimeout(pidTimer)
      client.removeListener('close', onDrop)
      client.removeListener('error', onDrop)
      pass(reportStderr, scanner.flush())
      reportStdout.end()
      reportStderr.end()
      batch.flush()
      const exitCode = typeof endCode === 'number' ? endCode : null
      const unconfirmed = stopped && !killSent && exitCode === null && !endSignal
      settleDone({ exitCode, signal: endSignal || null, ...flags, unconfirmed })
      end()
    }
    const closeStream = () => {
      if (closeSent) return
      closeSent = true
      clearTimeout(pidTimer)
      try { stream.close() } catch { /* already closed */ }
    }
    /**
     * Servers before OpenSSH 7.9 ignore the channel's KILL request, so the process group is killed by
     * command as well; by pid alone where the shell turns out not to lead a group.
     */
    const killGroup = () => {
      if (killSent || pid === null || done) return
      killSent = true
      killInFlight = true
      const landed = () => {
        if (!killInFlight) return
        killInFlight = false
        if (heldEnd) finish(heldEnd[0], heldEnd[1])
      }
      try {
        client.exec(`kill -KILL -- -${pid} 2>/dev/null || kill -KILL ${pid}`, (err, killer) => {
          if (err || !killer) { landed(); return }
          killer.on('close', landed)
          killer.on('error', landed)
          if (typeof killer.resume === 'function') killer.resume()
          if (killer.stderr && typeof killer.stderr.resume === 'function') killer.stderr.resume()
        })
      } catch {
        // The connection is gone; nothing more can be done from here
        landed()
      }
    }
    /**
     * Stop the job: the KILL request at once; the kill command and closing the channel once the pid
     * is known. Closing first could cut off the pid line, and with it the only way to kill the job
     * on a server that ignores the KILL request.
     */
    const halt = () => {
      if (done) return
      if (!stopped) {
        stopped = true
        graceTimer = setTimeout(() => finish(null, null, true), CLOSE_GRACE_MS + pidWaitMs)
        try { stream.signal('KILL') } catch { /* server may not support signals */ }
        if (pid === null && scanner.isScanning()) pidTimer = setTimeout(closeStream, pidWaitMs)
        else closeStream()
      }
      killGroup()
    }
    const scanner = createPidScanner((found) => {
      pid = found
      if (!stopped) return
      killGroup()
      closeStream()
    })
    function pass(reporter, chunk) {
      if (chunk.length === 0 || flags.overflow) return
      received += chunk.length
      if (received > maxOutputBytes) {
        if (!stopped) { flags.overflow = true; halt() }
        return
      }
      reporter.push(chunk)
    }
    function onDrop() {
      if (done) return
      flags.dropped = true
      finish(null, null, true)
    }
    const stop = () => {
      if (done) return
      if (!stopped) flags.cancelled = true
      halt()
    }

    const giveUp = (error) => {
      if (abandoned || stream) return
      abandoned = true
      clearTimeout(openTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(error)
    }
    function onAbort() { giveUp(new GatewayError(CANCELLED_MESSAGE)) }
    if (signal && signal.aborted) { end(); reject(new GatewayError(CANCELLED_MESSAGE)); return }
    const openTimer = setTimeout(() => giveUp(new GatewayError(OPEN_FAILED_MESSAGE, 'channel open timed out')), openTimeoutMs)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    try {
      client.exec(script, (err, opened) => {
        if (err) { giveUp(new GatewayError(OPEN_FAILED_MESSAGE, err.message)); end(); return }
        clearTimeout(openTimer)
        if (signal) signal.removeEventListener('abort', onAbort)
        stream = opened
        stream.on('data', (chunk) => pass(reportStdout, chunk))
        stream.stderr.on('data', (chunk) => pass(reportStderr, scanner.push(chunk)))
        stream.on('close', (code, signalName) => finish(code, signalName))
        stream.on('error', () => finish(null, null))
        client.on('close', onDrop)
        client.on('error', onDrop)
        // stdin stays open on purpose: ssh2 drops every signal (KILL) once the channel's stdin is ended.
        if (abandoned) { stop(); return }
        limitTimer = setTimeout(() => { flags.timedOut = true; halt() }, limitMs)
        resolve({ stop, done: whenDone })
      })
    } catch (err) {
      giveUp(new GatewayError(DROPPED_MESSAGE, err.message))
      end()
    }
  })
}

module.exports = { openJobChannel, PID_LINE, DEFAULT_MAX_JOB_OUTPUT_BYTES }
