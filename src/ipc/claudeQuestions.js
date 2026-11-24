// Answers Claude's AskUserQuestion screen from the chat view's question card: main presses the keys, one
// at a time, each only while the screen shows what that key is for (checked with Claude Code 2.1.3xx on
// this PC, 2026-11-23, docs/plan/2026-11-23-chat-claude-question-card.md):
//   - a strip of tabs on top when there are several questions or a checklist: "←  ☒ Color  ☐ Fruits  ✔ Submit  →"
//   - the question, then its numbered choices, then "Type something" and "Chat about this"
//   - single choice: the number picks it and moves on (the only question: answers at once). A typed answer:
//     the number of "Type something" puts the selection there, then the text, then Enter
//   - checklist: a number toggles its box ("[✔]") without moving the selection; a typed answer is typed on the
//     "Type something" row (reached with ↓); the row below it ("Next", last "Submit") with Enter moves on
//   - several questions end on "Review your answers": "● <question>" / "→ <answers>", "❯ 1. Submit answers"
//   - choices with previews (single choice only): the chosen one's preview in a box to the right, no "Type
//     something"; a number only moves the selection, Enter picks it
// Before the last key the answers on that review are compared with the ones chosen; anything unexpected
// stops the run where it is (the window then hands the pane to the terminal).

const compact = text => String(text ?? '').replace(/\s/g, '')
const POINTER = '[❯›>▶]'
const OPTION_ROW = new RegExp(`^\\s*(${POINTER})?\\s*(\\d{1,2})\\.\\s+(?:\\[([ ✔xX✓])\\]\\s+)?(.*?)\\s*$`, 'u')
const MOVE_ROW = new RegExp(`^\\s*(${POINTER})?\\s+(Next|Submit)\\s*$`, 'u')
const HINT = /^\s*Enter to (?:select|submit)\b.*\bEsc to cancel\s*$/i
const TAB_STRIP = /^\s*(?:←\s+)?[☐☒✔]\s+\S/u
const RULE = /^\s*─{8,}/u
const REVIEW = /^\s*Review your answers\s*$/i
const UNANSWERED = /Some questions are unanswered/i
// The hint once the "Type something" row takes typing ("ctrl+g to edit in Notepad"): keys sent before it are lost
const EDIT_HINT = /\bctrl\+g to edit\b/i
const SUBMIT_ANSWERS = new RegExp(`^\\s*(${POINTER})?\\s*1\\.\\s+Submit answers\\s*$`, 'u')
const bare = line => String(line ?? '').replace(/^\s*[│┃|]\s?/u, '').replace(/\s*[│┃|]\s*$/u, '')
// A question whose choices have previews draws the chosen one's preview in a box right of the choices:
// "❯ 1. Icon card      ┌────┐" / "    (Recommended)   │ … │". Its rows are cut where the box starts.
const PREVIEW_TOP = /\S\s{2,}┌─+┐\s*$/u
const PREVIEW_PART = /\s{2,}[┌│└].*$/u

/**
 * The question screen: { question (its text, spaces removed; null when a low pane scrolled it off),
 * options: [{ number, checked, text }], pointer (number, 'move' on Next / Submit, or null) }, or null
 */
function readQuestionScreen(lines) {
  const preview = lines.some(line => PREVIEW_TOP.test(String(line ?? '')))
  const rows = lines.map(line => bare(preview ? String(line ?? '').replace(PREVIEW_PART, '') : line))
  // A narrow pane folds the hint over two rows ("… navigate ·" / "Esc to cancel")
  const hint = rows.findLastIndex((row, index) => HINT.test(row) || HINT.test(row.trimEnd() + ' ' + (rows[index + 1] ?? '').trim()))
  if (hint < 0) return null
  // The dialog starts at its strip of tabs (shown even for one question: " ☐ Color "). A low pane scrolls
  // the strip and the question off once the selection goes down: then the choices start at the last "1."
  // (whose labels the caller compares; a numbered list of the conversation above comes earlier)
  const strip = rows.slice(0, hint).findLastIndex(row => TAB_STRIP.test(row))
  const firstOption = strip >= 0
    ? rows.findIndex((row, index) => index > strip && index < hint && OPTION_ROW.test(row))
    : rows.slice(0, hint).findLastIndex(row => OPTION_ROW.exec(row)?.[2] === '1')
  if (firstOption < 0) return null
  const question = strip >= 0 ? rows.slice(strip + 1, firstOption).filter(row => row.trim()).join('') : null
  const options = []
  let pointer = null
  let last = null
  for (let index = firstOption; index < hint; index++) {
    const row = rows[index]
    const option = OPTION_ROW.exec(row)
    const move = MOVE_ROW.exec(row)
    if (option) {
      last = { number: Number(option[2]), checked: option[3] === undefined ? null : option[3] !== ' ', text: option[4] }
      options.push(last)
      if (option[1]) pointer = last.number
    } else if (move) {
      last = null
      if (move[1]) pointer = 'move'
    } else if (RULE.test(row) || !row.trim()) {
      last = null
    } else if (last && /^\s{2,}\S/.test(row)) {
      // An indented line under a choice: its description, or its own text wrapped
      last.more = (last.more ?? '') + row.trim()
    }
  }
  return { question: question === null ? null : compact(question), options, pointer, preview }
}

