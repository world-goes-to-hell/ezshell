// Errors that nothing else keeps (docs/plan/2026-11-28-diagnostics.md): main's uncaught exceptions and
// unhandled rejections, renderer and helper processes that died, and the main window's console errors.
// One JSON line each in userData/logs/errors.log; past 1MB the file moves to errors.1.log.
// It only watches: `uncaughtException`/`unhandledRejection` listeners would change how Node handles them,
// so it takes `uncaughtExceptionMonitor` and the `warning` Electron's main emits for a rejection (measured
// 2026-11-28 on Electron 45: neither ends the app).
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const fs = require('fs')
const path = require('path')

const FILE_MAX_BYTES = 1024 * 1024
const TEXT_MAX = 2000
const RATE_PER_MINUTE = 50
const TAIL_BYTES = 256 * 1024
// The second warning of each rejection only explains the first
const REJECTION_HINT = 'Unhandled promise rejection. This error originated'
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

const clip = value => String(value ?? '').replace(CONTROL, '').slice(0, TEXT_MAX)
const textOf = error => (error instanceof Error ? (error.stack || `${error.name}: ${error.message}`) : clip(error))

/** `directory` is userData/logs */
function createErrorLog({ directory, now = Date.now }) {
  const file = path.join(directory, 'errors.log')
  const older = path.join(directory, 'errors.1.log')
  let window = { start: 0, count: 0 }

  function record(kind, message, extra = {}) {
    const at = now()
    if (at - window.start >= 60_000) window = { start: at, count: 0 }
    if (++window.count > RATE_PER_MINUTE) return false
    const line = JSON.stringify({ at, kind: clip(kind).slice(0, 40), message: clip(message), ...extra }) + '\n'
    try {
      fs.mkdirSync(directory, { recursive: true })
      const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0
      if (size + line.length > FILE_MAX_BYTES) fs.renameSync(file, older)
      fs.appendFileSync(file, line, { mode: 0o600 })
      return true
    } catch {
      return false // A log that cannot be written must not become an error of its own
    }
  }

  /** The last `count` records, oldest first (both files) */
  function recent(count = 50) {
    const lines = []
    for (const name of [older, file]) {
      try {
        const { size } = fs.statSync(name)
        const handle = fs.openSync(name, 'r')
        try {
          const length = Math.min(size, TAIL_BYTES)
          const buffer = Buffer.alloc(length)
          fs.readSync(handle, buffer, 0, length, size - length)
          const text = buffer.toString('utf8')
          lines.push(...(length < size ? text.slice(text.indexOf('\n') + 1) : text).split('\n'))
        } finally {
          fs.closeSync(handle)
        }
      } catch { /* No such file yet */ }
    }
    const parsed = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (Number.isFinite(entry.at) && typeof entry.kind === 'string' && typeof entry.message === 'string') parsed.push(entry)
      } catch { /* A line cut by a crash */ }
    }
    return parsed.slice(-count)
  }

  return {
    directory,
    record,
    recent,

    /** Watch the process (main.js calls this once, early) */
    watchProcess(proc = process) {
      proc.on('uncaughtExceptionMonitor', (error, origin) => record('main-exception', textOf(error), { origin: clip(origin).slice(0, 40) }))
      proc.on('warning', warning => {
        if (warning?.name !== 'UnhandledPromiseRejectionWarning' || String(warning.message).startsWith(REJECTION_HINT)) return
        record('main-rejection', warning.message)
      })
    },

    /** Watch Electron's app for processes that died */
    watchApp(app) {
      app.on('render-process-gone', (_event, contents, details) => {
        if (details?.reason === 'clean-exit') return
        let page = ''
        try { page = new URL(contents.getURL()).pathname.split('/').pop() } catch {}
        record('renderer-gone', `${details?.reason} (exit ${details?.exitCode})`, { page: clip(page).slice(0, 80) })
      })
      app.on('child-process-gone', (_event, details) => {
        if (!details || details.reason === 'clean-exit') return
        record('child-gone', `${details.type}${details.name ? ' ' + details.name : ''}: ${details.reason} (exit ${details.exitCode})`)
      })
    },

    /** Console errors of one of the app's own windows (never a browser tab's page) */
    watchConsole(contents, label) {
      contents.on('console-message', (event, legacyLevel, legacyMessage, legacyLine, legacySource) => {
        // Electron 45 gives one event object; older versions gave the values as arguments
        const level = event?.level ?? legacyLevel
        if (level !== 'error' && level !== 3) return
        const message = event?.message ?? legacyMessage
        const source = event?.sourceId ?? legacySource ?? ''
        const line = event?.lineNumber ?? legacyLine
        let where = ''
        try { where = source ? new URL(source).pathname.split('/').pop() + (line ? ':' + line : '') : '' } catch {}
        record('console-error', message, { window: clip(label).slice(0, 40), ...(where ? { where: clip(where).slice(0, 120) } : {}) })
      })
    }
  }
}

module.exports = { createErrorLog }
