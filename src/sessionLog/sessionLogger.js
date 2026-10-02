// Session logs: the terminal output of a tab written to a text file, for the tabs the user turned it on for.
// Lines are written in batches with synchronous writes, so what is pending can be put on disk at once on quit.
// Nothing here may throw into the SSH data path.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const fs = require('fs')
const os = require('os')
const { createLineRecorder } = require('./lineRecorder.js')
const { buildLogPath, headerText, footerText, openLogFile } = require('./logFile.js')

const DEFAULT_FLUSH_MS = 200
/** Give up looking for a free file name after this many logs of one name in one second */
const MAX_NAME_ATTEMPTS = 50
const CREATE_FAILED_MESSAGE = '로그 파일을 만들 수 없습니다.'
const WRITE_FAILED_MESSAGE = '로그 파일에 쓸 수 없어 기록을 중단했습니다.'
const OVERFLOW_MESSAGE = '출력이 너무 많아 기록을 중단했습니다.'
const NOT_LOGGING_MESSAGE = '기록 중인 로그가 없습니다.'

function createSessionLogger({
  dir,
  openFile = openLogFile,
  ensureDir = (target) => fs.mkdirSync(target, { recursive: true }),
  exists = fs.existsSync,
  now = () => new Date(),
  createRecorder = createLineRecorder,
  onStopped = () => {},
  flushMs = DEFAULT_FLUSH_MS,
  eol = os.EOL
}) {
  /** sessionId → { sessionId, filePath, file, recorder, pending, timer, closed } */
  const active = new Map()
  /** Last terminal size per session, so a log started later interprets the output at the right width */
  const sizes = new Map()

  function freePath(name, date) {
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
      const candidate = buildLogPath(dir, name, date, attempt)
      if (!exists(candidate)) return candidate
    }
    throw new Error('no free log file name')
  }

  /** Close the file once. After this nothing may be written: the descriptor can belong to another file. */
  const closeQuietly = (entry) => {
    if (entry.closed) return
    entry.closed = true
    clearTimeout(entry.timer)
    entry.timer = null
    try { entry.file.close() } catch { /* already closed or gone */ }
  }

  /** Put the pending lines on disk. Throws when the file cannot be written. */
  function flush(entry) {
    clearTimeout(entry.timer)
    entry.timer = null
    if (entry.closed || entry.pending === '') return
    const text = entry.pending
    entry.pending = ''
    entry.file.write(text)
  }

  /** The log cannot go on: end it, leave the terminal alone, tell the window (once). */
  function fail(entry, message = WRITE_FAILED_MESSAGE) {
    if (entry.closed) return
    // While stop() is waiting for the recorder it reports the failure itself
    const wasActive = active.get(entry.sessionId) === entry
    if (wasActive) active.delete(entry.sessionId)
    entry.pending = ''
    entry.error = message
    closeQuietly(entry)
    try { entry.recorder.dispose() } catch { /* nothing to drop */ }
    if (!wasActive) return
    try {
      onStopped({ sessionId: entry.sessionId, filePath: entry.filePath, error: message })
    } catch {
      // The window may be gone
    }
  }

  function addLine(entry, text) {
    // A line the recorder still had in flight after the log ended
    if (entry.closed) return
    entry.pending += text + eol
    if (entry.timer !== null) return
    entry.timer = setTimeout(() => {
      try {
        flush(entry)
      } catch {
        fail(entry)
      }
    }, flushMs)
  }

  function start(sessionId, sessionName) {
    const running = active.get(sessionId)
    if (running) return { success: true, filePath: running.filePath }
    const startedAt = now()
    let filePath
    let file
    const entry = { sessionId, filePath: null, file: null, recorder: null, pending: '', timer: null, closed: false, error: null }
    try {
      ensureDir(dir)
      filePath = freePath(sessionName, startedAt)
      file = openFile(filePath)
      file.write(headerText(sessionName, startedAt) + eol)
      entry.filePath = filePath
      entry.file = file
      entry.recorder = createRecorder({ ...(sizes.get(sessionId) || {}), onLine: (text) => addLine(entry, text) })
    } catch {
      if (file) { try { file.close() } catch { /* nothing to close */ } }
      return { success: false, error: CREATE_FAILED_MESSAGE }
    }
    active.set(sessionId, entry)
    return { success: true, filePath }
  }

  /** Terminal output of a session; ignored unless that session is being logged. */
  function write(sessionId, data) {
    const entry = active.get(sessionId)
    if (!entry) return
    try {
      entry.recorder.write(data)
    } catch {
      // The recorder refuses more input (its queue is full): say so instead of leaving a silent gap
      fail(entry, OVERFLOW_MESSAGE)
    }
  }

  /** A line of our own (for example "재연결됨"), in order with the output. */
  function note(sessionId, text) {
    write(sessionId, `\r\n[${text}]\r\n`)
  }

  function resize(sessionId, cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return
    sizes.set(sessionId, { cols, rows })
    const entry = active.get(sessionId)
    if (!entry) return
    try {
      entry.recorder.resize(cols, rows)
    } catch {
      // Keep the previous size
    }
  }

  async function stop(sessionId) {
    const entry = active.get(sessionId)
    if (!entry) return { success: false, error: NOT_LOGGING_MESSAGE }
    // Out of the map first: output that arrives from now on is not part of this log
    active.delete(sessionId)
    try {
      await entry.recorder.finish()
      // A write failed while waiting: the file is already closed
      if (entry.closed) return { success: false, error: entry.error || WRITE_FAILED_MESSAGE, filePath: entry.filePath }
      entry.pending += footerText(now()) + eol
      flush(entry)
      return { success: true, filePath: entry.filePath }
    } catch {
      return { success: false, error: WRITE_FAILED_MESSAGE, filePath: entry.filePath }
    } finally {
      closeQuietly(entry)
      try { entry.recorder.dispose() } catch { /* nothing to drop */ }
    }
  }

  /**
   * On quit: no waiting for the recorder, just the lines it already produced and the footer.
   * Output it has not interpreted yet, and an unfinished last line, are not written.
   */
  function closeAllNow() {
    for (const entry of [...active.values()]) {
      active.delete(entry.sessionId)
      try {
        entry.pending += footerText(now()) + eol
        flush(entry)
      } catch {
        // Nothing more can be done for this file
      }
      closeQuietly(entry)
      try { entry.recorder.dispose() } catch { /* nothing to drop */ }
    }
  }

  return {
    start,
    write,
    note,
    resize,
    stop,
    closeAllNow,
    /** Forget the remembered size of a session that is gone */
    forget: (sessionId) => { sizes.delete(sessionId) },
    isLogging: (sessionId) => active.has(sessionId),
    list: () => [...active.values()].map(({ sessionId, filePath }) => ({ sessionId, filePath }))
  }
}

module.exports = { createSessionLogger }
