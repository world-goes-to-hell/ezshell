const { Terminal } = require('@xterm/headless')

// The line pasted into the agent's composer. Reading the message is what the sender sees (check_sent:
// "read"); the result follows with reply_to_message. Receipts (send_receipt) were removed on 2026-11-20.
const PROMPT = 'New ezShell message: read it with read_inbox, then handle it.'
// While it works: Claude Code hands a line entered during a task to that task, so it reads the message
// without stopping (the sender sees it read) and handles it afterwards
const BUSY_PROMPT = 'New ezShell message while you are busy: read it now with read_inbox; handle it after your current task.'
// After that task, when the request it put off is still unanswered
const REMIND_PROMPT = 'Your task is done: handle the ezShell request you put off, then send the result with reply_to_message.'
const PROMPTS = { idle: PROMPT, busy: BUSY_PROMPT, remind: REMIND_PROMPT }
const LONGEST_PROMPT = Math.max(...Object.values(PROMPTS).map(text => text.length))
const pasteOf = text => '\x1b[200~' + text + '\x1b[201~'
const DRAW_SETTLE = 35
const INPUT_TIMEOUT = 1500
const IMAGE_INPUT_TIMEOUT = 10_000
// A CLI that has not reported its state yet (just started, before its first turn) is taken to wait for
// input once its empty composer has stayed unchanged this long (three fresh agents never woke)
const QUIET_MS = 1500
const submitKey = data => /^(?:\r|\n|\x1b\[13(?:;1)?u)$/.test(data)
const compact = text => text.replace(/\s/g, '')
const claudeRule = /^\s*─{8,}\s*$/u
// The hint an empty Claude composer shows: Try "fix lint errors"
const CLAUDE_PLACEHOLDER = /^Try ".*"$/
// A numbered choice of a prompt: "❯ 1. Yes", "  2. No, and tell Claude what to do differently (esc)"
const APPROVAL_OPTION = /^\s*([❯›>▶])?\s*([1-9])[.)]\s+(\S.*?)\s*$/u
// After the number key, the CLI either answers at once or only moves its selection there
const APPROVAL_SETTLE = 600

/**
 * isWorking: not waiting for input (also while starting up, unknown or asking for approval).
 * isRunningTask: in the middle of a task, the only busy state that gets the busy notice.
 */
/**
 * write: our wake lines (gated on mail by the caller); rawWrite: a chat line the user sent (submitText)
 */
