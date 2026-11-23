// Claude's AskUserQuestion in the chat view: the questions from its tool_use input and the answers from
// its result (checked with Claude Code 2.1.3xx on this PC, 2026-11-23):
//   input:  { questions: [{ question, header, multiSelect, options: [{ label, description }] }] }
//   result: toolUseResult.answers = { "<question>": "<label>, <label>" } (a typed answer is its text)
// Only these fields reach the window, each clipped.

const ASK_TOOL = 'AskUserQuestion'
const LIMITS = { questions: 6, options: 10, question: 1000, header: 60, label: 200, description: 500, answer: 2000 }

const str = value => (typeof value === 'string' ? value : '')
const clip = (value, max) => {
  const text = str(value).replace(/\r\n?/g, '\n').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** The questions of an AskUserQuestion input, cleaned, or null when they cannot be shown as a card */
function askQuestionsOf(input) {
  const list = Array.isArray(input?.questions) ? input.questions : null
  if (!list || !list.length || list.length > LIMITS.questions) return null
  const questions = []
  for (const entry of list) {
    const question = clip(entry?.question, LIMITS.question)
    const options = Array.isArray(entry?.options) ? entry.options : []
    if (!question || options.length < 1 || options.length > LIMITS.options) return null
    const cleaned = options.map(option => ({ label: clip(option?.label, LIMITS.label), description: clip(option?.description, LIMITS.description) }))
    if (cleaned.some(option => !option.label)) return null
    questions.push({ question, header: clip(entry?.header, LIMITS.header), multiSelect: entry?.multiSelect === true, options: cleaned })
  }
  return { questions }
}

/** The answers of the result, one per question (null for a question left unanswered), or undefined */
function askAnswersOf(result, questions) {
  const answers = result?.answers
  if (!answers || typeof answers !== 'object' || !Array.isArray(questions)) return undefined
  const byQuestion = new Map(Object.entries(answers).map(([question, answer]) => [clip(question, LIMITS.question), answer]))
  return questions.map(entry => {
    const answer = byQuestion.get(entry.question)
    return typeof answer === 'string' && answer.trim() ? clip(answer, LIMITS.answer) : null
  })
}

/**
 * An answer from the window, checked against the question: { picks: option indexes, other: typed text }.
 * One choice or a typed answer for a single choice question; any number (at least one) for a checklist.
 * Null when it does not fit (a typed answer must be one line without control characters).
 */
function cleanAnswer(question, answer) {
  if (!question || !answer || typeof answer !== 'object') return null
  const picks = Array.isArray(answer.picks) ? answer.picks : []
  if (picks.length > question.options.length) return null
  if (!picks.every(pick => Number.isInteger(pick) && pick >= 0 && pick < question.options.length)) return null
  if (new Set(picks).size !== picks.length) return null
  let other = null
  if (answer.other !== undefined && answer.other !== null) {
    if (typeof answer.other !== 'string') return null
    // Control characters would be keys to the CLI (Enter, Esc); Unicode line separators would break the line
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(answer.other)) return null
    other = answer.other.trim()
    if (!other || other.length > 500) return null
  }
  const count = picks.length + (other ? 1 : 0)
  if (question.multiSelect ? count < 1 : count !== 1) return null
  return { picks: [...picks].sort((a, b) => a - b), other }
}

module.exports = { ASK_TOOL, LIMITS, askQuestionsOf, askAnswersOf, cleanAnswer }