/** The review before submitting: { entries: [{ question, answer }] (spaces removed), unanswered, ready }, or null */
function readReview(lines) {
  const rows = lines.map(bare)
  const start = rows.findLastIndex(row => REVIEW.test(row))
  if (start < 0) return null
  const entries = []
  let current = null
  let ready = false
  for (const row of rows.slice(start + 1)) {
    const submit = SUBMIT_ANSWERS.exec(row)
    if (submit) { ready = Boolean(submit[1]); break }
    const question = /^\s*●\s+(.*)$/u.exec(row)
    const answer = /^\s*→\s*(.*)$/u.exec(row)
    if (question) { current = { question: compact(question[1]), answer: null }; entries.push(current) }
    else if (answer && current) current.answer = compact(answer[1])
    else if (current && row.trim()) {
      if (current.answer === null) current.question += compact(row)
      else current.answer += compact(row)
    }
  }
  return { entries, unanswered: rows.some(row => UNANSWERED.test(row)), ready }
}

/** What the review shows for an answer: the picked labels in the list's order, then the typed text */
function reviewText(question, answer) {
  return [...answer.picks.map(pick => question.options[pick].label), ...(answer.other ? [answer.other] : [])].join(', ')
}

function sameAnswer(shown, expected) {
  return shown !== null && shown === compact(expected)
}

/**
 * lines(): the agent's screen; write(keys) → bool; hold(on): keep the inbox wake and chat lines out;
 * appCursor(): arrows as ESC O.
 */