function createAgentInboxWake({ kind, cols, rows, pendingMessages, unhandledMessages = () => [], isWorking, isRunningTask = () => false, isUnknown = () => false, quietMs = QUIET_MS, write, rawWrite = write }) {
  const screen = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  const dispatched = new Set()
  // Announced while the agent was busy: reminded once after the task if still unanswered
  const deferred = new Set()
  let stopped = false
  let timer = null
  let stage = null
  // When the agent last drew anything (a fresh agent counts as waiting once this has been a while)
  let lastOutputAt = Date.now()
  let userDraft = false
  let composing = false
  // A model / effort picker is open (agentPicker.js): no wake line and no chat line meanwhile
  let held = false
  let holdUntil = 0
  const prompt = kind === 'codex' ? /^\s*›[ \u00a0]/u : /^\s*[>❯][ \u00a0]/u

  function paintedClaudeComposer(buffer, line, maxInputRows) {
    // Claude can leave the terminal cursor in the footer and paint its input cursor with inverse video.
    let bottom = buffer.baseY + screen.rows - 1
    while (bottom > buffer.baseY && !claudeRule.test(line(bottom))) {
      if (prompt.test(line(bottom))) return null
      bottom--
    }
    for (let first = bottom - 1; first >= Math.max(buffer.baseY + 1, bottom - maxInputRows); first--) {
      const prefix = prompt.exec(line(first))
      if (!prefix || !claudeRule.test(line(first - 1))) continue
      let painted
      const input = []
      for (let row = first; row < bottom; row++) {
        input.push(row === first ? line(row).slice(prefix[0].length) : line(row))
        const cells = buffer.getLine(row)
        const start = row === first ? prefix[0].length : 0
        for (let x = start; x < screen.cols; x++) {
          const cell = cells?.getCell(x)
          if (!cell?.isInverse()) continue
          if (painted || cell.getChars() !== ' ') return null
          painted = { row, x }
        }
      }
      if (!painted) {
        // No cursor painted either: Claude out of focus (the chat view or the usage menu has the keyboard)
        // draws its composer without one. Read the entire draft between the rules, including wrapped
        // paths and hard line breaks. Only a single blank or placeholder row counts as empty.
        const typed = input.join('\n').trim()
        const empty = input.length === 1 && (!typed || CLAUDE_PLACEHOLDER.test(typed))
        return { atStart: empty, endsAtCursor: true, text: empty ? '' : compact(typed) }
      }
      const text = compact(input.join(''))
      const afterCursor = (buffer.getLine(painted.row)?.translateToString(false, painted.x) ?? '')
        + input.slice(painted.row - first + 1).join('')
      return {
        atStart: !text && painted.row === first && painted.x === prefix[0].length,
        endsAtCursor: !compact(afterCursor),
        text
      }
    }
    return null
  }

  /** `textLength`: the longest draft to look for (default: our own prompts) */
  function composer(textLength = LONGEST_PROMPT, textLines = 1) {
    if (!screen.modes.bracketedPasteMode) return null
    const { active: buffer } = screen.buffer
    const cursor = buffer.baseY + buffer.cursorY
    const line = index => buffer.getLine(index)?.translateToString(false) ?? ''
    // A pasted line can wrap. Look above the cursor only as far as the app-written prompt.
    const maxInputRows = Math.min(screen.rows, Math.ceil(textLength / Math.max(1, screen.cols - 2)) + textLines)
    // Claude's terminal cursor can be on the first row of the composer with the caret hidden.
    // Read the complete ruled composer before relying on that cursor to find the end of the draft.
    if (kind === 'claude') {
      const ruled = paintedClaudeComposer(buffer, line, maxInputRows)
      if (ruled) return ruled
    }
    const first = Math.max(buffer.baseY, cursor - maxInputRows)
    for (let index = cursor; index >= first; index--) {
      const row = line(index)
      const prefix = prompt.exec(row)
      if (!prefix) continue
      if (kind === 'claude' && !claudeRule.test(line(index - 1))) continue
      const tail = row.slice(prefix[0].length)
      const lines = Array.from({ length: cursor - index }, (_, offset) => line(index + offset + 1))
      if (kind === 'claude' && lines.some(line => claudeRule.test(line))) continue
      // The empty prompt can have placeholder text to the right of the cursor.
      const atStart = index === cursor && buffer.cursorX === prefix[0].length
      const afterCursor = buffer.getLine(cursor)?.translateToString(false, buffer.cursorX) ?? ''
      // Text that fills the row to its last column: Windows ConPTY cannot leave the cursor past the
      // last column, so when it repaints it puts the cursor on the last cell, as if before the last
      // character (a busy line of exactly the pane's width was never entered)
      const fillsRow = buffer.cursorX === screen.cols - 1 && afterCursor.length === 1 && afterCursor !== ' '
      const endsAtCursor = afterCursor.trim() === '' || fillsRow
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

  /**
   * The agent's question with numbered choices on screen (a permission prompt, a question to the user),
   * or null. Read only when no composer shows: the CLIs replace their input box with the prompt. The
   * question, the lines that describe it (the command, the file) and the choices, as on screen.
   */
  function approvalPrompt() {
    // Not while a model / effort picker is open: main is answering that one itself (agentPicker.js)
    if (stopped || chat || stage || held || composer()) return null
    const { active: buffer } = screen.buffer
    // The screen as lines: a row the terminal wrapped (a long choice in a narrow pane) joins the one before
    const raws = []
    for (let row = buffer.baseY; row < buffer.baseY + screen.rows; row++) {
      const cells = buffer.getLine(row)
      const text = cells?.translateToString(true) ?? ''
      if (cells?.isWrapped && raws.length) raws[raws.length - 1] += text
      else raws.push(text)
    }
    const bare = index => (raws[index] ?? '').replace(/^\s*[│┃|]\s?/u, '').replace(/\s*[│┃|]\s*$/u, '')
    const top = 0
    let last = raws.length - 1
    while (last > top && !bare(last).trim()) last--
    // The choices end at most a few lines above the bottom (a hint like "Esc to cancel" may follow)
    let end = last
    while (end >= Math.max(top, last - 4) && !APPROVAL_OPTION.test(bare(end))) end--
    if (end < Math.max(top, last - 4)) return null
    let start = end
    for (let row = end - 1; row >= Math.max(top, end - 20); row--) {
      const text = bare(row)
      if (APPROVAL_OPTION.test(text)) start = row
      else if (!text.trim() || !/^\s{2,}\S/.test(text)) break
    }
    const options = []
    let selected = null
    for (let row = start; row <= end; row++) {
      const match = APPROVAL_OPTION.exec(bare(row))
      if (!match) {
        // A choice the CLI wrapped itself, indented under it
        if (options.length) options[options.length - 1].label += ' ' + bare(row).trim()
        continue
      }
      const [, marker, number, label] = match
      if (Number(number) !== options.length + 1) return null
      options.push({ key: number, label: label.trim() })
      if (marker) selected = number
    }
    if (options.length < 2 || options.length > 9) return null
    // What the question is about: up to the dialog's top rule (Claude) or the question itself (Codex)
    const lines = []
    let question = null
    for (let row = start - 1; row >= Math.max(top, start - 16); row--) {
      const raw = raws[row]
      if (/^\s*─{8,}\s*$/u.test(raw) || /^\s*[╭┌]/u.test(raw)) break
      const text = bare(row).trim()
      if (!text) continue
      if (!question && /\?$/.test(text)) {
        question = text
        if (kind === 'codex') break
        continue
      }
      lines.unshift(text.length > 300 ? text.slice(0, 300) + '…' : text)
      if (lines.length >= 12) break
    }
    return { question, detail: lines, options, selected, signature: JSON.stringify([question, options]) }
  }

  // A line sent from the chat view (src/agentChat): pasted into the empty composer, then Enter once the
  // composer shows it. Pasting a long text, the CLIs show a placeholder instead of the text.
  let chat = null
  let approvalWatch = null
  const PASTED_PLACEHOLDER = /^\[Pasted(?:text|Content)[^\]]*\]$/i
  const CLAUDE_IMAGE_PREFIX = /^(?:\[Image#[1-9]\d*\])+/

  function matchesClaudeImages(text, expected) {
    if (!expected) return false
    // Claude recognizes actual PNG paths on paste. It removes them from the draft and prepends
    // its own image tokens. Verify the count of distinct tokens and all the surviving text.
    const prefix = CLAUDE_IMAGE_PREFIX.exec(text)?.[0]
    if (!prefix || text.slice(prefix.length) !== expected.text) return false
    const ids = prefix.match(/\d+/g)
    return ids.length === expected.count && new Set(ids).size === expected.count
  }

  function checkChat() {
    if (!chat || stopped) return
    clearTimeout(chat.timer)
    const now = Date.now()
    const input = composer(chat.length, chat.lines)
    const drawn = input?.endsAtCursor && (
      input.text === chat.text || matchesClaudeImages(input.text, chat.claudeImages) || PASTED_PLACEHOLDER.test(input.text)
    )
    if (drawn) {
      const { resolve } = chat
      chat = null
      const ok = rawWrite('\r')
      userDraft = false
      holdUntil = now + INPUT_TIMEOUT
      resolve(ok ? { ok: true } : { ok: false, reason: 'write-failed' })
      schedule(INPUT_TIMEOUT)
      return
    }
    if (now >= chat.expires) {
      // Not drawn as sent: leave it for the user (an Enter now could submit something else)
      const { resolve } = chat
      chat = null
      userDraft = true
      resolve({ ok: false, reason: 'not-drawn' })
      return
    }
    chat.timer = setTimeout(checkChat, Math.min(DRAW_SETTLE * 3, chat.expires - now))
    chat.timer.unref?.()
  }

  function advance() {
    if (stopped || composing || held || chat) return
    const now = Date.now()
    // State never reported: waiting for input when the screen has been still (the composer check follows)
    const quietFor = now - lastOutputAt
    const freshIdle = isUnknown() && quietFor >= quietMs
    const working = isWorking() && !freshIdle
    const running = working && isRunningTask()
    const waiting = pendingMessages().filter(id => !dispatched.has(id))
    const open = new Set(unhandledMessages())
    for (const id of deferred) if (!open.has(id)) deferred.delete(id)
    const remind = working ? [] : [...deferred]
    const due = waiting.length > 0 || remind.length > 0
    const input = due || stage ? composer() : null
    if (stage) {
      const { expires, mode, prompt, ids } = stage
      const isOurs = Boolean(input?.endsAtCursor) && input?.text === compact(prompt)
      // A busy notice is entered while the task runs; the others only once the agent waits for input
      const canSubmit = mode === 'busy' ? running || !working : !working
      if (isOurs && !canSubmit) {
        // Our line is in the composer and the agent is busy: keep it and press Enter when it is ready.
        // Giving up here left the line in the composer for good (seen with two agents talking).
        stage.expires = now + INPUT_TIMEOUT
        // A never-reported agent counts as ready once its screen is still again: look then
        schedule(isUnknown() ? Math.min(INPUT_TIMEOUT, quietMs - quietFor + DRAW_SETTLE) : INPUT_TIMEOUT)
        return
      }
      if (!isOurs && now >= expires) {
        stage = null
        userDraft = true
        return
      }
      // Enter even when the message was read meanwhile (an agent reads its inbox inside a running
      // turn): our exact line is in the composer, and leaving it there stalls the conversation
      if (isOurs && canSubmit) {
        // Send Enter only after the supported composer has rendered the exact draft we pasted.
        stage = null
        if (write('\r')) {
          // The messages announced when pasting, and any that came since
          const announced = new Set([...ids, ...(mode === 'remind' ? remind : waiting)])
          if (mode === 'remind') announced.forEach(id => deferred.delete(id))
          else announced.forEach(id => {
            dispatched.add(id)
            if (mode === 'busy') deferred.add(id)
          })
        }
        holdUntil = now + INPUT_TIMEOUT
        schedule(INPUT_TIMEOUT)
      } else {
        schedule(expires - now)
      }
      return
    }
    // State not reported yet: look again once the screen has been still long enough
    if (due && working && isUnknown() && input?.atStart) { schedule(quietMs - quietFor + DRAW_SETTLE); return }
    // Busy but not in a task (starting up, approval prompt, unknown): wait as before
    if (!due || (working && !running) || !input?.atStart || (userDraft && input.text)) return
    if (now < holdUntil) { schedule(holdUntil - now); return }
    userDraft = false
    const mode = waiting.length ? (working ? 'busy' : 'idle') : 'remind'
    stage = { expires: now + INPUT_TIMEOUT, mode, prompt: PROMPTS[mode], ids: mode === 'remind' ? remind : waiting }
    if (!write(pasteOf(stage.prompt))) { stage = null; return }
    schedule(INPUT_TIMEOUT)
  }

  return {
    writeOutput(data) {
      if (stopped) return
      lastOutputAt = Date.now()
      const wasWriting = stage !== null
      screen.write(data, () => {
        if (approvalWatch && approvalPrompt()?.signature !== approvalWatch.signature) approvalWatch.gone = true
        if (chat) checkChat()
        else if (wasWriting || stage || deferred.size || pendingMessages().some(id => !dispatched.has(id))) schedule()
      })
    },
    approvalPrompt,
    /**
     * Answers the prompt on screen with one of its numbered choices, only if it is still the prompt the
     * user saw (same question and choices). The number key; then Enter only when the CLI just moved
     * its selection to that choice and the same prompt still shows.
     */
    answerApproval(key, signature) {
      return new Promise(resolve => {
        const prompt = approvalPrompt()
        if (!prompt || prompt.signature !== signature || !prompt.options.some(option => option.key === key)) {
          return resolve({ ok: false, reason: 'changed' })
        }
        // Gone even once while waiting means it was answered: the same question shown again is a new
        // prompt, and an Enter would answer that one too
        const watch = { signature, gone: false }
        approvalWatch = watch
        if (!rawWrite(key)) { approvalWatch = null; return resolve({ ok: false, reason: 'write-failed' }) }
        const settle = setTimeout(() => {
          if (approvalWatch === watch) approvalWatch = null
          const after = approvalPrompt()
          if (!watch.gone && after && after.signature === signature && after.selected === key) rawWrite('\r')
          resolve({ ok: true })
        }, APPROVAL_SETTLE)
        settle.unref?.()
      })
    },
    /**
     * Enters a line the user wrote in the chat view: only into the agent's own, empty composer (never a
     * shell prompt), and Enter only once the composer shows that text. Resolves { ok } or { ok, reason }.
     */
    submitText(text, claudeImages) {
      return new Promise(resolve => {
        if (stopped) return resolve({ ok: false, reason: 'not-agent' })
        if (chat || stage || composing || held) return resolve({ ok: false, reason: 'busy' })
        // Hangul and other wide characters can take two terminal cells per character.
        const length = text.length + (text.match(/[^\x00-\x7f]/g)?.length ?? 0)
        const lines = text.split('\n').length
        const input = composer(length, lines)
        if (!input) return resolve({ ok: false, reason: 'no-composer' })
        // Empty is the cursor at the prompt's start, as for our wake lines: an empty composer shows
        // placeholder text to the right of the cursor ("Try …"), so its text is not empty
        if (!input.atStart) return resolve({ ok: false, reason: 'composer-not-empty' })
        if (!rawWrite(pasteOf(text))) return resolve({ ok: false, reason: 'write-failed' })
        clearTimeout(timer)
        const images = kind === 'claude' && claudeImages ? { count: claudeImages.count, text: compact(claudeImages.text) } : null
        chat = {
          text: compact(text), length, lines,
          claudeImages: images,
          // Claude reads and converts every file before its native image tokens appear.
          expires: Date.now() + (images ? IMAGE_INPUT_TIMEOUT : INPUT_TIMEOUT), resolve, timer: null
        }
        chat.timer = setTimeout(checkChat, DRAW_SETTLE)
        chat.timer.unref?.()
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
    /** While a model / effort picker is open: no wake line, no chat line */
    setHeld(value) {
      held = value
      if (!value) schedule()
    },
    /** The visible screen, one string per row (agentPicker.js reads the CLI's pickers from it) */
    screenLines() {
      if (stopped) return []
      const { active: buffer } = screen.buffer
      return Array.from({ length: screen.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
    },
    /** The CLI asked for application cursor keys (arrows as ESC O A) */
    applicationCursorKeys: () => !stopped && screen.modes.applicationCursorKeysMode,
    resize(cols, rows) { screen.resize(cols, rows); schedule() },
    kick: schedule,
    close() {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      if (chat) {
        clearTimeout(chat.timer)
        chat.resolve({ ok: false, reason: 'not-agent' })
        chat = null
      }
      screen.dispose()
    }
  }
}

module.exports = { createAgentInboxWake, PROMPT, BUSY_PROMPT, REMIND_PROMPT }
