// A stand-in for Claude Code's AskUserQuestion dialog, drawn and driven as the real CLI was seen to behave
// (Claude Code 2.1.3xx, 2026-11-23: docs/plan/2026-11-23-chat-claude-question-card.md). Used by the unit
// test of src/ipc/claudeQuestions.js and by the fake agent of local-agent-chat (localAgentApp.js).
//   lines(): the screen rows; write(keys): one key as the pty gets it; state.submitted: the answers once sent
// reviewAs: answers the review shows instead of the real ones (a CLI that differs)

function createFakeAskDialog(questions, { reviewAs = null } = {}) {
  const state = { tab: 0, submitted: null, keys: [] }
  const tabs = questions.map(() => ({ pointer: 1, checks: new Set(), typed: '', answer: null, typing: false }))
  const rule = '─'.repeat(40)
  const strip = () => (questions.length === 1 && !questions[0].multiSelect ? ' ☐ ' + questions[0].header + ' '
    : '←  ' + questions.map((q, i) => (tabs[i].answer !== null || tabs[i].checks.size ? '☒ ' : '☐ ') + q.header).join('  ') + '  ✔ Submit  →')
  const answerText = i => {
    const q = questions[i]
    if (!q.multiSelect) return tabs[i].answer
    const labels = q.options.map((o, k) => (tabs[i].checks.has(k + 1) ? o.label : null)).filter(Boolean)
    if (tabs[i].checks.has(q.options.length + 1) && tabs[i].typed) labels.push(tabs[i].typed)
    return labels.length ? labels.join(', ') : null
  }
  function lines() {
    const head = ['● 아래에서 고르세요', '  1. 대화 속 번호 목록', '  2. 이것도 선택지가 아님', rule, strip()]
    if (state.tab === 'done') return []
    if (state.tab === 'review') {
      const body = []
      if (questions.some((_, i) => answerText(i) === null)) body.push('⚠ Some questions are unanswered', '')
      questions.forEach((q, i) => { const a = answerText(i); if (a !== null) body.push(' ● ' + q.question, '   → ' + (reviewAs?.[i] ?? a)) })
      return [...head, 'Review your answers', ...body, '❯ 1. Submit answers', '  2. Cancel']
    }
    const q = questions[state.tab]
    const t = tabs[state.tab]
    const p = n => (t.pointer === n ? '❯ ' : '  ')
    const n = q.options.length
    const rows = q.options.flatMap((o, k) => q.multiSelect
      ? [`${p(k + 1)}${k + 1}. [${t.checks.has(k + 1) ? '✔' : ' '}] ${o.label}`, `         ${o.description}`]
      : [`${p(k + 1)}${k + 1}. ${o.label}`, `     ${o.description}`])
    rows.push(q.multiSelect ? `${p(n + 1)}${n + 1}. [${t.checks.has(n + 1) ? '✔' : ' '}] ${t.typed || 'Type something'}` : `${p(n + 1)}${n + 1}. ${t.typed || 'Type something.'}`)
    if (q.multiSelect) rows.push(`${t.pointer === 'move' ? '❯' : ' '}    ${state.tab === questions.length - 1 ? 'Submit' : 'Next'}`)
    return [...head, '', q.question, '', ...rows, rule, `  ${n + 2}. Chat about this`, '', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel']
  }
  function advance() {
    if (questions.length === 1 && !questions[0].multiSelect) { state.tab = 'done'; state.submitted = [answerText(0)]; return }
    state.tab = state.tab + 1 < questions.length ? state.tab + 1 : 'review'
  }
  function write(data) {
    state.keys.push(data)
    if (state.tab === 'done') return true
    if (state.tab === 'review') {
      if (data === '1') { state.submitted = questions.map((_, i) => answerText(i)); state.tab = 'done' }
      return true
    }
    const q = questions[state.tab]
    const t = tabs[state.tab]
    const n = q.options.length
    const typing = t.pointer === n + 1 && (q.multiSelect || t.typing)
    if (data === '\x1b[B' || data === '\x1bOB') {
      t.pointer = t.pointer === 'move' ? 'move' : t.pointer < n + 1 ? t.pointer + 1 : q.multiSelect ? 'move' : n + 1
    } else if (data === '\r') {
      if (q.multiSelect) {
        if (t.pointer === 'move') advance()
        else if (t.checks.has(t.pointer)) t.checks.delete(t.pointer)
        else t.checks.add(t.pointer)
      } else if (t.pointer === n + 1 && t.typed) { t.answer = t.typed; advance() }
      else if (typeof t.pointer === 'number' && t.pointer <= n) { t.answer = q.options[t.pointer - 1].label; advance() }
    } else if (typing && !/^[\x00-\x1f]/.test(data)) {
      t.typed += data
      if (q.multiSelect) t.checks.add(n + 1)
    } else if (/^[1-9]$/.test(data) && Number(data) <= n + 1) {
      const k = Number(data)
      if (q.multiSelect) { if (t.checks.has(k)) t.checks.delete(k); else t.checks.add(k) }
      else if (k === n + 1) { t.pointer = k; t.typing = true }
      else { t.answer = q.options[k - 1].label; advance() }
    }
    return true
  }
  return { state, lines, write }
}

module.exports = { createFakeAskDialog }
