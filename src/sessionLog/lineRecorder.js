// Turns raw terminal output into the lines a person would read on screen.
// A headless xterm interprets the stream (colours, cursor moves, line editing, wrapping, wide
// characters); each time a line feed is processed, the line that was just completed is handed out.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS and free of Electron imports.
const { Terminal } = require('@xterm/headless')

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
/** Only the line being completed is read, so a short scrollback is enough */
const SCROLLBACK_LINES = 200
const ALT_SCREEN_NOTE = '[전체 화면 프로그램 구간은 기록하지 않습니다]'

const isSize = (value) => Number.isInteger(value) && value > 0

function createLineRecorder({ cols = DEFAULT_COLS, rows = DEFAULT_ROWS, onLine }) {
  const term = new Terminal({
    cols: isSize(cols) ? cols : DEFAULT_COLS,
    rows: isSize(rows) ? rows : DEFAULT_ROWS,
    scrollback: SCROLLBACK_LINES,
    allowProposedApi: true
  })

  const emit = (text) => {
    try {
      onLine(text)
    } catch {
      // A failing log must never affect the terminal
    }
  }

  /**
   * A row that continues on the next one, as text. When a wide character (Hangul, CJK) did not fit
   * into the last column, the terminal left that column empty and moved the character down; that
   * padding is not part of the line.
   */
  function continuedRow(line, next) {
    const text = line.translateToString(false)
    const lastCell = line.getCell(line.length - 1)
    // Width 1 and no character: an empty column. (The second half of a wide character has width 0.)
    const isEmptyColumn = lastCell && lastCell.getChars() === '' && lastCell.getWidth() === 1
    const isPadding = isEmptyColumn && next?.getCell(0)?.getWidth() === 2
    return isPadding ? text.slice(0, -1) : text
  }

  /**
   * The whole line that ends at `row`: a line wider than the terminal continues over wrapped rows.
   * Trailing blanks (for example where characters were erased) are dropped.
   */
  function logicalLine(row) {
    const buffer = term.buffer.active
    let start = row
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--
    let text = ''
    for (let y = start; y <= row; y++) {
      const line = buffer.getLine(y)
      if (!line) continue
      text += y === row ? line.translateToString(true) : continuedRow(line, buffer.getLine(y + 1))
    }
    return text.trimEnd()
  }

  // These handlers run inside xterm's own (timer driven) parsing, outside any caller's try/catch
  const guarded = (handler) => (...args) => {
    try {
      handler(...args)
    } catch {
      // A line that cannot be read is skipped; the terminal is never affected
    }
  }

  term.onLineFeed(guarded(() => {
    const buffer = term.buffer.active
    // A full-screen program (vim, top) draws by position; its screen is not a sequence of lines
    if (buffer.type !== 'normal') return
    const row = buffer.baseY + buffer.cursorY - 1
    if (row >= 0) emit(logicalLine(row))
  }))
  term.buffer.onBufferChange(guarded((buffer) => {
    if (buffer.type === 'alternate') emit(ALT_SCREEN_NOTE)
  }))

  let disposed = false
  /** Resolvers of finish() calls still waiting for the terminal to catch up */
  let waiting = []
  const release = () => {
    const resolvers = waiting
    waiting = []
    resolvers.forEach(resolve => resolve())
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    try { term.dispose() } catch { /* already gone */ }
    release()
  }

  return {
    /** `data` is a string or raw bytes; bytes keep a multi-byte character whole across chunks. */
    write(data) {
      if (!disposed) term.write(data)
    },
    resize(nextCols, nextRows) {
      if (!disposed && isSize(nextCols) && isSize(nextRows)) term.resize(nextCols, nextRows)
    },
    /**
     * Resolves once everything written so far is recorded, including an unfinished last line (a prompt).
     * Also resolves when the recorder is disposed meanwhile, so nobody waits forever.
     */
    finish() {
      if (disposed) return Promise.resolve()
      return new Promise((resolve) => {
        waiting = [...waiting, resolve]
        term.write('', guarded(() => {
          if (disposed) return
          const buffer = term.buffer.active
          if (buffer.type === 'normal') {
            const last = logicalLine(buffer.baseY + buffer.cursorY)
            if (last.trim() !== '') emit(last)
          }
          dispose()
        }))
      })
    },
    /** Drop the terminal without recording what is still unprocessed. */
    dispose
  }
}

module.exports = { createLineRecorder, ALT_SCREEN_NOTE }
