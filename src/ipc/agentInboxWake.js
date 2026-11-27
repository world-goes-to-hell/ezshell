const { createHash, randomUUID } = require('node:crypto')
const { Terminal } = require('@xterm/headless')
const { hasCodexSpeedChoice } = require('./codexSpeed.js')
const { readAntigravityScreen } = require('./antigravityInboxScreen.js')
const { isAgentPickerScreen } = require('./agentPicker.js')
const { PROMPT, BUSY_PROMPT, REMIND_PROMPT } = require('./agentInboxPrompts.js')
const { claudeQueueVisible, claudeLoginStage } = require('../agentChat/commandScreen.js')
const { isCodexHookTrustScreen } = require('./codexHookLaunch.js')
const { splitOverlayBox, withoutOverlayBox } = require('./cliOverlayBox.js')
const STOP_WAKE_TIMEOUT = 15_000
const STOP_WAKE_THINKING_RECHECK = 5000
const STOP_WAKE_MAX_WAIT = 120_000

// The line pasted into the agent's composer. Reading the message is what the sender sees (check_sent:
// "read"); the result follows with reply_to_message. Receipts (send_receipt) were removed on 2026-11-20.
const PROMPTS = { idle: PROMPT, busy: BUSY_PROMPT, remind: REMIND_PROMPT }
const LONGEST_PROMPT = Math.max(...Object.values(PROMPTS).map(text => text.length))
const pasteOf = text => '\x1b[200~' + text + '\x1b[201~'
const DRAW_SETTLE = 35
const INPUT_TIMEOUT = 1500
const WAKE_HIDDEN_TIMEOUT = 30_000
const WAKE_RECOVERY_POLL = 250
const WAKE_DRAFT_NOTICE_AFTER = 60_000
const IMAGE_INPUT_TIMEOUT = 10_000
const CHAT_MIN_PASTE_AGE = 500
const CHAT_EXACT_POLL = 100
const CHAT_EDITOR_QUIET = 300
const CHAT_INPUT_TIMEOUT = 5000
const CHAT_DRAFT_TIMEOUT = 2000
const CHAT_CLEAR_SETTLE = 140
const CLAUDE_TAKE_BACK_LIMIT = 10
// Ctrl+U and Ctrl+K clear both sides of Claude's cursor. Match Orca's bounded multiline clear.
const CLAUDE_CLEAR_DRAFT = '\x15'.repeat(29) + '\x0b'.repeat(29)
// A CLI that has not reported its state yet (just started, before its first turn) is taken to wait for
// input once its empty composer has stayed unchanged this long (three fresh agents never woke)
const QUIET_MS = 1500
const submitKey = data => /^(?:\r|\n|\x1b\[13(?:;1)?u)$/.test(data)
// What the tab's terminal answers by itself, not keys: focus reports (the CLI's ?1004h), device attributes,
// OSC colour replies, mode and keyboard-flag reports, DCS replies. They leave the composer alone.
const TERMINAL_REPORTS = /^(?:\x1b\[[IO]|\x1b\[[?>][\d;]*c|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\?[\d;]*\$y|\x1b\[\?\d*u|\x1bP[^\x1b]*\x1b\\)+$/
const compact = text => text.replace(/\s/g, '')
const CODEX_STATUS_FOOTER = /(?:^|\s)\d{1,3}% context left(?:\s*·\s*⚠\uFE0F?\s+\d+ warnings?\s*·\s*f2 to view)?\s*$/iu
// All whitespace has already been removed, including visual line breaks inside a Claude chip.
const CLAUDE_PASTE_CHIP = /\[Pastedtext#[1-9]\d*(?:\+[1-9]\d*lines|[1-9]\d*chars)?\](?:#[1-9]\d*)?/g

function matchesClaudePaste(displayed, expected, previousDisplay, requireChipOnly) {
  const pieces = displayed.split(CLAUDE_PASTE_CHIP)
  if (pieces.length < 2 || !expected) return false
  if (previousDisplay) {
    const before = compact(previousDisplay)
    // A clear can finish without an empty redraw. A prior chip or retained draft text cannot
    // prove that the new chips replaced it.
    if (before && (displayed.includes(before) || before.split(CLAUDE_PASTE_CHIP).length > 1 ||
        (requireChipOnly && pieces.some(Boolean)))) return false
  }
  const prefix = pieces.shift()
  const suffix = pieces.pop()
  if (!expected.startsWith(prefix) || !expected.endsWith(suffix)) return false
  let at = prefix.length
  const end = expected.length - suffix.length
  for (const piece of pieces) {
    const next = expected.indexOf(piece, at)
    if (next < 0) return false
    at = next + piece.length
  }
  return at <= end
}

const claudeRule = /^\s*─{8,}\s*$/u
// Claude writes a label (a session name, a subagent's task) at the right end of its composer's top rule.
// A long one leaves few or no dashes and ends in an ellipsis: " 운영 도메인 … ─" (2026-11-24)
const claudeTargetRule = /^\s*(?:─+\s+([^─]+?)|([^─\s][^─]*…))\s+─\s*$/u
const claudeTitleAtRightEdge = /^\s*─{8,}\s+([^─\s][^─]*?)\s*$/u
const claudePromptWithoutGap = /^\s*❯/u
const claudeRuleLabel = row => {
  const match = claudeTargetRule.exec(row ?? '')
  return match ? match[1] ?? match[2] : undefined
}
const claudeScrollRule = /^\s*─{3,}\s+([↑↓])\s+[1-9]\d*\s+more\s+─{3,}\s*$/u
const isClaudeRule = row => claudeRule.test(row) || claudeTargetRule.test(row)
const CLAUDE_SHELL_COUNT = /^(\d+) shells?$/i
const CLAUDE_FOOTER_HINT = /(?:mode on|permissions on|accept edits on|\? for shortcuts|↓ to manage)/iu
const CLAUDE_QUEUE_HINT = compact('Press up to edit queued messages')
const CLAUDE_QUEUED_ITEM = /^\s*⎿\s+Queued\s*·/u
const SHELL_PROMPT = /^\s*(?:PS\s+[^>]+>|[A-Z]:[\\/][^>]*>|(?:\S+[@:]\S+|~\S*|\/\S*)\s*[$%#])(?:\s|$)/i
const POWERSHELL_CONTINUATION = /^\s*>>(?:\s|$)/u
// A numbered choice of a prompt: "❯ 1. Yes", "  2. No, and tell Claude what to do differently (esc)"
const APPROVAL_OPTION = /^\s*([❯›>▶])?\s*([1-9])[.)]\s+(\S.*?)\s*$/u
const APPROVAL_PROGRESS = /^\s*[✻✶✽✢✳✦•⠁-⣿◐-◓◴-◷]\s*\S.*\((?:\d+m\s+)?\d+(?:\.\d+)?s\b/iu
const CODEX_APPROVAL_HINT = /\b(?:enter (?:to )?(?:confirm|submit|select)|esc (?:to )?cancel)\b/i
const CLAUDE_QUESTION_HINT = /^(?:Enter to (?:select|submit|chat)|Space to toggle)\b.*\bEsc to cancel$/i
// Claude's own dialogs ("Teach auto mode about your environment?") end their choices with this hint and
// can sit above a composer that is still drawn, with a notice below them (2026-11-24 user report)
const CLAUDE_DIALOG_HINT = /^Enter to confirm\b.*\bEsc to cancel$/i
// The startup trust gate has both choices and its key hint at the end of the visible screen.
const CLAUDE_TRUST_CHOICE = '(❯ *)?(?:[12][.)] *)?(Yes, I trust this folder|No, exit)'
const CLAUDE_TRUST_MENU = new RegExp(`(?:^| )${CLAUDE_TRUST_CHOICE} ${CLAUDE_TRUST_CHOICE} Enter to confirm *· *Esc to cancel$`, 'u')
const CLAUDE_FOLDER_TRUST = {
  question: null, detail: [], options: [], selected: null, signature: 'claude-folder-trust', terminalOnly: 'folder-trust'
}
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
  let covered = false
  for (let row = firstChoice - 1; row > tabs; row--) {
    const text = bare(row).trim()
    if (isClaudeRule(rows[row]) || (lines.length && !text)) break
    if (!text) continue
    // If the heading is cropped, only use the visibly marked question, never preceding log output.
    if (tabs < 0 && !/^\s*[│┃|]/u.test(rows[row])) break
    if (splitOverlayBox(rows[row]).cut) covered = true
    lines.unshift(text)
  }
  // A notice box over the end of its rows (cliOverlayBox.js) leaves a piece of the question that matches
  // none: not known then (the chat's card takes the waiting question), or as read before the box came
  const question = covered ? '' : lines.join(' ').slice(0, 1000)
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
function createAgentInboxWake({ kind, cols, rows, pendingMessages, unhandledMessages = () => [], isWorking, isRunningTask = () => false, isUnknown = () => false, isLive = () => true, isBlocked = () => false, isHookWorking = () => false, messageSeenAt = () => null, quietMs = QUIET_MS, draftNoticeMs = WAKE_DRAFT_NOTICE_AFTER, write, rawWrite = write, parentInput = () => true, onApprovalChange, onDraftBlockChange, wakeRecovery = { blocked: false } }) {
  const screen = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  const antigravity = kind === 'antigravity'
  const dispatched = new Set()
  // Announced while the agent was busy: reminded once after the task if still unanswered
  const deferred = new Set()
  const stopWakes = new Set()
  const stopPending = new Set()
  const stopAnnounced = new Set()
  let stopped = false
  let timer = null
  let stage = null
  // Remember who pasted the notice even if a redraw hides its composer at the deadline.
  let expiredWake = null
  let unseenPasteUntil = 0
  let wakeRecoveryAfter = wakeRecovery.blocked ? 0 : undefined
  let draftBlockSince
  let draftBlockTimer
  let draftBlockNotified = false
  // When the agent last drew anything (a fresh agent counts as waiting once this has been a while)
  let lastOutputAt = Date.now()
  let outputVersion = 0
  let parsedOutputVersion = 0
  let loginVersion = -1
  let loginStage = null
  let userDraft = false
  let forceSendOffer = null
  let emptyClaudeTarget = null
  let composing = false
  // A model / effort picker is open (agentPicker.js): no wake line and no chat line meanwhile
  let held = false
  let holdUntil = 0
  let claudeQuestion = null
  let approvalTimer = null
  let approvalVisible = false
  let approvalOccurrence = 0
  let observedHumanBlock = null
  let commandScreenOpen = false
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
      if (claudePromptWithoutGap.test(line(bottom)) || prompt.test(line(bottom))) return null
      bottom--
    }
    // Some ConPTY frames end the top rule with the session name or omit the gap after ❯.
    // Only accept those shapes with an intact lower rule and a Claude footer underneath.
    const hasClaudeFooter = claudeRule.test(line(bottom))
      && [line(bottom + 1), line(bottom + 2), line(bottom + 3)].some(row => CLAUDE_FOOTER_HINT.test(row))
    for (let first = bottom - 1; first >= Math.max(buffer.baseY + 1, bottom - maxInputRows); first--) {
      const inputRow = line(first)
      const prefix = prompt.exec(inputRow) ?? (hasClaudeFooter ? claudePromptWithoutGap.exec(inputRow) : null)
      if (!prefix) continue
      const top = line(first - 1)
      const edgeTitle = hasClaudeFooter ? claudeTitleAtRightEdge.exec(top)?.[1] : undefined
      if (edgeTitle === undefined && !isClaudeRule(top)) continue
      const target = claudeRuleLabel(top) ?? edgeTitle ?? claudeRuleLabel(line(bottom)) ?? ''
      const footerRow = bottom - buffer.baseY + 1
      const editorRows = { firstRow: first - buffer.baseY, lastRow: footerRow - 2, footerRow, hasClaudeFooter, bounded: true }
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
          painted = { row, x }
        }
      }
      if (dimmedSuggestion && input[0].trim()) {
        return { atStart: true, endsAtCursor: true, text: '', target, ...editorRows, display: '' }
      }
      const display = input.map(row => row.trimEnd()).join('\n')
      const atFirstCell = painted
        ? painted.row === first && painted.x === startColumn
        : buffer.baseY + buffer.cursorY === first && buffer.cursorX === startColumn
      const caretAtStart = input.length === 1 && atFirstCell
      const text = compact(display)
      const queueHint = hasClaudeFooter && !userDraft && (!painted || atFirstCell) && text === CLAUDE_QUEUE_HINT &&
        Array.from({ length: Math.min(8, first - buffer.baseY) }, (_, offset) => line(first - 1 - offset))
          .some(row => CLAUDE_QUEUED_ITEM.test(row))
      // At this empty prompt Claude uses its queue hint even without dim styling. Submitting
      // still requires a later redraw of the full pasted text, since bare Enter sends the queue.
      if (queueHint) return { atStart: true, endsAtCursor: true, text: '', target, ...editorRows, display: '', queueHint }
      if (!painted) {
        // No cursor painted either: Claude out of focus (the chat view or the usage menu has the keyboard)
        // draws its composer without one. Read the entire draft between the rules, including wrapped
        // paths and hard line breaks. Only a single blank or placeholder row counts as empty.
        const typed = input.join('\n').trim()
        const empty = input.length === 1 && !typed
        return { atStart: empty, endsAtCursor: true, text: empty ? '' : compact(typed), caretAtStart, target, ...editorRows, display }
      }
      const afterCursor = (buffer.getLine(painted.row)?.translateToString(false, painted.x) ?? '')
        + input.slice(painted.row - first + 1).join('')
      return {
        atStart: !text && painted.row === first && painted.x === startColumn,
        endsAtCursor: !compact(afterCursor),
        text,
        display,
        caretAtStart,
        target,
        ...editorRows
      }
    }
    return null
  }

  /** `textLength`: the longest draft to look for (default: our own prompts) */
  function composer(textLength = LONGEST_PROMPT, textLines = 1, matchesCodexAttachment) {
    if (antigravity) return readAntigravityScreen(screen).composer
    if (!screen.modes.bracketedPasteMode || claudeFolderTrustScreen() || claudeLoginScreen() || agentPickerScreen()) return null
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
      const target = kind === 'claude' ? claudeRuleLabel(line(index - 1)) ?? '' : undefined
      const suggestion = Boolean(tail.trim()) && lines.every(row => !row.trim()) && isDimmedDraft(buffer.getLine(index), prefix[0].length)
      const display = [tail, ...lines].map(row => row.trimEnd()).join('\n')
      return { atStart, endsAtCursor, suggestion, text: compact(display), display,
        firstRow: index - buffer.baseY, lastRow: cursor - buffer.baseY, target }
    }
    return null
  }

  // The cursor can be parked above the editor on redraw. This fallback identifies the visible
  // draft and its target, and cannot prove emptiness for a new paste.
  function visibleComposer() {
    if (antigravity || !screen.modes.bracketedPasteMode || claudeLoginScreen() || agentPickerScreen()) return null
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
        const target = claudeRuleLabel(rows[start - 1]) ?? claudeRuleLabel(rows[end]) ?? ''
        return text ? { text, display, target } : null
      }
    }
    const { active: buffer } = screen.buffer
    const first = rows.findLastIndex((row, index) => prompt.test(row + ' ') &&
      (kind !== 'claude' || isClaudeRule(rows[index - 1] ?? '')))
    if (first >= 0) {
      const width = prompt.exec(rows[first] + ' ')[0].length
      const promptRow = buffer.getLine(buffer.baseY + first)
      const last = rows.findLastIndex(row => row.trim())
      const statusRow = kind === 'codex' && last > first && CODEX_STATUS_FOOTER.test(rows[last]) ? last : -1
      const end = statusRow >= 0
        ? rows.slice(0, statusRow).findLastIndex(row => row.trim()) + 1
        : rows.findIndex((row, index) => index > first && (kind === 'codex' ? !row.trim() : isClaudeRule(row)))
      const display = [rows[first].slice(width), ...rows.slice(first + 1, end < 0 ? undefined : end)].join('\n')
      const lastRow = end < 0 ? rows.length - 1 : end - 1
      const target = kind === 'claude' ? claudeRuleLabel(rows[first - 1]) ?? '' : undefined
      const suggestion = lastRow === first && isDimmedDraft(promptRow, width)
      if (kind === 'claude' && suggestion) return null
      // Codex dims the transcript's prompt marker. A live marker and the edge of its text
      // identify the editor. The cursor only needs to point into it, wherever the text ends.
      const caretInside = buffer.cursorY >= first && buffer.cursorY <= lastRow
      const statusBelow = statusRow >= end && end >= 0 && rows.slice(end, statusRow).every(row => !row.trim())
      const separated = first > 0 && !rows[first - 1].trim() && end >= 0 && !rows[end].trim()
      const historical = kind === 'codex' && Boolean(promptRow?.getCell(width - 2)?.isDim())
      const bounded = kind === 'codex' && end >= 0 && !historical && (separated || caretInside || statusBelow)
      return { text: compact(display), display, firstRow: first, lastRow, target, bounded, suggestion, historical }
    }
    if (kind === 'codex') return null
    // With a tall draft, Claude can scroll the prompt and top rule out of a short viewport.
    const bottom = rows.findLastIndex(isClaudeRule)
    const footer = rows.slice(bottom + 1).filter(row => row.trim())
    if (bottom <= 0 || rows.length - bottom > 5 || !rows[bottom - 1].trim() || !footer.some(row => CLAUDE_FOOTER_HINT.test(row))) return null
    const display = rows.slice(0, bottom).join('\n')
    return { target: claudeRuleLabel(rows[bottom]) ?? '', text: compact(display), display }
  }

  const editorWithBounds = (input, visible) => input?.bounded ? input : visible?.bounded ? visible : null

  function emptyEditor(input, visible) {
    return chatComposerIsEmpty(input) && (kind !== 'codex' || !visible?.text || visible.suggestion)
  }

  function matchedEditor(input, visible, matches, requireEnd = false) {
    const bounded = editorWithBounds(input, visible)
    const lowerText = kind === 'codex' && bounded && input?.firstRow === bounded.firstRow && input.lastRow > bounded.lastRow
      && input.text !== bounded.text && !CODEX_STATUS_FOOTER.test(screenLines()[input.lastRow])
    if (!requireEnd && bounded && !bounded.suggestion && !lowerText && matches(bounded.text)) return bounded
    if (!input?.endsAtCursor || input.suggestion || visible?.historical || !matches(input.text)) return null
    // A cursor reading may cover one visually blank line inside a multiline draft. It may
    // extend the same editor, but may not truncate it or reach back into a transcript row.
    if (kind === 'codex' && visible?.firstRow !== undefined && input.firstRow !== undefined &&
        (input.firstRow !== visible.firstRow || input.lastRow < visible.lastRow ||
          (input.lastRow > visible.lastRow && input.text === visible.text))) return null
    return input
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
    return prompt && !prompt.usesTerminalInput && !prompt.terminalOnly ? { ...prompt, signature: approvalIdentity(prompt.signature) } : prompt
  }

  const approvalIdentity = signature => `${approvalOccurrence}:${signature}`

  function readApprovalScreen(checkBehindComposer = false) {
    if (codexHookTrustScreen()) return null
    if (claudeFolderTrustScreen()) {
      claudeQuestion = null
      return CLAUDE_FOLDER_TRUST
    }
    if (claudeLoginScreen() || agentPickerScreen()) {
      claudeQuestion = null
      return null
    }
    if (antigravity) {
      return readAntigravityScreen(screen).blocked
        ? { question: null, detail: [], options: [], selected: null, signature: 'antigravity-terminal', usesTerminalInput: true }
        : null
    }
    // Claude draws a numbered draft as "❯ 1. …", just like the selected row of a dialog.
    // Exclude the ruled editor with its footer, or a frameless editor showing the chat paste.
    // Keep checking the rows outside it for a dialog, even while a paste is waiting for Enter.
    const claudeEditor = kind === 'claude' ? composer(checkBehindComposer ? Infinity : undefined) : null
    const pastedHere = claudeEditor?.text && (
      (chat?.draft && parsedOutputVersion > chat.pasteOutputVersion && claudeEditor.text === chat.text) ||
      (lastChatDraft?.sent && lastChatDraft.enterOutputVersion === parsedOutputVersion && claudeEditor.text === lastChatDraft.displayed)
    )
    const editor = claudeEditor?.hasClaudeFooter || pastedHere ? claudeEditor : null
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
      const offset = row - buffer.baseY
      if (editor && offset >= editor.firstRow && offset <= editor.lastRow) {
        raws.push('')
        previous = null
        continue
      }
      const cells = buffer.getLine(row)
      const text = cells?.translateToString(true) ?? ''
      const before = raws[raws.length - 1]
      if (cells?.isWrapped && raws.length && reachesEdge(previous) && !isClaudeRule(before)) raws[raws.length - 1] += text
      else raws.push(text)
      previous = cells
    }
    // A plugin's notice box over the top right goes first: its "╰──╯" on the blank row under the tab strip
    // was read as the question's first row (cliOverlayBox.js)
    const bare = index => withoutOverlayBox(raws[index] ?? '').replace(/^\s*[│┃|]\s?/u, '').replace(/\s*[│┃|]\s*$/u, '')
    const top = 0
    let last = raws.length - 1
    while (last > top && !bare(last).trim()) last--
    // A Claude dialog's choices sit right above its "Enter to confirm · Esc to cancel" hint, wherever that is
    let dialogEnd = -1
    if (kind === 'claude') {
      const hint = raws.findIndex((_, index) => CLAUDE_DIALOG_HINT.test(bare(index).trim()))
      let row = hint - 1
      if (hint > 0 && !bare(row).trim()) row--
      if (row >= top && APPROVAL_OPTION.test(bare(row))) dialogEnd = row
    }
    if (!checkBehindComposer && dialogEnd < 0 && (kind === 'claude' ? claudeEditor : composer())) {
      claudeQuestion = null
      return null
    }
    if (kind === 'claude' && dialogEnd < 0) {
      claudeQuestion = claudeQuestionPrompt(raws, bare, last, claudeQuestion)
      if (claudeQuestion) return claudeQuestion
    }
    if (dialogEnd >= 0) claudeQuestion = null
    // The choices end at most a few lines above the bottom (a hint like "Esc to cancel" may follow)
    let end = dialogEnd >= 0 ? dialogEnd : last
    if (dialogEnd < 0) {
      while (end >= Math.max(top, last - 4) && !APPROVAL_OPTION.test(bare(end))) end--
      if (end < Math.max(top, last - 4)) return null
    }
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
    // Above a live composer only a dialog with its selection marker counts (not a list in the conversation)
    if (dialogEnd >= 0 && !selected) return null
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
    if (isBlocked() || codexHookTrustScreen() || claudeLoginScreen()) return true
    const approval = readApprovalScreen(true)
    return Boolean(approval?.usesTerminalInput || approval?.terminalOnly || approval?.selected)
  }

  function readHumanBlock(prompt) {
    if (codexHookTrustScreen()) return { kind: 'hook-trust' }
    if (prompt?.terminalOnly === 'folder-trust') return { kind: 'folder-trust' }
    if (kind === 'claude' && prompt?.usesTerminalInput) {
      return { kind: 'question', question: prompt.question }
    }
    if (!prompt?.selected || !prompt.options.length) return null
    return { kind: 'approval', question: prompt.question, options: prompt.options.map(option => option.label) }
  }

  function observeHumanBlock(human) {
    if (!human) observedHumanBlock = null
    // The visible approval may be rewrapped or redrawn while the user is still making the same decision.
    else if (human.kind !== observedHumanBlock?.kind) observedHumanBlock = { kind: human.kind, ticket: Symbol() }
    return observedHumanBlock?.ticket
  }

  function inspectBlock() {
    if (stopped || parsedOutputVersion !== outputVersion) return null
    const human = readHumanBlock(readApprovalScreen())
    const ticket = observeHumanBlock(human)
    if (human) return { blocked: human, ticket }
    if (claudeLoginScreen() || agentPickerScreen()) return { blocked: { kind: 'cli-screen' } }
    const parsed = composer(Infinity)
    const input = editorWithBounds(parsed, visibleComposer()) ?? parsed
    if (commandScreenOpen && !input && !shellAtCursor()) return { blocked: { kind: 'cli-screen' } }
    if (input?.text && !input.suggestion && !shellAtCursor()) {
      const wakeText = (stage ?? expiredWake)?.prompt ?? wakeRecovery.submittedPrompt
      const ours = !userDraft && (input.text === lastChatDraft?.text || input.text === lastChatDraft?.displayed ||
        (wakeText !== undefined && input.text === compact(wakeText)) || Boolean(recoverWakeMode(input)))
      return { blocked: { kind: 'draft', ours } }
    }
    return { blocked: null }
  }

  function chatComposerIsEmpty(input) {
    return input?.atStart && (!input.text || input.suggestion)
  }

  function recoverWakeMode(input) {
    if (wakeRecoveryAfter !== undefined || userDraft || lastChatDraft || commandScreenOpen ||
        !input?.bounded || input.suggestion || !parentInput(targetOf(input)) ||
        !pendingMessages().some(id => !dispatched.has(id) && !stopPending.has(id))) return null
    return Object.keys(PROMPTS).find(mode => compact(PROMPTS[mode]) === input.text) ?? null
  }

  function suppressWakeRecovery(submittedPrompt) {
    wakeRecovery.blocked = true
    wakeRecovery.submittedPrompt = submittedPrompt
    wakeRecoveryAfter = outputVersion
  }

  function observeWakeRecovery() {
    if (wakeRecoveryAfter !== undefined && parsedOutputVersion > wakeRecoveryAfter && !shellAtCursor() &&
        !chatBlocked() && emptyEditor(composer(), visibleComposer())) {
      wakeRecoveryAfter = undefined
      wakeRecovery.blocked = false
      wakeRecovery.submittedPrompt = undefined
    }
  }

  function checkDraftBlock() {
    if (!onDraftBlockChange) return
    clearTimeout(draftBlockTimer)
    const now = Date.now()
    const idle = !stopped && !antigravity && isLive() && !composing && !held && !chat &&
      (!isWorking() || (isUnknown() && now - lastOutputAt >= quietMs)) && pendingMessages().length > 0
    if (idle && parsedOutputVersion !== outputVersion) {
      if (draftBlockSince !== undefined && !draftBlockNotified) {
        draftBlockTimer = setTimeout(checkDraftBlock, WAKE_RECOVERY_POLL)
        draftBlockTimer.unref?.()
      }
      return
    }
    const canReadDraft = idle && !shellAtCursor() && !chatBlocked()
    const parsed = canReadDraft && composer(Infinity)
    const input = canReadDraft && (editorWithBounds(parsed, visibleComposer()) ?? parsed)
    if (!input?.text || input.suggestion || chatComposerIsEmpty(input) || !parentInput(targetOf(input))) {
      draftBlockSince = undefined
      if (draftBlockNotified) onDraftBlockChange(false)
      draftBlockNotified = false
      return
    }
    if (draftBlockNotified) return
    draftBlockSince ??= now
    const remaining = draftBlockSince + draftNoticeMs - now
    if (remaining > 0) {
      draftBlockTimer = setTimeout(checkDraftBlock, remaining)
      draftBlockTimer.unref?.()
    } else {
      draftBlockNotified = true
      onDraftBlockChange(true)
    }
  }

  function observeClaudeInput() {
    if (kind !== 'claude') return
    const input = !stage && !held && !composing && !isWorking() && !userDraft && !shellAtCursor() && composer()
    const target = targetOf(input)
    if (input && parentInput(target) && chatComposerIsEmpty(input) && !input.display?.trim()) emptyClaudeTarget = target
    else if (!input?.caretAtStart || target !== emptyClaudeTarget) emptyClaudeTarget = null
  }

  function scheduleApprovalCheck() {
    if ((!onApprovalChange && !observedHumanBlock) || stopped || held || approvalTimer) return
    approvalTimer = setTimeout(() => {
      approvalTimer = null
      if (stopped || held) return
      const prompt = readApprovalScreen()
      if (observedHumanBlock && parsedOutputVersion === outputVersion) observeHumanBlock(readHumanBlock(prompt))
      // A numbered list in streamed output has no selected row. Claude's checklist has its own footer.
      const visible = Boolean(prompt?.usesTerminalInput || prompt?.terminalOnly || prompt?.selected)
      if (visible === approvalVisible) return
      if (!visible) approvalOccurrence++
      approvalVisible = visible
      onApprovalChange?.(visible)
    }, DRAW_SETTLE)
    approvalTimer.unref?.()
  }

  // The prior chat paste can need time to leave the composer or need clearing on the next send.
  let chat = null
  let lastChatDraft = null
  let claudeSentDrafts = []
  let claudeTakeBack = null
  // Per-PTY sequencing follows Orca (MIT), native-chat-pty-send-queue.ts. A paste and its delayed
  // Enter own the editor until both writes finish, so the next send cannot merge into that draft.
  const chatQueue = []
  let approvalWatch = null
  const PASTED_PLACEHOLDER = /^\[Pasted(?:text|Content)[^\]]*\]$/i
  const IMAGE_PREFIX = /^(?:\[Image#[1-9]\d*\])+/
  const CLAUDE_CHIP_ID = /\[(?:Image|Pastedtext)#[1-9]\d*(?=\]|\+|[a-z])/g

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

  function imagePrefix(text, count) {
    const prefix = IMAGE_PREFIX.exec(text)?.[0]
    if (!prefix) return null
    const ids = prefix.match(/\d+/g)
    return ids.length === count && new Set(ids).size === count ? prefix : null
  }

  function matchesClaudeImages(text, images, previousDisplay) {
    const prefix = imagePrefix(text, images.count)
    if (!prefix) return false
    const body = text.slice(prefix.length)
    const before = previousDisplay && compact(previousDisplay)
    if (before) {
      const previousChips = before.match(CLAUDE_CHIP_ID) ?? []
      if (text.includes(before) || (text.match(CLAUDE_CHIP_ID) ?? []).some(id => previousChips.includes(id))) return false
      // Without an empty redraw, accept an exact body or a fresh chip with no leftover text.
      if (body !== images.text && body.split(CLAUDE_PASTE_CHIP).some(Boolean)) return false
    }
    return body === images.text || matchesClaudePaste(body, images.text)
  }

  function matchesCodexImages(text, draft) {
    if (!text.startsWith(draft.labels)) return false
    if (!draft.pastingBody) return imagePrefix(text, draft.nextFile) === text
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
    emptyClaudeTarget = null
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

  function clearClaudeDraft(now) {
    chat.emptyAfterOutput = outputVersion
    chat.clearSettlesAt = now + CHAT_CLEAR_SETTLE
    if (rawWrite(CLAUDE_CLEAR_DRAFT, false)) return true
    finishChat({ ok: false, reason: 'write-failed' }, false)
    return false
  }

  // Like Orca (MIT), native-chat-runtime-send.ts, an ordinary send is aimed at the PTY: the label on
  // Claude's composer rule matters only to a send aimed at that label (a subagent, `draft.verify`)
  function chatTargetMatches(input) {
    const target = targetOf(input)
    if (chat.draft.verify && target !== chat.draft.target) return false
    if (chat.force && (target !== chat.force.target || !parentInput(target))) return false
    return !chat.verify || chat.verify(target)
  }

  function enterChat(now, input) {
    // Orca (MIT), native-chat-runtime-send.ts, issues one separate Enter after the paste window.
    // Keep the attempt marked even if the PTY write fails, since delivery may be uncertain.
    lastChatDraft = { ...chat.draft, sent: true, displayed: input.text, enterOutputVersion: outputVersion }
    const ok = rawWrite('\r')
    if (kind === 'claude') {
      if (ok && (input.bounded || input.endsAtCursor) && (input.text === chat.text || input.text === chat.draft.displayedPaste)) {
        claudeSentDrafts = [...claudeSentDrafts.slice(1 - CLAUDE_TAKE_BACK_LIMIT), lastChatDraft]
      } else {
        claudeSentDrafts = []
      }
    }
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
      && (!chat.requireExact || (drawn && input.display !== chat.unverifiedDisplay))
    if (expired || (now >= firstCheck && pasteIsVisible && ready)) {
      if (!pasteIsVisible) {
        const reason = chat.force && !input ? 'no-composer' : chat.claudeImages ? 'images-not-drawn' : 'not-drawn'
        return finishChat({ ok: false, reason }, false)
      }
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
      if (chat.waitForEmpty) return finish(chat.force ? 'not-cleared' : 'composer-not-empty')
      // A frame received by the deadline can still be waiting on xterm. Give the parser one
      // bounded drain window, and never send from an older frame while more bytes are queued.
      chat.drainUntil ??= now + DRAW_SETTLE * 3
      if (now >= chat.drainUntil) return finish(chat.claudeImages ? 'images-not-drawn' : 'not-drawn')
      chat.timer = setTimeout(checkChat, chat.drainUntil - now)
      chat.timer.unref?.()
      return
    }
    const blocked = chatBlocked()
    if (antigravity) {
      if (blocked) return finish('approval')
      if (isWorking() || isUnknown()) return finish('busy')
    }
    if (chat.waitForEmpty) {
      if (blocked) return finish('approval')
      const input = composer(Infinity)
      if (chat.force && shellAtCursor()) return finish('no-composer')
      if (input && !chatTargetMatches(input)) {
        return finish('target-changed')
      }
      if (now >= chat.expires) return finish(chat.force ? 'not-cleared' : 'composer-not-empty')
      const cleared = chatComposerIsEmpty(input) && parsedOutputVersion > chat.emptyAfterOutput
      // A suggestion can stay on screen when the empty composer receives the clear keys.
      // Let the paste replace it, then require an exact, newly drawn draft before sending Enter.
      const unchanged = chat.force && chat.unverifiedDisplay !== undefined && input?.display === chat.unverifiedDisplay
      const settled = now >= (chat.clearSettlesAt ?? 0)
      if (settled && (cleared || (unchanged && !chat.force.clearRetried))) {
        if (cleared) chat.unverifiedDisplay = undefined
        lastChatDraft = null
        userDraft = false
        pasteChatDraft(now, input)
      } else {
        // A newly drawn remainder can be cleared once more, after the same target checks.
        if (settled && chat.force && !chat.force.clearRetried && input?.text && !unchanged) {
          chat.force.clearRetried = true
          if (!clearClaudeDraft(now)) return
        }
        scheduleChatCheck(now)
      }
      return
    }
    const codexImages = chat.codexImages
    const matchesAttachments = codexImages ? text => matchesCodexImages(text, codexImages) : undefined
    if (blocked) return finish('approval')
    const inShell = shellAtCursor()
    const parsed = !inShell && composer(chat.draft ? Infinity : chat.length, chat.lines, matchesAttachments)
    const visible = !inShell && visibleComposer()
    const claudePaste = text => kind === 'claude' && !chat.claudeImages
      && matchesClaudePaste(text, chat.text, chat.unverifiedDisplay, Boolean(chat.force))
    const matches = matchesAttachments ?? (text => text === chat.text || claudePaste(text)
      || (chat.claudeImages && matchesClaudeImages(text, chat.claudeImages, chat.unverifiedDisplay))
      || ((kind !== 'claude' || (chat.claudeImages && !chat.force)) && !chat.unverifiedDisplay && PASTED_PLACEHOLDER.test(text)))
    const drawn = parsedOutputVersion > chat.pasteOutputVersion
      ? matchedEditor(parsed, visible, matches, Boolean(chat.codexSpeed || codexImages)) : null
    const input = drawn ?? (chat.draft && !visible?.historical
      ? (editorWithBounds(parsed, visible) ?? parsed) || (!chat.requireExact && visible) : parsed)
    if (drawn && chat.draft && claudePaste(drawn.text) && parsedOutputVersion > chat.pasteOutputVersion) {
      chat.draft.displayedPaste = drawn.text
    }
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
      finishChat({ ok: false, reason: chat.claudeImages ? 'images-not-drawn' : 'not-drawn' }, input?.atStart)
      return
    }
    scheduleChatCheck(now)
  }

  function advance() {
    checkDraftBlock()
    if (antigravity || stopped || composing || held || chat || !isLive() || codexHookTrustScreen()) return
    const now = Date.now()
    let attempt = stage ?? expiredWake
    if (parsedOutputVersion !== outputVersion) {
      // Pending terminal bytes are not evidence that the notice disappeared.
      if (attempt) {
        const remaining = attempt.visibleUntil - now
        schedule(remaining > 0 ? Math.min(WAKE_RECOVERY_POLL, remaining) : WAKE_RECOVERY_POLL)
      }
      return
    }
    // State never reported: waiting for input when the screen has been still (the composer check follows)
    const quietFor = now - lastOutputAt
    const freshIdle = isUnknown() && quietFor >= quietMs
    const working = isWorking() && !freshIdle
    const running = working && isRunningTask()
    const hookWorking = isHookWorking()
    const waiting = pendingMessages().filter(id => !dispatched.has(id) && !stopPending.has(id))
    const open = new Set(unhandledMessages())
    for (const id of deferred) if (!open.has(id)) deferred.delete(id)
    const remind = working ? [] : [...deferred].filter(id => !stopPending.has(id))
    const due = waiting.length > 0 || remind.length > 0
    const input = due || attempt ? composer() : null
    const visible = due || attempt ? visibleComposer() : null
    if ((input?.text && !input.suggestion) || (visible?.text && !visible.suggestion)) unseenPasteUntil = 0
    if (!attempt && waiting.length && !shellAtCursor() && !chatBlocked()) {
      const mode = recoverWakeMode(editorWithBounds(input, visible))
      if (mode) {
        // A newly attached observer may have missed the write. Recover only from a current,
        // complete editor with unread mail.
        expiredWake = attempt = { expires: now, visibleUntil: now + WAKE_HIDDEN_TIMEOUT,
          mode, prompt: PROMPTS[mode], ids: mode === 'remind' ? remind : waiting }
      }
    }
    if (attempt) {
      const { expires, mode, prompt, ids } = attempt
      const expected = compact(prompt)
      // The notice once, or repeated when an earlier paste showed late (a session still starting reads its
      // input after drawing the composer, 2026-11-27 user report): either way only our own line
      const ours = text => !!text && text.length % expected.length === 0 && text.length <= expected.length * 3
        && expected.repeat(text.length / expected.length) === text
      const exact = ours(input?.text) && !input.suggestion
      const visibleExact = !visible?.historical && ours(visible?.text)
      // After expiry a matching cursor row alone could belong to history above the real editor.
      const cursorOnly = !expiredWake && (kind !== 'codex' || !visible)
      const rendered = !shellAtCursor() && (visibleExact || (exact && cursorOnly))
      if (rendered) {
        userDraft = false
        attempt.seen = true
        attempt.visibleUntil = now + WAKE_HIDDEN_TIMEOUT
      } else if (now >= attempt.visibleUntil) {
        stage = null
        expiredWake = null
        if (due) schedule()
        return
      }
      const blocked = rendered && chatBlocked()
      const canSubmit = !working || (mode === 'busy' && running && !hookWorking)
      const verified = matchedEditor(input, visible, ours)
      const recoveryUntil = attempt.visibleUntil
      if (rendered && verified && parentInput(targetOf(verified)) && canSubmit && !blocked) {
        // Finish once even when the agent already read the message inside its running turn.
        stage = null
        expiredWake = null
        userDraft = false
        suppressWakeRecovery(prompt)
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
        return
      }
      if (rendered && !blocked) {
        if (stage) stage.expires = now + INPUT_TIMEOUT
        // A never-reported agent counts as ready once its screen is still again: look then.
        const recheck = working && isUnknown() ? Math.min(INPUT_TIMEOUT, quietMs - quietFor + DRAW_SETTLE) : INPUT_TIMEOUT
        schedule(Math.min(recheck, recoveryUntil - now))
        return
      }
      if (stage && now < expires) {
        schedule(Math.min(expires, recoveryUntil) - now)
        return
      }
      if (stage) {
        expiredWake = stage
        stage = null
      }
      // A suspended notice checks at a bounded cadence instead of on each terminal write.
      schedule(Math.min(WAKE_RECOVERY_POLL, recoveryUntil - now))
      // Claude redraws the same queue hint while processing a paste. Keep one attempt until
      // the new draft appears or the recovery window expires, even though this hint is empty.
      if (input?.queueHint) return
      // A paste not drawn yet is still on its way: a CLI that is starting draws its empty composer before
      // it reads input. Pasting again would put the notice in twice (2026-11-27 user report); the attempt
      // ends at visibleUntil and a fresh paste follows then.
      if (!attempt.seen) return
    }
    if (!parentInput(targetOf(input)) || shellAtCursor() || chatBlocked()) return
    // State not reported yet: look again once the screen has been still long enough
    if (due && working && isUnknown() && input?.atStart) { schedule(quietMs - quietFor + DRAW_SETTLE); return }
    // Busy but not in a task (starting up, approval prompt, unknown): wait as before
    if (!due || hookWorking || (working && !running) || !emptyEditor(input, visible)) return
    if (now < holdUntil) { schedule(holdUntil - now); return }
    if (now < unseenPasteUntil) { schedule(unseenPasteUntil - now); return }
    userDraft = false
    emptyClaudeTarget = null
    const mode = waiting.length ? (working ? 'busy' : 'idle') : 'remind'
    expiredWake = null
    stage = { expires: now + INPUT_TIMEOUT, visibleUntil: now + WAKE_HIDDEN_TIMEOUT,
      mode, prompt: PROMPTS[mode], ids: mode === 'remind' ? remind : waiting }
    if (!write(pasteOf(stage.prompt))) { stage = null; return }
    schedule(INPUT_TIMEOUT)
  }

  function screenLines() {
    if (stopped) return []
    const { active: buffer } = screen.buffer
    return Array.from({ length: screen.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
  }

  function claudeFolderTrustScreen() {
    if (kind !== 'claude' || stopped) return false
    const { active: buffer } = screen.buffer
    const tail = []
    for (let row = buffer.baseY + screen.rows - 1; row >= buffer.baseY && tail.length < 8; row--) {
      const text = buffer.getLine(row)?.translateToString(true).trim()
      if (text) tail.unshift(text)
    }
    const match = CLAUDE_TRUST_MENU.exec(tail.join(' ').replace(/\s+/g, ' '))
    return Boolean(match && match[2] !== match[4] && Boolean(match[1]) !== Boolean(match[3]))
  }

  const codexHookTrustScreen = () => kind === 'codex' && isCodexHookTrustScreen(screenLines())
  function claudeLoginScreen() {
    if (stopped || kind !== 'claude') return null
    if (loginVersion !== parsedOutputVersion) {
      loginVersion = parsedOutputVersion
      loginStage = claudeLoginStage(commandRows())
    }
    return loginStage
  }
  // Direct /model and /effort have no picker transaction to hold the PTY. Their numbered highlight
  // is neither a live composer nor an approval: the slash-command watcher hands the screen to the terminal.
  function agentPickerScreen() {
    if (antigravity) return false
    const { lines, wraps } = commandRows()
    const logical = []
    for (const [row, line] of lines.entries()) {
      if (wraps[row] && logical.length) logical[logical.length - 1] += line
      else logical.push(line)
    }
    if (kind === 'codex' && logical.some(row => /^\s*(?:Update available · |Warnings · \d+ of \d+)/iu.test(row)) &&
        logical.some(row => /\b(?:enter continue.*esc skip|esc dismiss & close)\b/i.test(row))) return true
    return isAgentPickerScreen(kind, logical)
  }

  function settleStopWake(attempt, continued = false, expired = false) {
    for (const [id, seenBefore] of attempt.messages) {
      const seen = messageSeenAt(id)
      if (!continued && !(seen && seen !== seenBefore)) continue
      attempt.messages.delete(id)
      stopPending.delete(id)
      stopAnnounced.add(id)
      dispatched.add(id)
      deferred.delete(id)
      attempt.confirmed = true
    }
    if (attempt.messages.size && !expired) return
    const thinking = expired && !attempt.confirmed && attempt.isThinking()
    if (thinking) {
      const remaining = attempt.startedAt + STOP_WAKE_MAX_WAIT - Date.now()
      if (remaining > 0) {
        attempt.timer = setTimeout(() => settleStopWake(attempt, false, true), Math.min(STOP_WAKE_THINKING_RECHECK, remaining))
        attempt.timer.unref?.()
        return
      }
      console.debug('[agent inbox] stop wake released while working')
    }
    clearTimeout(attempt.timer)
    stopWakes.delete(attempt)
    for (const id of attempt.messages.keys()) stopPending.delete(id)
    if (expired && !attempt.confirmed && !thinking) attempt.onUnconfirmed()
    schedule()
  }

  function clearStopWakes() {
    for (const attempt of stopWakes) clearTimeout(attempt.timer)
    stopWakes.clear()
    stopPending.clear()
  }

  function stopWakeReport(report) {
    if (report?.subagent) return
    for (const attempt of stopWakes) {
      const stop = attempt.report
      const sameTurn = report?.promptId === stop.promptId
      const continued = report && report.promptId && report.sessionId === stop.sessionId && report.startedAt > stop.startedAt && (
        (sameTurn && (report.event === 'PreToolUse' || (report.event === 'Stop' && report.stopHookActive === true))) ||
        (!sameTurn && kind === 'codex' && report.event === 'UserPromptSubmit')
      )
      settleStopWake(attempt, continued)
    }
  }

  function prepareStopWake(report, onUnconfirmed, isThinking = () => false) {
    if (stopped || held || chat || stage || expiredWake || composing || !isLive() || chatBlocked()) return null
    if (kind === 'claude' && claudeQueueVisible({ lines: screenLines(), footerRow: composer(Infinity)?.footerRow })) return null
    const available = id => !stopPending.has(id) && !stopAnnounced.has(id)
    const waiting = pendingMessages().filter(id => available(id) && !dispatched.has(id))
    const ids = waiting.length ? waiting : unhandledMessages().filter(available)
    if (!ids.length) return null
    const attempt = { report, startedAt: Date.now(), messages: new Map(ids.map(id => [id, messageSeenAt(id)])),
      confirmed: false, onUnconfirmed, isThinking }
    for (const id of ids) stopPending.add(id)
    stopWakes.add(attempt)
    attempt.timer = setTimeout(() => settleStopWake(attempt, false, true), STOP_WAKE_TIMEOUT)
    attempt.timer.unref?.()
    return waiting.length ? PROMPT : REMIND_PROMPT
  }

  function commandRows() {
    if (stopped) return { lines: [], wraps: [] }
    const { active: buffer } = screen.buffer
    const rows = Array.from({ length: screen.rows }, (_, row) => buffer.getLine(buffer.baseY + row))
    const wraps = rows.map(row => Boolean(row?.isWrapped))
    const lines = rows.map((row, index) => row?.translateToString(!wraps[index + 1]) ?? '')
    return { lines, wraps }
  }

  function resetClaudeTakeBack() {
    claudeSentDrafts = []
    claudeTakeBack = null
  }

  function matchesReturnedClaudePaste(input, texts) {
    if (!claudeTakeBack || Date.now() >= claudeTakeBack.until || userDraft ||
        parsedOutputVersion !== outputVersion || outputVersion <= claudeTakeBack.interruptedAt ||
        shellAtCursor() || chatBlocked()) return false
    const previous = claudeTakeBack.drafts.slice(-texts.length)
    return previous.length === texts.length &&
      previous.some(draft => draft.displayedPaste) &&
      previous.every((draft, index) => draft.text === compact(texts[index])) &&
      previous.map(draft => draft.displayed).join('') === input.text
  }

  // A paste the CLI had not drawn when the user's keys took the attempt away: it still lands, so no
  // second notice into the composer that only looks empty until then
  function rememberUnseenPaste() {
    const pending = stage ?? expiredWake
    if (pending && !pending.seen) unseenPasteUntil = Math.max(unseenPasteUntil, pending.visibleUntil)
  }

  function userInput(data) {
    // The terminal's own replies are not typing: they used to drop the attempt while a new Codex had not
    // drawn the paste yet, and the notice went in again on each focus change (2026-11-27 user report)
    if (TERMINAL_REPORTS.test(data)) return
    rememberUnseenPaste()
    const editingQueue = kind === 'claude' && /^(?:\x1b\[A|\x1bOA|\x10)$/.test(data) && composer()?.queueHint
    finishApprovalAnswer({ ok: false, reason: 'changed' })
    forceSendOffer = null
    emptyClaudeTarget = null
    lastChatDraft = null
    resetClaudeTakeBack()
    expiredWake = null
    suppressWakeRecovery()
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
    } else if (editingQueue) {
      userDraft = true
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
        if (commandScreenOpen && composer()) commandScreenOpen = false
        checkApprovalAnswer(true)
        if (chat) checkChat()
        else {
          if (parsedOutputVersion === outputVersion) {
            observeClaudeInput()
            observeWakeRecovery()
          }
          drainChatQueue()
          if (wasWriting || stage || expiredWake || draftBlockSince !== undefined || deferred.size || pendingMessages().some(id => !dispatched.has(id))) schedule()
        }
        scheduleApprovalCheck()
      })
    },
    approvalPrompt,
    inspectBlock,
    noteCommandScreen() {
      commandScreenOpen = !stopped && parsedOutputVersion === outputVersion && !composer() && !shellAtCursor()
    },
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
        if (!prompt || prompt.usesTerminalInput || prompt.terminalOnly || approvalIdentity(prompt.signature) !== signature || !prompt.options.some(option => option.key === key)) {
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
    submitText(text, images, { codexSpeed, probe = false, strict = false, verify, canSend, offerForce = false, forceToken } = {}) {
      // A per-attempt restriction can expire while its draft is still on screen. Only the
      // target check is saved with the draft for a later send to verify before clearing it.
      const verifySend = canSend ? target => (!verify || verify(target)) && canSend() : verify
      return new Promise(resolve => {
        if (antigravity && (images || codexSpeed || probe || strict)) return resolve({ ok: false, reason: 'unsupported' })
        const queueable = !antigravity && !strict && !codexSpeed && !probe
        if (forceToken && (kind !== 'claude' || !queueable || verify)) return resolve({ ok: false, reason: 'unsupported' })
        const relaxed = ((queueable || antigravity) && !images) || Boolean(forceToken)
        const start = () => {
          if (stopped || !isLive()) return resolve({ ok: false, reason: 'not-agent' })
          if (chat || stage || composing || held) return resolve({ ok: false, reason: 'busy' })
          if (chatBlocked()) return resolve({ ok: false, reason: 'approval' })
          if (antigravity && (isWorking() || isUnknown() || parsedOutputVersion !== outputVersion)) return resolve({ ok: false, reason: 'busy' })
          // Hangul and other wide characters can take two terminal cells per character.
          const files = kind === 'codex' ? images?.files : null
          const length = text.length + (text.match(/[^\x00-\x7f]/g)?.length ?? 0) + (files?.length ?? 0) * 20
          const lines = text.split('\n').length
          const input = composer(relaxed ? Infinity : length, lines)
          if (!input || shellAtCursor()) return resolve({ ok: false, reason: 'no-composer' })
          const target = targetOf(input)
          if (verifySend && !verifySend(target)) return resolve({ ok: false, reason: 'target-changed' })
          // A color-only Claude suggestion appears after a verified empty input without any editing keys.
          const knownSuggestion = relaxed && kind === 'claude' && !verify && target !== null && target === emptyClaudeTarget
            && input.text && input.caretAtStart && parentInput(target) && !userDraft && !isWorking()
          // An empty editor can show a dim placeholder to the right of the caret.
          const empty = emptyEditor(input, visibleComposer()) || knownSuggestion
          // Antigravity text starts in a verified empty editor. A failed paste is left for the user.
          const previous = relaxed && !antigravity ? lastChatDraft : null
          const sameTarget = previous && (!previous.verify || previous.target === target)
          const waitingForPrior = empty && previous?.sent && sameTarget
            && parsedOutputVersion <= previous.enterOutputVersion
          const ours = !empty && sameTarget && input.text
            && (previous.sent || (input.endsAtCursor && (kind !== 'codex' || !input.text.includes('↑'))))
            && (input.text.normalize() === previous.text.normalize() || (previous.sent && input.text === previous.displayed)
              || (!userDraft && input.text === previous.displayedPaste))
            && (!previous.verify || previous.verify(target))
          const offer = forceSendOffer
          forceSendOffer = null
          const canOfferForce = (offerForce || forceToken) && kind === 'claude' && queueable && !verify
            && parentInput(target) && !chatBlocked() && !shellAtCursor()
          if (forceToken && (!canOfferForce || offer?.token !== forceToken || offer.target !== target || (!empty && offer.display !== input.display))) {
            return resolve({ ok: false, reason: 'draft-changed' })
          }
          if (!empty && !ours && !forceToken) {
            if (!canOfferForce) return resolve({ ok: false, reason: 'composer-not-empty' })
            forceSendOffer = { token: randomUUID(), target, display: input.display }
            return resolve({ ok: false, reason: 'composer-not-empty', forceToken: forceSendOffer.token })
          }

          clearTimeout(timer)
          expiredWake = null
          suppressWakeRecovery()
          claudeTakeBack = null
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
            timeout: images ? IMAGE_INPUT_TIMEOUT : relaxed ? CHAT_INPUT_TIMEOUT : INPUT_TIMEOUT,
            resolve, timer: null
          }
          if (forceToken) chat.force = { target }
          if (forceToken || knownSuggestion) {
            chat.requireExact = true
            chat.unverifiedDisplay = knownSuggestion || !empty ? input.display : undefined
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
          if (forceToken && !empty) {
            if (!clearClaudeDraft(now)) return
          } else if (previous && !previous.sent) {
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
        const sameText = input.text === compact(joined)
        const recoveredPaste = !sameText && input.endsAtCursor && matchesReturnedClaudePaste(input, texts)
        if (!input.endsAtCursor || (!sameText && !recoveredPaste)) return resolve({ ok: false, reason: 'different' })
        resetClaudeTakeBack()
        // One key per character from the end; extra keys on an empty composer do nothing
        const displayed = recoveredPaste ? input.display : joined
        if (!rawWrite('\x7f'.repeat(Array.from(displayed).length + texts.length), false)) return resolve({ ok: false, reason: 'write-failed' })
        expiredWake = null
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
    interruptChat() {
      const drafts = claudeSentDrafts
      userInput('\x1b')
      // Only a deliberate chat Esc can authorize taking back the exact chips observed at Enter.
      if (drafts.some(draft => draft.displayedPaste)) {
        claudeTakeBack = { drafts, interruptedAt: outputVersion, until: Date.now() + CHAT_INPUT_TIMEOUT }
      }
    },
    deferProbeInput(data) {
      if (!chat?.probe) return false
      chat.terminalInput.push(data)
      return true
    },
    setComposing(value) {
      composing = value
      if (value) {
        rememberUnseenPaste()
        forceSendOffer = null
        emptyClaudeTarget = null
        expiredWake = null
        suppressWakeRecovery()
        finishApprovalAnswer({ ok: false, reason: 'changed' })
        lastChatDraft = null
        resetClaudeTakeBack()
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
        forceSendOffer = null
        emptyClaudeTarget = null
        finishApprovalAnswer({ ok: false, reason: 'changed' })
        lastChatDraft = null
        resetClaudeTakeBack()
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
    claudeLoginScreen,
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
      if (stopped || codexHookTrustScreen()) return null
      const input = composer()
      return input ? (input.atStart ? 'empty' : 'draft') : null
    },
    /** The CLI asked for application cursor keys (arrows as ESC O A) */
    applicationCursorKeys: () => !stopped && screen.modes.applicationCursorKeysMode,
    resize(cols, rows) { screen.resize(cols, rows); loginVersion = -1; emptyClaudeTarget = null; scheduleApprovalCheck(); schedule() },
    kick: schedule,
    prepareStopWake,
    stopWakeReport,
    clearStopWakes,
    close() {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      checkDraftBlock()
      clearTimeout(approvalTimer)
      clearStopWakes()
      finishApprovalAnswer({ ok: false, reason: 'not-agent' })
      cancelQueuedChats('not-agent')
      if (chat) finishChat({ ok: false, reason: 'not-agent' }, false)
      screen.dispose()
    }
  }
}

module.exports = { createAgentInboxWake, PROMPT, BUSY_PROMPT, REMIND_PROMPT, supportsAntigravityInput: true }