function createClaudeQuestionAnswerer({ lines, write, hold = () => {}, appCursor = () => false, pollMs = 40, stepTimeout = 2000, quietMs = 90, releaseMs = 400 }) {
  const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
  let activeQuestions = null

  async function until(check, timeout = stepTimeout) {
    const end = Date.now() + timeout
    for (;;) {
      const value = check()
      if (value) return value
      if (Date.now() >= end) return null
      await sleep(pollMs)
    }
  }
  // Claude repaints its dialog in pieces after a key: read once the screen has stopped changing
  async function settle() {
    let last = lines().join('\n')
    for (let tries = 0; tries < 20; tries++) {
      await sleep(quietMs)
      const now = lines().join('\n')
      if (now === last) return
      last = now
    }
  }
  const arrow = direction => (appCursor() ? '\x1bO' : '\x1b[') + direction
  // Beside a preview box a long label goes on in the next row (there are no descriptions there)
  const labelsMatch = (screen, question) => question.options.every((option, index) => {
    const row = screen.options.find(entry => entry.number === index + 1)
    return compact(row?.text) === compact(option.label) || (screen.preview && compact((row?.text ?? '') + (row?.more ?? '')) === compact(option.label))
  })
  // The question on screen: by its text (a notice drawn over the dialog's right side may follow it on
  // the row), or, once a low pane scrolled the text off, by a list of choices unique in the dialog.
  const on = question => {
    const screen = readQuestionScreen(lines())
    if (!screen) return null
    if (screen.question !== null) return screen.question.startsWith(compact(question.question)) ? screen : null
    const matches = activeQuestions.filter(candidate => labelsMatch(screen, candidate))
    return matches.length === 1 && matches[0] === question ? screen : null
  }
  const writeFor = (question, key) => on(question) && write(key)
  /** A key while `question` shows, then the screen it led to once `done(screen)` says so */
  async function press(question, key, done) {
    if (!writeFor(question, key)) return null
    const after = await until(() => { const screen = on(question); return screen && done(screen) ? screen : null })
    if (after) await settle()
    return after
  }
  async function moveDownTo(question, target) {
    for (let step = 0; step < 20; step++) {
      const screen = on(question)
      if (!screen) return false
      if (screen.pointer === target) return true
      const before = screen.pointer
      if (!(await press(question, arrow('B'), now => now.pointer !== before))) return false
    }
    return false
  }
  const typeRow = (screen, question) => screen.options.find(option => option.number === question.options.length + 1)
  const typed = (screen, question, text) => {
    const row = typeRow(screen, question)
    return row && compact(row.text + (row.more ?? '')) === compact(text)
  }
  /**
   * Types the answer into the "Type something" row (the selection is on it): once the row takes typing,
   * then waits for the text to show. The hint may be missing in another CLI version: then a short wait.
   */
  async function typeOther(question, text) {
    await until(() => EDIT_HINT.test(lines().join(' ')), 1000)
    await settle()
    return press(question, text, screen => typed(screen, question, text))
  }
  /** Moves past `question`: the screen shows another question, the review, or no question at all */
  const leaves = question => until(() => !on(question))

  async function single(question, answer) {
    // With previews the number only moves the selection (its preview shows) and Enter picks it; there is
    // no "Type something" row
    if (on(question)?.preview) {
      const number = answer.picks[0] + 1
      if (answer.other || !number) return 'changed'
      if (!(await press(question, String(number), screen => screen.pointer === number))) return 'stuck'
      if (!writeFor(question, '\r')) return 'changed'
      return (await leaves(question)) ? null : 'stuck'
    }
    if (!answer.other) {
      if (!writeFor(question, String(answer.picks[0] + 1))) return 'changed'
      return (await leaves(question)) ? null : 'stuck'
    }
    const typeNumber = question.options.length + 1
    if (!(await press(question, String(typeNumber), screen => screen.pointer === typeNumber))) return 'stuck'
    if (!(await typeOther(question, answer.other))) return 'stuck'
    if (!writeFor(question, '\r')) return 'changed'
    return (await leaves(question)) ? null : 'stuck'
  }

  async function checklist(question, answer) {
    const screen = on(question)
    if (!screen) return 'changed'
    for (const [index] of question.options.entries()) {
      const want = answer.picks.includes(index)
      const box = on(question)?.options.find(option => option.number === index + 1)
      if (!box || box.checked === null) return 'changed'
      if (box.checked === want) continue
      const flipped = await press(question, String(index + 1), now => now.options.find(option => option.number === index + 1)?.checked === want)
      if (!flipped) return 'stuck'
    }
    if (answer.other) {
      if (!(await moveDownTo(question, question.options.length + 1))) return 'stuck'
      if (!(await typeOther(question, answer.other))) return 'stuck'
    }
    if (!(await moveDownTo(question, 'move'))) return 'stuck'
    if (!writeFor(question, '\r')) return 'changed'
    return (await leaves(question)) ? null : 'stuck'
  }

  async function submitReview(questions, answers) {
    const review = await until(() => readReview(lines()))
    if (!review) return 'stuck'
    await settle()
    const now = readReview(lines())
    if (!now || now.unanswered || !now.ready) return 'mismatch'
    for (const [index, question] of questions.entries()) {
      const entry = now.entries.find(item => item.question === compact(question.question))
      if (!entry || !sameAnswer(entry.answer, reviewText(question, answers[index]))) return 'mismatch'
    }
    if (!write('1')) return 'changed'
    return (await until(() => !readReview(lines()))) ? null : 'stuck'
  }

  /**
   * Answers every question (answers checked with askQuestions.cleanAnswer): { ok } or { ok: false, reason }
   * ('busy', 'changed': not the screen expected, 'stuck': a key did not do what it does, 'mismatch': the
   * review differs from the answers chosen, nothing submitted)
   */
  async function answer(questions, answers) {
    if (activeQuestions) return { ok: false, reason: 'busy' }
    activeQuestions = questions
    hold(true)
    try {
      for (const [index, question] of questions.entries()) {
        if (!(await until(() => on(question)))) return { ok: false, reason: 'changed' }
        await settle()
        const failed = question.multiSelect ? await checklist(question, answers[index]) : await single(question, answers[index])
        if (failed) return { ok: false, reason: failed }
      }
      // The only question, a single choice: its number answered it (no review)
      const direct = questions.length === 1 && !questions[0].multiSelect
      const failed = direct ? null : await submitReview(questions, answers)
      return failed ? { ok: false, reason: failed } : { ok: true }
    } finally {
      await sleep(releaseMs)
      activeQuestions = null
      hold(false)
    }
  }

  return { answer }
}

module.exports = { createClaudeQuestionAnswerer, readQuestionScreen, readReview, reviewText }
