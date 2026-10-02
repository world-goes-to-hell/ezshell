// Background jobs started through run_command: what is running, what each job printed and how far
// Claude has read. Output can contain secrets, so everything here stays in memory.
const crypto = require('crypto')

const DEFAULT_PER_SESSION = 3
/** A job holds a channel of the session's connection; OpenSSH allows 10 per connection by default */
const DEFAULT_TOTAL = 6
/** Characters of output kept per job (the end of it) */
const DEFAULT_KEEP_CHARS = 1024 * 1024
/** Characters handed out by one read */
const DEFAULT_READ_CHARS = 64 * 1024
const DEFAULT_KEEP_FINISHED = 20

const isRunning = (job) => job.state === 'running'

function snapshot(job) {
  return {
    id: job.id,
    sessionId: job.sessionId,
    sessionName: job.sessionName,
    command: job.command,
    cwd: job.cwd,
    limitMs: job.limitMs,
    state: job.state,
    exitCode: job.exitCode,
    signal: job.signal,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    unread: job.total - job.readAt,
    unconfirmed: job.unconfirmed
  }
}

function createJobStore({
  now = () => Date.now(),
  newId = () => `job-${crypto.randomBytes(4).toString('hex')}`,
  perSession = DEFAULT_PER_SESSION,
  total = DEFAULT_TOTAL,
  keepChars = DEFAULT_KEEP_CHARS,
  readChars = DEFAULT_READ_CHARS,
  keepFinished = DEFAULT_KEEP_FINISHED
} = {}) {
  let jobs = new Map()
  /** Reads and whenFinished() calls waiting for something to happen to a job, per job id */
  let waiters = new Map()

  const put = (job) => { jobs = new Map(jobs).set(job.id, job) }

  function wake(id) {
    const waiting = waiters.get(id)
    if (!waiting) return
    waiters.delete(id)
    waiting.forEach(resume => resume())
  }

  /** Resolves on the next change to the job, after `waitMs`, or when `signal` aborts. */
  function nextChange(id, waitMs, signal) {
    return new Promise((resolve) => {
      let timer = null
      const resume = () => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', resume)
        const waiting = waiters.get(id)
        if (waiting) waiting.delete(resume)
        resolve()
      }
      if (signal && signal.aborted) { resolve(); return }
      timer = setTimeout(resume, waitMs)
      if (signal) signal.addEventListener('abort', resume, { once: true })
      waiters.set(id, (waiters.get(id) || new Set()).add(resume))
    })
  }

  /** Why no more jobs can start for this session ('session' | 'total'), or null. */
  function canStart(sessionId) {
    const running = [...jobs.values()].filter(isRunning)
    if (running.length >= total) return 'total'
    if (running.filter(job => job.sessionId === sessionId).length >= perSession) return 'session'
    return null
  }

  /** Registers a job that is about to start; it counts against the limits from here on. */
  function create({ sessionId, sessionName, command, limitMs }) {
    const full = canStart(sessionId)
    if (full) return { error: full }
    let id = newId()
    while (jobs.has(id)) id = newId()
    put({
      id, sessionId, sessionName, command, limitMs,
      cwd: null, state: 'running', exitCode: null, signal: null, unconfirmed: false, startedAt: now(), finishedAt: null,
      text: '', total: 0, readAt: 0, stop: null, stopRequested: false
    })
    return { id }
  }

  function callStop(stop) {
    try {
      stop()
    } catch {
      // Stopping one job must not keep the others from being stopped
    }
  }

  /** The job's channel is open. False when the job is gone (the app locked meanwhile); the caller stops it. */
  function attach(id, { cwd, stop }) {
    const job = jobs.get(id)
    if (!job) return false
    put({ ...job, cwd, stop })
    if (job.stopRequested) callStop(stop)
    return true
  }

  /** The job never started. */
  function discard(id) {
    if (!jobs.has(id)) return
    jobs = new Map([...jobs].filter(([key]) => key !== id))
    wake(id)
  }

  function append(id, text) {
    const job = jobs.get(id)
    if (!job || !isRunning(job) || typeof text !== 'string' || text === '') return
    // Cut back only once twice the limit has piled up: cutting on every piece would copy the whole text each time
    const joined = job.text + text
    put({ ...job, text: joined.length > keepChars * 2 ? joined.slice(-keepChars) : joined, total: job.total + text.length })
    wake(id)
  }

  function prune() {
    const finished = [...jobs.values()].filter(job => !isRunning(job)).sort((a, b) => b.finishedAt - a.finishedAt)
    const dropped = new Set(finished.slice(keepFinished).map(job => job.id))
    if (dropped.size > 0) jobs = new Map([...jobs].filter(([id]) => !dropped.has(id)))
  }

  /** `unconfirmed`: the job was stopped, but the server neither reported its end nor could it be killed by pid. */
  function finish(id, { state, exitCode = null, signal = null, unconfirmed = false }) {
    const job = jobs.get(id)
    if (!job || !isRunning(job)) return
    put({ ...job, state, exitCode, signal, unconfirmed, finishedAt: now(), stop: null })
    prune()
    wake(id)
  }

  /** A read has nothing to wait for: the job is over (or gone), or a full read is ready. */
  function isReadReady(id) {
    const job = jobs.get(id)
    return !job || !isRunning(job) || job.total - job.readAt >= readChars
  }

  /**
   * The output Claude has not read yet (at most `readChars`). A running job is first given up to
   * `waitMs` to end: a job that prints steadily would otherwise be polled once per line.
   * `skipped` counts unread characters that were pushed out of the buffer.
   * Resolves with null when the job does not exist (any more).
   */
  async function read(id, { waitMs = 0, signal } = {}) {
    if (!jobs.has(id)) return null
    const deadline = Date.now() + waitMs
    while (!isReadReady(id) && Date.now() < deadline && !(signal && signal.aborted)) {
      await nextChange(id, deadline - Date.now(), signal)
    }
    const job = jobs.get(id)
    if (!job) return null
    const keptFrom = job.total - job.text.length
    const from = Math.max(job.readAt, keptFrom)
    const text = job.text.slice(from - keptFrom, from - keptFrom + readChars)
    const next = { ...job, readAt: from + text.length }
    put(next)
    return { job: snapshot(next), text, skipped: from - job.readAt, more: next.readAt < next.total }
  }

  /** The job once it has ended, or as it is after `waitMs`. Null when it does not exist. */
  async function whenFinished(id, waitMs) {
    const deadline = Date.now() + waitMs
    while (jobs.has(id) && isRunning(jobs.get(id)) && Date.now() < deadline) {
      await nextChange(id, deadline - Date.now())
    }
    return get(id)
  }

  function get(id) {
    const job = jobs.get(id)
    return job ? snapshot(job) : null
  }

  /** Asks a running job to stop; it ends through finish() when its channel reports back. */
  function stop(id) {
    const job = jobs.get(id)
    if (!job || !isRunning(job) || job.stopRequested) return false
    put({ ...job, stopRequested: true })
    if (job.stop) callStop(job.stop)
    return true
  }

  function stopWhere(matches) {
    for (const job of [...jobs.values()]) {
      if (isRunning(job) && matches(snapshot(job))) stop(job.id)
    }
  }

  /** Stop every job and forget everything, output included (the app locked or MCP was turned off). */
  function clear() {
    stopWhere(() => true)
    const waiting = [...waiters.keys()]
    jobs = new Map()
    waiting.forEach(wake)
    waiters = new Map()
  }

  /** Newest first; jobs started in the same millisecond keep the order they were created in, reversed. */
  const list = () => [...jobs.values()].reverse().sort((a, b) => b.startedAt - a.startedAt).map(snapshot)

  return { canStart, create, attach, discard, append, finish, read, whenFinished, get, stop, stopWhere, clear, list }
}

module.exports = { createJobStore }
