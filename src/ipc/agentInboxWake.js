const { Terminal } = require('@xterm/headless')

const PROMPT = 'Handle unread ezShell messages using the ezshell-cli-mcp tools.'
const PASTE = '\x1b[200~' + PROMPT + '\x1b[201~'
const DRAW_SETTLE = 35
const INPUT_TIMEOUT = 1500
const submitKey = data => /^(?:\r|\n|\x1b\[13(?:;1)?u)$/.test(data)
const compact = text => text.replace(/\s/g, '')

function createAgentInboxWake({ kind, cols, rows, pendingMessages, isWorking, write }) {
  const screen = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  const dispatched = new Set()
  let stopped = false
  let timer = null
  let stage = null
  let userDraft = false
  let composing = false
  let holdUntil = 0
  const prompt = kind === 'codex' ? /^\s*›[ \u00a0]/u : /^\s*[>❯][ \u00a0]/u

  function composer() {
    if (!screen.modes.bracketedPasteMode) return null
    const { active: buffer } = screen.buffer
    const cursor = buffer.baseY + buffer.cursorY
    const line = index => buffer.getLine(index)?.translateToString(false) ?? ''
    // A pasted line can wrap. Look above the cursor only as far as the app-written prompt.
    const first = Math.max(buffer.baseY, cursor - Math.ceil(PROMPT.length / Math.max(1, screen.cols - 2)) - 1)
    for (let index = cursor; index >= first; index--) {
      const row = line(index)
      const prefix = prompt.exec(row)
      if (!prefix) continue
      if (kind === 'claude' && !/^─{8,}\s*$/u.test(line(index - 1))) return null
      const tail = row.slice(prefix[0].length)
      const lines = Array.from({ length: cursor - index }, (_, offset) => line(index + offset + 1))
      // The empty prompt can have placeholder text to the right of the cursor.
      const atStart = index === cursor && buffer.cursorX === prefix[0].length
      const endsAtCursor = line(cursor).slice(buffer.cursorX).trim() === ''
      return { atStart, endsAtCursor, text: compact([tail, ...lines].join('')) }
    }
    return null
  }

  function schedule(delay = DRAW_SETTLE) {
    if (stopped) return
    clearTimeout(timer)
    timer = setTimeout(advance, delay)
    timer.unref?.()
  }

  function advance() {
    if (stopped || composing) return
    const now = Date.now()
    const waiting = pendingMessages().filter(id => !dispatched.has(id))
    const input = composer()
    if (stage) {
      const { expires } = stage
      if (now >= expires) {
        stage = null
        userDraft = true
        return
      }
      if (waiting.length && !isWorking() && input?.endsAtCursor && input.text === compact(PROMPT)) {
        // Send Enter only after the supported composer has rendered the exact draft we pasted.
        stage = null
        if (write('\r')) waiting.forEach(id => dispatched.add(id))
        holdUntil = now + INPUT_TIMEOUT
        schedule(INPUT_TIMEOUT)
      } else {
        schedule(expires - now)
      }
      return
    }
    if (!waiting.length || isWorking() || !input?.atStart || (userDraft && input.text)) return
    if (now < holdUntil) { schedule(holdUntil - now); return }
    userDraft = false
    stage = { expires: now + INPUT_TIMEOUT }
    if (!write(PASTE)) { stage = null; return }
    schedule(INPUT_TIMEOUT)
  }

  return {
    writeOutput(data) {
      if (stopped) return
      const wasWriting = stage !== null
      screen.write(data, () => {
        if (wasWriting || stage || pendingMessages().some(id => !dispatched.has(id))) schedule()
      })
    },
    userInput(data) {
      if (stage) {
        stage = null
        userDraft = true
      }
      if (submitKey(data) || data === '\x03' || data === '\x15') {
        userDraft = false
        holdUntil = Date.now() + INPUT_TIMEOUT
      } else if (!data.startsWith('\x1b') || data.startsWith('\x1b[200~')) {
        if (/[^\x00-\x1f\x7f]/u.test(data)) userDraft = true
      }
      schedule()
    },
    setComposing(value) {
      composing = value
      if (value && stage) {
        stage = null
        userDraft = true
      }
      if (!value) schedule()
    },
    resize(cols, rows) { screen.resize(cols, rows); schedule() },
    kick: schedule,
    close() {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      screen.dispose()
    }
  }
}

module.exports = { createAgentInboxWake, PROMPT }
