const { createHash } = require('node:crypto')
const { Terminal } = require('@xterm/headless')
const { hasCodexSpeedChoice } = require('./codexSpeed.js')
const { readAntigravityScreen } = require('./antigravityInboxScreen.js')
const { PROMPT, BUSY_PROMPT, REMIND_PROMPT } = require('./agentInboxPrompts.js')

// The line pasted into the agent's composer. Reading the message is what the sender sees (check_sent:
// "read"); the result follows with reply_to_message. Receipts (send_receipt) were removed on 2026-11-20.
const PROMPTS = { idle: PROMPT, busy: BUSY_PROMPT, remind: REMIND_PROMPT }
const LONGEST_PROMPT = Math.max(...Object.values(PROMPTS).map(text => text.length))
const pasteOf = text => '\x1b[200~' + text + '\x1b[201~'
const DRAW_SETTLE = 35
const INPUT_TIMEOUT = 1500
const IMAGE_INPUT_TIMEOUT = 10_000
const CHAT_MIN_PASTE_AGE = 500
const CHAT_EXACT_POLL = 100
const CHAT_EDITOR_QUIET = 300
const CHAT_INPUT_TIMEOUT = 5000
const CHAT_DRAFT_TIMEOUT = 2000
// A CLI that has not reported its state yet (just started, before its first turn) is taken to wait for
// input once its empty composer has stayed unchanged this long (three fresh agents never woke)
const QUIET_MS = 1500
const submitKey = data => /^(?:\r|\n|\x1b\[13(?:;1)?u)$/.test(data)
const compact = text => text.replace(/\s/g, '')
const claudeRule = /^\s*─{8,}\s*$/u
const claudeTargetRule = /^\s*─{8,}\s+([^─]+?)\s+─\s*$/u
const claudeScrollRule = /^\s*─{3,}\s+([↑↓])\s+[1-9]\d*\s+more\s+─{3,}\s*$/u
const isClaudeRule = row => claudeRule.test(row) || claudeTargetRule.test(row)
const CLAUDE_SHELL_COUNT = /^(\d+) shells?$/i
const CLAUDE_FOOTER_HINT = /(?:mode on|permissions on|accept edits on|\? for shortcuts|↓ to manage)/iu
const SHELL_PROMPT = /^\s*(?:PS\s+[^>]+>|[A-Z]:[\\/][^>]*>|(?:\S+[@:]\S+|~\S*|\/\S*)\s*[$%#])(?:\s|$)/i
const POWERSHELL_CONTINUATION = /^\s*>>(?:\s|$)/u
// A numbered choice of a prompt: "❯ 1. Yes", "  2. No, and tell Claude what to do differently (esc)"
const APPROVAL_OPTION = /^\s*([❯›>▶])?\s*([1-9])[.)]\s+(\S.*?)\s*$/u
const APPROVAL_PROGRESS = /^\s*[✻✶✽✢✳✦•⠁-⣿◐-◓◴-◷]\s*\S.*\((?:\d+m\s+)?\d+(?:\.\d+)?s\b/iu
const CODEX_APPROVAL_HINT = /\b(?:enter (?:to )?(?:confirm|submit|select)|esc (?:to )?cancel)\b/i
const CLAUDE_QUESTION_HINT = /^(?:Enter to (?:select|submit|chat)|Space to toggle)\b.*\bEsc to cancel$/i
const CLAUDE_QUESTION_TABS = /(?:^\s*←.*\bSubmit\b|\bSubmit\b.*→\s*$|^\s*[☐□☒]\s+\S)/u
const CLAUDE_QUESTION_CHOICE = /^(?:\[[ xX✓✔]\]\s+|(?:Type something\.?|Chat about this)$)/i
const APPROVAL_ABSENCE_MS = 150
const APPROVAL_QUIET_MS = 100
const APPROVAL_NO_OUTPUT_MS = 600
const APPROVAL_ANSWER_TIMEOUT = 1800

/** Claude's tabbed question and checklist need their own navigation and Submit action. */
function claudeQuestionPrompt(rows, bare, bottom, previous) {
  // A narrow pane folds the keyboard hint over two rows ("… to navigate ·" / "Esc to cancel")
  const folded = bottom > 0 && !CLAUDE_QUESTION_HINT.test(bare(bottom).trim()) &&
    CLAUDE_QUESTION_HINT.test(bare(bottom - 1).trim() + ' ' + bare(bottom).trim())
  const last = folded ? bottom - 1 : bottom
  const hint = folded || CLAUDE_QUESTION_HINT.test(bare(last).trim())
  if (!hint && !previous) return null
  const tabs = rows.slice(0, last).findLastIndex(row => CLAUDE_QUESTION_TABS.test(row))
  // Editing a free-text answer or reviewing the checklist changes its keyboard hint.
  if (previous && rows.some((_, index) => /^Review your answers$/i.test(bare(index).trim())) &&
      rows.some((_, index) => /^Submit answers$/i.test(APPROVAL_OPTION.exec(bare(index))?.[3] ?? ''))) return previous
  if (!hint) return tabs >= 0 ? previous : null
  const firstChoice = rows.findIndex((_, index) => {
    if (index <= tabs || index >= last) return false
    const choice = APPROVAL_OPTION.exec(bare(index))
    return choice && (tabs >= 0 || CLAUDE_QUESTION_CHOICE.test(choice[3]))
  })
  // Without the tab strip (it can scroll off screen), require one of the question menu's own choices.
  if (tabs < 0 && firstChoice < 0) return null

  const lines = []
  for (let row = firstChoice - 1; row > tabs; row--) {
    const text = bare(row).trim()
    if (isClaudeRule(rows[row]) || (lines.length && !text)) break
    if (!text) continue
    // If the heading is cropped, only use the visibly marked question, never preceding log output.
    if (tabs < 0 && !/^\s*[│┃|]/u.test(rows[row])) break
    lines.unshift(text)
  }
  const question = lines.join(' ').slice(0, 1000)
  if (!question && previous) return previous
  return { question: question || null, detail: [], options: [], selected: null, signature: JSON.stringify(['claude-question', question]), usesTerminalInput: true }
}

/**
 * isWorking: not waiting for input (also while starting up, unknown or asking for approval).
 * isRunningTask: in the middle of a task, the only busy state that gets the busy notice.
 */
/**
 * write: our wake lines (gated on mail by the caller); rawWrite: a chat line the user sent (submitText)
 */
function createAgentInboxWake({ kind, cols, rows, pendingMessages, unhandledMessages = () => [], isWorking, isRunningTask = () => false, isUnknown = () => false, isLive = () => true, isBlocked = () => false, quietMs = QUIET_MS, write, rawWrite = write, parentInput = () => true, onApprovalChange }) {
  const screen = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  const antigravity = kind === 'antigravity'
  const dispatched = new Set()
  // Announced while the agent was busy: reminded once after the task if still unanswered
  const deferred = new Set()
  let stopped = false
  let timer = null
  let stage = null
  // When the agent last drew anything (a fresh agent counts as waiting once this has been a while)
  let lastOutputAt = Date.now()
  let outputVersion = 0
  let parsedOutputVersion = 0
  let userDraft = false
  let composing = false
  // A model / effort picker is open (agentPicker.js): no wake line and no chat line meanwhile
  let held = false
  let holdUntil = 0
  let claudeQuestion = null
  let approvalTimer = null
  let approvalVisible = false
  let approvalOccurrence = 0
  const prompt = kind === 'codex' ? /^\s*›[ \u00a0]/u : /^\s*[>❯][ \u00a0]/u

  function isDimmedDraft(line, start) {
    for (let x = start; x < screen.cols; x++) {
      const cell = line?.getCell(x)
      if (cell?.getChars().trim() && !cell.isDim()) return false
    }
    return true
  }

  function paintedClaudeComposer(buffer, line, maxInputRows) {
    // Claude can leave the terminal cursor in the footer and paint its input cursor with inverse video.
    let bottom = buffer.baseY + screen.rows - 1
    while (bottom > buffer.baseY && !isClaudeRule(line(bottom))) {
      if (prompt.test(line(bottom))) return null
      bottom--
    }
    for (let first = bottom - 1; first >= Math.max(buffer.baseY + 1, bottom - maxInputRows); first--) {
      const prefix = prompt.exec(line(first))
      if (!prefix || !isClaudeRule(line(first - 1))) continue
      const target = claudeTargetRule.exec(line(first - 1))?.[1] ?? claudeTargetRule.exec(line(bottom))?.[1] ?? ''
      const footerRow = bottom - buffer.baseY + 1
      const startColumn = prefix[0].length
      // Claude's next-prompt suggestion is entirely dimmed and leaves the composer empty.
      let dimmedSuggestion = bottom === first + 1
      let painted
      const input = []
      for (let row = first; row < bottom; row++) {
        input.push(row === first ? line(row).slice(startColumn) : line(row))
        const cells = buffer.getLine(row)
        const start = row === first ? startColumn : 0
        for (let x = start; x < screen.cols; x++) {
          const cell = cells?.getCell(x)
          const chars = cell?.getChars()
          if (dimmedSuggestion && chars?.trim() && !cell.isDim()) dimmedSuggestion = false
          if (!cell?.isInverse()) continue
          if (painted) return null
          painted = { row, x, blank: chars === ' ' }
        }
      }
      if (dimmedSuggestion && input[0].trim()) {
        return { atStart: true, endsAtCursor: true, text: '', target, footerRow, display: '' }
      }
      const display = input.map(row => row.trimEnd()).join('\n')
      if (!painted) {
        // No cursor painted either: Claude out of focus (the chat view or the usage menu has the keyboard)
        // draws its composer without one. Read the entire draft between the rules, including wrapped
        // paths and hard line breaks. Only a single blank or placeholder row counts as empty.
        const typed = input.join('\n').trim()
        const empty = input.length === 1 && !typed
        return { atStart: empty, endsAtCursor: true, text: empty ? '' : compact(typed), target, footerRow, display }
      }
      if (!painted.blank) return null
      const text = compact(input.join(''))
      const afterCursor = (buffer.getLine(painted.row)?.translateToString(false, painted.x) ?? '')
        + input.slice(painted.row - first + 1).join('')
      return {
        atStart: !text && painted.row === first && painted.x === startColumn,
        endsAtCursor: !compact(afterCursor),
        text,
        display,
        target,
        footerRow
      }
    }
    return null
  }

  /** `textLength`: the longest draft to look for (default: our own prompts) */
  function composer(textLength = LONGEST_PROMPT, textLines = 1, matchesCodexAttachment) {
    if (antigravity) return readAntigravityScreen(screen).composer
    if (!screen.modes.bracketedPasteMode) return null
    const { active: buffer } = screen.buffer
    const cursor = buffer.baseY + buffer.cursorY
    const line = index => buffer.getLine(index)?.translateToString(false) ?? ''
    const endsAtCursorColumn = index => {
      // Windows ConPTY can leave the cursor on the last cell when the text fills the row exactly.
      if (buffer.cursorX === screen.cols - 1) return true
      return !(buffer.getLine(index)?.translateToString(false, buffer.cursorX) ?? '').trim()
    }
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
      if (kind === 'claude' && !isClaudeRule(line(index - 1))) continue
      // Codex also marks the selected option with its composer glyph, ›.
      if (kind === 'codex' && APPROVAL_OPTION.test(row)
        && CODEX_APPROVAL_HINT.test(screenLines().slice(index - buffer.baseY + 1).join(' '))) continue
      const tail = row.slice(prefix[0].length)
      if (matchesCodexAttachment && cursor === index) {
        // Codex can keep the terminal cursor on the prompt row after soft wrapping while its
        // column is the caret column of the last visual row. Check the full visible draft.
        let text = compact(tail)
        const last = Math.min(buffer.baseY + screen.rows - 1, index + maxInputRows)
        for (let end = index; end <= last; end++) {
          if (end > index) text += compact(line(end))
          if (!line(end + 1).trim() && endsAtCursorColumn(end) && matchesCodexAttachment(text)) {
            return { atStart: false, endsAtCursor: true, text, lastRow: end - buffer.baseY }
          }
        }
      }
      const lines = Array.from({ length: cursor - index }, (_, offset) => line(index + offset + 1))
      if (kind === 'claude' && lines.some(isClaudeRule)) continue
      // The empty prompt can have placeholder text to the right of the cursor.
      const atStart = index === cursor && buffer.cursorX === prefix[0].length
      const endsAtCursor = endsAtCursorColumn(cursor)
      const target = kind === 'claude' ? claudeTargetRule.exec(line(index - 1))?.[1] ?? '' : undefined
      const suggestion = Boolean(tail.trim()) && lines.every(row => !row.trim()) && isDimmedDraft(buffer.getLine(index), prefix[0].length)
      const display = [tail, ...lines].map(row => row.trimEnd()).join('\n')
      return { atStart, endsAtCursor, suggestion, text: compact(display), display, lastRow: cursor - buffer.baseY, target }
    }
    return null
  }

  // The cursor can be parked above the editor on redraw. This fallback identifies the visible
  // draft and its target, and cannot prove emptiness for a new paste.
  function visibleComposer() {
    if (antigravity || !screen.modes.bracketedPasteMode) return null
    const rows = screenLines()
    if (rows.some(row => SHELL_PROMPT.test(row))) return null
    if (kind === 'claude') {
      const upper = rows.findLastIndex(row => claudeScrollRule.exec(row)?.[1] === '↑')
      const lower = rows.findIndex((row, index) => index > upper && claudeScrollRule.exec(row)?.[1] === '↓')
      if (upper >= 0 || lower >= 0) {
        // Claude replaces a clipped edge with a scroll count. Use only the rows on the editor side
        // of that edge, even when there is no prompt, plain bottom rule, or footer left on screen.
        const start = upper >= 0 ? upper + 1 : rows.slice(0, lower).findLastIndex(isClaudeRule) + 1
        const nextRule = rows.findIndex((row, index) => index >= start && isClaudeRule(row))
        const end = Math.min(lower < 0 ? rows.length : lower, nextRule < 0 ? rows.length : nextRule)
        const draft = rows.slice(start, end)
        if (draft.some(row => /\$\s*$/.test(row))) return null
        const display = draft.join('\n')
        const text = compact(display)
        const target = claudeTargetRule.exec(rows[start - 1] ?? '')?.[1] ?? claudeTargetRule.exec(rows[end] ?? '')?.[1] ?? ''
        return text ? { text, display, target } : null
      }
    }
    const { active: buffer } = screen.buffer
    const first = rows.findLastIndex((row, index) => prompt.test(row + ' ') &&
      (kind !== 'claude' || isClaudeRule(rows[index - 1] ?? '')))
    if (first >= 0) {
      const width = prompt.exec(rows[first] + ' ')[0].length
      if (isDimmedDraft(buffer.getLine(buffer.baseY + first), width)) return null
      const end = rows.findIndex((row, index) => index > first && (kind === 'codex' ? !row.trim() : isClaudeRule(row)))
      const display = [rows[first].slice(width), ...rows.slice(first + 1, end < 0 ? undefined : end)].join('\n')
      const lastRow = end < 0 ? rows.length - 1 : end - 1
      const target = kind === 'claude' ? claudeTargetRule.exec(rows[first - 1])?.[1] ?? '' : undefined
      return { text: compact(display), display, lastRow, target }
    }
    if (kind === 'codex') return null
    // With a tall draft, Claude can scroll the prompt and top rule out of a short viewport.
    const bottom = rows.findLastIndex(isClaudeRule)
    const footer = rows.slice(bottom + 1).filter(row => row.trim())
    if (bottom <= 0 || rows.length - bottom > 5 || !rows[bottom - 1].trim() || !footer.some(row => CLAUDE_FOOTER_HINT.test(row))) return null
    const display = rows.slice(0, bottom).join('\n')
    return { target: claudeTargetRule.exec(rows[bottom])?.[1] ?? '', text: compact(display), display }
  }

  function shellAtCursor() {
    const { active: buffer } = screen.buffer
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? ''
    return SHELL_PROMPT.test(line) || POWERSHELL_CONTINUATION.test(line)
  }

  function targetOf(input) {
    if (!input || antigravity) return null
    if (kind === 'claude') return input.target ?? null
    const footer = screenLines().slice(input.lastRow + 1, input.lastRow + 7).filter(Boolean)
    for (const line of footer) {
      for (const part of line.trim().split(/\s+·\s+/)) {
        if (part === 'Main [default]') return ''
        const canonical = /^`(\/root\/[\w./-]+)`$/.exec(part)
        if (canonical) return canonical[1]
        if (/^[\w.-]+ \[[\w.-]+\]$/.test(part)) return part
      }
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
   * The agent's question on screen (a permission prompt or a question to the user), or null.
   * Claude's tabbed questions relay input through the live terminal shown in chat.
   */
  function approvalPrompt() {
    // Not while a model / effort picker is open: main is answering that one itself (agentPicker.js)
    if (stopped || chat || stage || held) return null
    const prompt = readApprovalScreen()
    return prompt && !prompt.usesTerminalInput ? { ...prompt, signature: approvalIdentity(prompt.signature) } : prompt
  }

  const approvalIdentity = signature => `${approvalOccurrence}:${signature}`

  function readApprovalScreen(checkBehindComposer = false) {
    if (antigravity) {
      return readAntigravityScreen(screen).blocked
        ? { question: null, detail: [], options: [], selected: null, signature: 'antigravity-terminal', usesTerminalInput: true }
        : null
    }
    if (!checkBehindComposer && composer()) {
      claudeQuestion = null
      return null
    }
    const { active: buffer } = screen.buffer
    // The screen as lines: a row the terminal wrapped (a long choice in a narrow pane) joins the one before
    // Only text that runs up to the right edge continues: Claude pads its rule and the rows of a choice's
    // preview box to the full width, and the cursor wrapping after them marks the next row as wrapped too
    // (the question with previews was never recognized: its rows were glued into one)
    const reachesEdge = cells => {
      for (let x = screen.cols - 1; x >= screen.cols - 2; x--) {
        if (cells?.getCell(x)?.getChars().trim()) return true
      }
      return false
    }
    const raws = []
    let previous = null
    for (let row = buffer.baseY; row < buffer.baseY + screen.rows; row++) {
      const cells = buffer.getLine(row)
      const text = cells?.translateToString(true) ?? ''
      const before = raws[raws.length - 1]
      if (cells?.isWrapped && raws.length && reachesEdge(previous) && !isClaudeRule(before)) raws[raws.length - 1] += text
      else raws.push(text)
      previous = cells
    }
    const bare = index => (raws[index] ?? '').replace(/^\s*[│┃|]\s?/u, '').replace(/\s*[│┃|]\s*$/u, '')
    const top = 0
    let last = raws.length - 1
    while (last > top && !bare(last).trim()) last--
    if (kind === 'claude') {
      claudeQuestion = claudeQuestionPrompt(raws, bare, last, claudeQuestion)
      if (claudeQuestion) return claudeQuestion
    }
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
    const header = []
    let question = null
    for (let row = start - 1; row >= Math.max(top, start - 16); row--) {
      const raw = raws[row]
      if (/^\s*─{8,}\s*$/u.test(raw) || /^\s*[╭┌]/u.test(raw)) break
      const text = bare(row).trim()
      if (APPROVAL_PROGRESS.test(text)) continue
      header.unshift(raw)
      if (!text) continue
      if (!question && /\?$/.test(text)) {
        question = text
        if (kind === 'codex') break
        continue
      }
      if (lines.length < 12) lines.unshift(text.length > 300 ? text.slice(0, 300) + '…' : text)
    }
    // Separate permission requests can have identical labels. Use the unabridged visible header,
    // including the command, for identity. Keep the display detail and IPC signature bounded.
    const signature = createHash('sha256').update(JSON.stringify([header, options])).digest('hex')
    return { question, detail: lines, options, selected, signature }
  }

  function chatBlocked() {
    if (isBlocked()) return true
    const approval = readApprovalScreen(true)
    return Boolean(approval?.usesTerminalInput || approval?.selected)
  }

  function chatComposerIsEmpty(input) {
    return input?.atStart && (!input.text || input.suggestion)
  }

  function scheduleApprovalCheck() {
    if (!onApprovalChange || stopped || held || approvalTimer) return
    approvalTimer = setTimeout(() => {
      approvalTimer = null
      if (stopped || held) return
      const prompt = readApprovalScreen()
      // A numbered list in streamed output has no selected row. Claude's checklist has its own footer.
      const visible = Boolean(prompt?.usesTerminalInput || prompt?.selected)
      if (visible === approvalVisible) return
      if (!visible) approvalOccurrence++
      approvalVisible = visible
      onApprovalChange(visible)
    }, DRAW_SETTLE)
    approvalTimer.unref?.()
  }

  // The prior chat paste can need time to leave the composer or need clearing on the next send.
  let chat = null
  let lastChatDraft = null
  // Per-PTY sequencing follows Orca (MIT), native-chat-pty-send-queue.ts. A paste and its delayed
  // Enter own the editor until both writes finish, so the next send cannot merge into that draft.
  const chatQueue = []
  let approvalWatch = null
  const PASTED_PLACEHOLDER = /^\[Pasted(?:text|Content)[^\]]*\]$/i
  const IMAGE_PREFIX = /^(?:\[Image#[1-9]\d*\])+/

  function finishApprovalAnswer(result) {
    const watch = approvalWatch
    if (!watch) return
    clearTimeout(watch.timer)
    approvalWatch = null
    watch.resolve(result)
  }

  function finishDepartedApproval() {
    if (approvalWatch.occurrence === approvalOccurrence) approvalOccurrence++
    finishApprovalAnswer({ ok: true })
  }

  function checkApprovalAnswer(onOutput = false) {
    const watch = approvalWatch
    if (!watch) return
    clearTimeout(watch.timer)
    if (stopped || !isLive()) return finishApprovalAnswer({ ok: false, reason: 'not-agent' })
    if (chat || stage || composing || held) return finishApprovalAnswer({ ok: false, reason: 'changed' })

    const now = Date.now()
    let nextCheck = watch.deadline
    const caughtUp = parsedOutputVersion === outputVersion
    if (onOutput || caughtUp) {
      // Compare the content while the renderer observes its own visible card lifetimes.
      const current = readApprovalScreen()
      const same = current?.signature === watch.signature
      // Ink can clear the choices and draw them again in separate writes. Once the question has
      // really gone, a later prompt with the same choices must get its own answer.
      if (!same) {
        watch.sawAbsence = true
        watch.absentSince ??= now
      }
      if (watch.absentSince !== null && now - watch.absentSince >= APPROVAL_ABSENCE_MS) {
        return finishDepartedApproval()
      }
      if (same) {
        watch.absentSince = null
        if (caughtUp) {
          // If the same selected choice returns, the number may have completed the earlier request.
          // Give that prompt a fresh identity and never confirm it with this request's Enter.
          const returnedUnchanged = watch.sawAbsence && current.selected === watch.initialSelection
          if (current.selected === watch.key) {
            const quietAt = outputVersion === watch.startVersion ? watch.startedAt + APPROVAL_NO_OUTPUT_MS : lastOutputAt + APPROVAL_QUIET_MS
            if (now >= quietAt) {
              if (returnedUnchanged) return finishDepartedApproval()
              if (!watch.sawAbsence || outputVersion !== watch.startVersion) {
                return finishApprovalAnswer(rawWrite('\r') ? { ok: true } : { ok: false, reason: 'write-failed' })
              }
            } else {
              nextCheck = Math.min(nextCheck, quietAt)
            }
          }
          if (watch.sawAbsence && now >= watch.deadline) return finishDepartedApproval()
        }
      } else {
        nextCheck = Math.min(nextCheck, watch.absentSince + APPROVAL_ABSENCE_MS)
      }
    }
    if (now >= watch.deadline) return finishApprovalAnswer({ ok: false, reason: 'stuck' })
    watch.timer = setTimeout(checkApprovalAnswer, nextCheck - now)
    watch.timer.unref?.()
  }

  function matchesImageCount(text, count, body = '') {
    const prefix = IMAGE_PREFIX.exec(text)?.[0]
    if (!prefix || text.slice(prefix.length) !== body) return false
    const ids = prefix.match(/\d+/g)
    return ids.length === count && new Set(ids).size === count
  }

  function matchesCodexImages(text, draft) {
    if (!text.startsWith(draft.labels)) return false
    if (!draft.pastingBody) return matchesImageCount(text, draft.nextFile)
    const body = text.slice(draft.labels.length)
    return body === draft.compactBody || body === draft.placeholder
  }

  function pasteNextCodexPart(input, now) {
    const draft = chat.codexImages
    if (!draft || draft.pastingBody) return false
    const file = draft.files[draft.nextFile]
    if (!file && !draft.body) return false
    draft.labels = input.text
    if (file) draft.nextFile++
    else draft.pastingBody = true
    chat.expires = now + IMAGE_INPUT_TIMEOUT
    if (!rawWrite(pasteOf(file ?? draft.body))) finishChat({ ok: false, reason: 'write-failed' }, false)
    return true
  }

  function finishChat(result, replayInput = true) {
    const { resolve, terminalInput, timer } = chat
    clearTimeout(timer)
    chat = null
    if (replayInput) {
      for (const data of terminalInput) {
        userInput(data)
        rawWrite(data)
      }
    }
    resolve(result)
    if (chatQueue.length) queueMicrotask(drainChatQueue)
  }

  function drainChatQueue() {
    while (!chat && chatQueue.length && parsedOutputVersion === outputVersion) chatQueue.shift().start()
  }

  function cancelQueuedChats(reason) {
    for (const { resolve } of chatQueue.splice(0)) resolve({ ok: false, reason })
  }

  function scheduleChatCheck(now = Date.now(), when = now + DRAW_SETTLE * 3) {
    chat.timer = setTimeout(checkChat, Math.max(1, Math.min(when, chat.expires) - now))
    chat.timer.unref?.()
  }

  function pasteChatDraft(now, input) {
    const { draft, paste, codexSpeed, timeout } = chat
    chat.waitForEmpty = false
    chat.pastedAt = now
    chat.pasteOutputVersion = outputVersion
    if (draft) {
      chat.editorDisplay = input.display
      chat.editorHasDraft = false
    }
    chat.expires = now + timeout
    if (!(codexSpeed ? rawWrite(paste, false) : rawWrite(paste))) {
      finishChat({ ok: false, reason: 'write-failed' }, false)
      return
    }
    if (draft) lastChatDraft = draft
    scheduleChatCheck(now, now + DRAW_SETTLE)
  }

  function chatTargetMatches(input) {
    const target = targetOf(input)
    return target === chat.draft.target && (!chat.verify || chat.verify(target))
  }

  function enterChat(now, input) {
    // Orca (MIT), native-chat-runtime-send.ts, issues one separate Enter after the paste window.
    // Keep the attempt marked even if the PTY write fails, since delivery may be uncertain.
    lastChatDraft = { ...chat.draft, sent: true, displayed: input.text, enterOutputVersion: outputVersion }
    const ok = rawWrite('\r')
    userDraft = false
    holdUntil = now + INPUT_TIMEOUT
    finishChat(ok ? { ok: true } : { ok: false, reason: 'write-failed' }, false)
    schedule(INPUT_TIMEOUT)
  }

  function checkOrdinaryChat(now, input, drawn) {
    // Based on Orca (MIT), native-chat-paste-landed.ts. Matching and stability select the
    // timing. At the deadline the active editor and other safety checks still apply.
    const hasDraft = Boolean(input?.text && !input.suggestion && !chatComposerIsEmpty(input))
    if ((input?.display !== chat.editorDisplay || hasDraft !== chat.editorHasDraft)
      && parsedOutputVersion > chat.pasteOutputVersion) {
      chat.editorDisplay = input?.display
      chat.editorHasDraft = hasDraft
      chat.editorChangedAt = now
      chat.exactReadAt = undefined
    }
    const firstCheck = chat.pastedAt + CHAT_MIN_PASTE_AGE
    const fallbackAt = (chat.editorChangedAt ?? Infinity) + CHAT_EDITOR_QUIET
    if (drawn && now >= firstCheck) chat.exactReadAt ??= now
    else chat.exactReadAt = undefined
    const exactAt = (chat.exactReadAt ?? Infinity) + CHAT_EXACT_POLL
    const ready = drawn ? now >= exactAt : now >= fallbackAt
    const expired = now >= chat.expires
    const pasteIsVisible = hasDraft && chat.editorChangedAt !== undefined
    if (expired || (now >= firstCheck && pasteIsVisible && ready)) {
      if (!pasteIsVisible) return finishChat({ ok: false, reason: 'not-drawn' }, false)
      if (!chatTargetMatches(input)) return finishChat({ ok: false, reason: 'target-changed' }, false)
      enterChat(now, input)
      return
    }
    const stabilityAt = drawn ? exactAt : fallbackAt
    const nextPoll = now < firstCheck ? firstCheck : Math.min(now + CHAT_EXACT_POLL, stabilityAt > now ? stabilityAt : Infinity)
    scheduleChatCheck(now, nextPoll)
  }

  function checkChat() {
    if (!chat || stopped) return
    clearTimeout(chat.timer)
    const now = Date.now()
    const finish = reason => finishChat({ ok: false, reason }, false)
    if (!isLive()) return finish('not-agent')
    if (chat.draft && (composing || held)) return finish('interrupted')
    if (chat.draft && parsedOutputVersion !== outputVersion) {
      if (now < chat.expires) {
        scheduleChatCheck(now)
        return
      }
      if (chat.waitForEmpty) return finish('composer-not-empty')
      // A frame received by the deadline can still be waiting on xterm. Give the parser one
      // bounded drain window, and never send from an older frame while more bytes are queued.
      chat.drainUntil ??= now + DRAW_SETTLE * 3
      if (now >= chat.drainUntil) return finish('not-drawn')
      chat.timer = setTimeout(checkChat, chat.drainUntil - now)
      chat.timer.unref?.()
      return
    }
    const blocked = chat.draft && chatBlocked()
    if (antigravity) {
      if (blocked) return finish('approval')
      if (isWorking() || isUnknown()) return finish('busy')
    }
    if (chat.waitForEmpty) {
      if (blocked) return finish('approval')
      const input = composer(Infinity)
      if (input && !chatTargetMatches(input)) {
        return finish('target-changed')
      }
      if (now >= chat.expires) return finish('composer-not-empty')
      if (chatComposerIsEmpty(input) && parsedOutputVersion > chat.emptyAfterOutput) {
        lastChatDraft = null
        userDraft = false
        pasteChatDraft(now, input)
      } else {
        scheduleChatCheck(now)
      }
      return
    }
    const codexImages = chat.codexImages
    const matchesAttachments = codexImages ? text => matchesCodexImages(text, codexImages) : undefined
    const parsed = composer(chat.draft ? Infinity : chat.length, chat.lines, matchesAttachments)
    const input = chat.draft ? (!shellAtCursor() && (parsed ?? visibleComposer())) : parsed
    if (blocked) return finish('approval')
    const drawn = input?.endsAtCursor && (matchesAttachments ? matchesAttachments(input.text) : (
      input.text === chat.text || (chat.claudeImages && matchesImageCount(input.text, chat.claudeImages.count, chat.claudeImages.text))
      || PASTED_PLACEHOLDER.test(input.text)
    ))
    if (chat.draft) return checkOrdinaryChat(now, input, drawn)
    const command = chat.codexSpeed
    const exact = input?.endsAtCursor && input.text === chat.text
    const available = command && exact && hasCodexSpeedChoice(screenLines(), command)
    if (chat.clearing && input?.atStart) {
      finishChat(chat.clearing)
      schedule()
      return
    }
    if (!chat.clearing && command && exact && ((chat.probe && available) || (now >= chat.expires && !available))) {
      // Capability checks never submit the borrowed draft. Wait for the empty composer before replaying typing.
      chat.clearing = chat.probe ? { ok: true, available: Boolean(available) } : { ok: false, reason: 'speed-unavailable' }
      chat.expires = now + INPUT_TIMEOUT
      if (!rawWrite('\x7f'.repeat(chat.length), false)) finishChat({ ok: false, reason: 'write-failed' }, false)
      if (!chat) return
    } else if (!chat.clearing && !chat.probe && drawn && (!command || available)) {
      if (chat.verify && !chat.verify(targetOf(input))) {
        // Keep a draft if the CLI switched views. A key here could act on the new view.
        finishChat({ ok: false, reason: 'target-changed' }, false)
        return
      }
      if (!pasteNextCodexPart(input, now)) {
        const ok = command ? rawWrite('\r', false) : rawWrite('\r')
        userDraft = false
        holdUntil = now + INPUT_TIMEOUT
        finishChat(ok ? { ok: true } : { ok: false, reason: 'write-failed' })
        schedule(INPUT_TIMEOUT)
        return
      }
      if (!chat) return
    }
    if (now >= chat.expires) {
      if (!chat.probe || !input?.atStart) userDraft = true
      // When a CLI does not confirm that it cleared our draft, keep queued keys out of that draft.
      finishChat({ ok: false, reason: 'not-drawn' }, input?.atStart)
      return
    }
    scheduleChatCheck(now)
  }

  function advance() {
    if (antigravity || stopped || composing || held || chat) return
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
    if (!parentInput(targetOf(input))) return
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
    if (!due || (working && !running) || !input?.atStart || (userDraft && input.text && !input.suggestion)) return
    if (now < holdUntil) { schedule(holdUntil - now); return }
    userDraft = false
    const mode = waiting.length ? (working ? 'busy' : 'idle') : 'remind'
    stage = { expires: now + INPUT_TIMEOUT, mode, prompt: PROMPTS[mode], ids: mode === 'remind' ? remind : waiting }
    if (!write(pasteOf(stage.prompt))) { stage = null; return }
    schedule(INPUT_TIMEOUT)
  }

  function screenLines() {
    if (stopped) return []
    const { active: buffer } = screen.buffer
    return Array.from({ length: screen.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
  }

  function commandRows() {
    if (stopped) return { lines: [], wraps: [] }
    const { active: buffer } = screen.buffer
    const rows = Array.from({ length: screen.rows }, (_, row) => buffer.getLine(buffer.baseY + row))
    const wraps = rows.map(row => Boolean(row?.isWrapped))
    const lines = rows.map((row, index) => row?.translateToString(!wraps[index + 1]) ?? '')
    return { lines, wraps }
  }

  function userInput(data) {
    finishApprovalAnswer({ ok: false, reason: 'changed' })
    lastChatDraft = null
    cancelQueuedChats('interrupted')
    if (chat && (chat.draft || chat.codexImages || (data === '\x1b' && !chat.probe))) {
      const reason = chat.draft || data === '\x1b' ? 'interrupted' : 'target-changed'
      finishChat({ ok: false, reason }, false)
    }
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
  }

  return {
    writeOutput(data) {
      if (stopped) return
      lastOutputAt = Date.now()
      const version = ++outputVersion
      const wasWriting = stage !== null
      screen.write(data, () => {
        parsedOutputVersion = version
        checkApprovalAnswer(true)
        if (chat) checkChat()
        else {
          drainChatQueue()
          if (wasWriting || stage || deferred.size || pendingMessages().some(id => !dispatched.has(id))) schedule()
        }
        scheduleApprovalCheck()
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
        if (stopped || !isLive()) return resolve({ ok: false, reason: 'not-agent' })
        if (approvalWatch) return resolve({ ok: false, reason: 'busy' })
        if (chat || stage || held || composing || parsedOutputVersion !== outputVersion) return resolve({ ok: false, reason: 'changed' })
        const prompt = readApprovalScreen()
        if (!prompt || prompt.usesTerminalInput || approvalIdentity(prompt.signature) !== signature || !prompt.options.some(option => option.key === key)) {
          return resolve({ ok: false, reason: 'changed' })
        }
        const startedAt = Date.now()
        approvalWatch = {
          key, signature: prompt.signature, occurrence: approvalOccurrence, resolve, startedAt, startVersion: outputVersion, initialSelection: prompt.selected,
          absentSince: null, sawAbsence: false, deadline: startedAt + APPROVAL_ANSWER_TIMEOUT, timer: null
        }
        if (!rawWrite(key)) return finishApprovalAnswer({ ok: false, reason: 'write-failed' })
        checkApprovalAnswer()
      })
    },
    /**
     * Enters a line the user wrote in the chat view: only into the agent's own, empty composer (never a
     * shell prompt). Normal chat can also submit after the active editor has redrawn and settled.
     */
    submitText(text, images, { codexSpeed, probe = false, strict = false, verify, canSend } = {}) {
      // A per-attempt restriction can expire while its draft is still on screen. Only the
      // target check is saved with the draft for a later send to verify before clearing it.
      const verifySend = canSend ? target => (!verify || verify(target)) && canSend() : verify
      return new Promise(resolve => {
        if (antigravity && (images || codexSpeed || probe || strict)) return resolve({ ok: false, reason: 'unsupported' })
        const queueable = !antigravity && !strict && !codexSpeed && !probe
        const relaxed = (queueable || antigravity) && !images
        const start = () => {
          if (stopped || !isLive()) return resolve({ ok: false, reason: 'not-agent' })
          if (chat || stage || composing || held) return resolve({ ok: false, reason: 'busy' })
          if (relaxed && chatBlocked()) return resolve({ ok: false, reason: 'approval' })
          if (antigravity && (isWorking() || isUnknown() || parsedOutputVersion !== outputVersion)) return resolve({ ok: false, reason: 'busy' })
          // Hangul and other wide characters can take two terminal cells per character.
          const files = kind === 'codex' ? images?.files : null
          const length = text.length + (text.match(/[^\x00-\x7f]/g)?.length ?? 0) + (files?.length ?? 0) * 20
          const lines = text.split('\n').length
          const input = composer(relaxed ? Infinity : length, lines)
          if (!input || (relaxed && shellAtCursor())) return resolve({ ok: false, reason: 'no-composer' })
          const target = targetOf(input)
          if (verifySend && !verifySend(target)) return resolve({ ok: false, reason: 'target-changed' })
          // An empty editor can show a dim placeholder to the right of the caret.
          const empty = relaxed ? chatComposerIsEmpty(input) : input.atStart
            && !((codexSpeed || files?.length) && userDraft && input.text) && !(files?.length && IMAGE_PREFIX.test(input.text))
          // Antigravity text starts in a verified empty editor. A failed paste is left for the user.
          const previous = relaxed && !antigravity ? lastChatDraft : null
          const waitingForPrior = empty && previous?.sent && previous.target === target
            && parsedOutputVersion <= previous.enterOutputVersion
          const ours = !empty && previous && previous.target === target && input.text
            && (previous.sent || (input.endsAtCursor && (kind !== 'codex' || !input.text.includes('↑'))))
            && (input.text.normalize() === previous.text.normalize() || (previous.sent && input.text === previous.displayed))
            && (!previous.verify || previous.verify(target))
          if (!empty && !ours) return resolve({ ok: false, reason: 'composer-not-empty' })

          clearTimeout(timer)
          const claudeImages = kind === 'claude' && images ? { count: images.count, text: compact(images.text) } : null
          const compactText = compact(text)
          // Codex recognizes each local image when its path is pasted on its own.
          const codexImages = files?.length ? {
            files, body: text, compactBody: compactText, nextFile: 1, labels: '', pastingBody: false,
            placeholder: `[PastedContent${Array.from(text).length}chars]`
          } : null
          const now = Date.now()
          const draft = relaxed ? { text: compactText, target, verify, eraseCount: Array.from(text).length + lines } : null
          chat = {
            text: compactText, length, lines, codexSpeed, probe, verify: verifySend, terminalInput: [],
            claudeImages, codexImages, draft, paste: pasteOf(files?.[0] ?? text),
            // The CLI reads and decodes image files before its native image tokens appear.
            timeout: relaxed ? CHAT_INPUT_TIMEOUT : images ? IMAGE_INPUT_TIMEOUT : INPUT_TIMEOUT,
            resolve, timer: null
          }
          if (empty && !waitingForPrior) {
            if (relaxed) lastChatDraft = null
            pasteChatDraft(now, input)
            return
          }
          chat.waitForEmpty = true
          chat.emptyAfterOutput = outputVersion
          chat.expires = now + CHAT_DRAFT_TIMEOUT
          // Like Orca (MIT), native-chat-input-clear.ts, send the clear on its own. Wait for the
          // reader to see an empty editor before writing another paste into the same PTY.
          if (!previous.sent) {
            lastChatDraft = null
            if (!rawWrite('\x7f'.repeat(previous.eraseCount), false)) {
              finishChat({ ok: false, reason: 'write-failed' }, false)
              return
            }
          }
          scheduleChatCheck(now, now + DRAW_SETTLE)
        }
        if (queueable && !stopped && (chat || chatQueue.length || parsedOutputVersion !== outputVersion)) {
          chatQueue.push({ start, resolve })
        } else {
          start()
        }
      })
    },
    /**
     * After Esc the CLI may put sent lines back into its composer. Clears the
     * composer only when it holds exactly those lines (whitespace aside: the CLI joins several its own
     * way), so a draft the user typed in the terminal is never touched. Resolves { ok } or { ok, reason }.
     */
    takeBack(texts) {
      return new Promise(resolve => {
        if (antigravity) return resolve({ ok: false, reason: 'unsupported' })
        if (stopped || chat || stage || held || composing) return resolve({ ok: false, reason: 'busy' })
        const joined = texts.join('\n')
        const length = joined.length + (joined.match(/[^\x00-\x7f]/g)?.length ?? 0)
        const input = composer(length, texts.reduce((count, text) => count + text.split('\n').length, 0))
        if (!input || input.atStart) return resolve({ ok: false, reason: 'empty' })
        if (!parentInput(targetOf(input))) return resolve({ ok: false, reason: 'different' })
        if (!input.endsAtCursor || input.text !== compact(joined)) return resolve({ ok: false, reason: 'different' })
        // One key per character from the end; extra keys on an empty composer do nothing
        if (!rawWrite('\x7f'.repeat(Array.from(joined).length + texts.length), false)) return resolve({ ok: false, reason: 'write-failed' })
        const expires = Date.now() + INPUT_TIMEOUT
        const check = () => {
          if (stopped) return resolve({ ok: false, reason: 'not-agent' })
          if (composer()?.atStart) {
            userDraft = false
            schedule()
            return resolve({ ok: true })
          }
          if (Date.now() >= expires) return resolve({ ok: false, reason: 'not-cleared' })
          setTimeout(check, DRAW_SETTLE * 3).unref?.()
        }
        setTimeout(check, DRAW_SETTLE).unref?.()
      })
    },
    userInput,
    deferProbeInput(data) {
      if (!chat?.probe) return false
      chat.terminalInput.push(data)
      return true
    },
    setComposing(value) {
      composing = value
      if (value) {
        finishApprovalAnswer({ ok: false, reason: 'changed' })
        lastChatDraft = null
        cancelQueuedChats('interrupted')
        if (chat?.draft) finishChat({ ok: false, reason: 'interrupted' }, false)
      }
      if (value && stage) {
        stage = null
        userDraft = true
      }
      if (!value) schedule()
    },
    /** While a model / effort picker is open: no wake line, no chat line */
    setHeld(value) {
      held = value
      if (value) {
        finishApprovalAnswer({ ok: false, reason: 'changed' })
        lastChatDraft = null
        cancelQueuedChats('interrupted')
        if (chat?.draft) finishChat({ ok: false, reason: 'interrupted' }, false)
      }
      if (!value) {
        scheduleApprovalCheck()
        schedule()
      }
    },
    /** The visible screen, one string per row (agentPicker.js reads the CLI's pickers from it) */
    screenLines,
    commandRows,
    /** First row below Claude's ruled composer, including when the draft wraps. */
    composerFooterRow: () => !stopped && kind === 'claude' ? composer(Infinity)?.footerRow ?? null : null,
    /** Background shells in Claude's own composer footer. Null while the footer cannot be read. */
    backgroundShellCount() {
      if (stopped || kind !== 'claude') return null
      const row = composer()?.footerRow
      if (row === undefined) return null
      const lines = screenLines().slice(row, row + 3)
      const end = lines.findIndex(isClaudeRule)
      const footer = lines.slice(0, end < 0 ? lines.length : end).join(' ')
      const entry = footer.split('·').map(part => CLAUDE_SHELL_COUNT.exec(part.trim())).find(Boolean)
      return entry ? Number(entry[1]) : CLAUDE_FOOTER_HINT.test(footer) ? 0 : null
    },
    inputTarget: () => targetOf(composer()),
    /** The agent's own composer: 'empty', 'draft' (text in it), or null (not on screen: a dialog of the CLI) */
    composerState() {
      if (stopped) return null
      const input = composer()
      return input ? (input.atStart ? 'empty' : 'draft') : null
    },
    /** The CLI asked for application cursor keys (arrows as ESC O A) */
    applicationCursorKeys: () => !stopped && screen.modes.applicationCursorKeysMode,
    resize(cols, rows) { screen.resize(cols, rows); scheduleApprovalCheck(); schedule() },
    kick: schedule,
    close() {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      clearTimeout(approvalTimer)
      finishApprovalAnswer({ ok: false, reason: 'not-agent' })
      cancelQueuedChats('not-agent')
      if (chat) finishChat({ ok: false, reason: 'not-agent' }, false)
      screen.dispose()
    }
  }
}

module.exports = { createAgentInboxWake, PROMPT, BUSY_PROMPT, REMIND_PROMPT, supportsAntigravityInput: true }
