// Claude's AskUserQuestion in the chat view (docs/plan/2026-11-23-chat-claude-question-card.md): which
// question the card answers, and the card's choices as the answers main checks (src/agentChat/askQuestions.js)
import type { AgentAskAnswer, AgentAskQuestion, AgentChatApproval, AgentChatItem } from '../types'

const compact = (text: string | null | undefined) => (text ?? '').replace(/\s/g, '')

/** The latest AskUserQuestion not answered yet, or null */
export function pendingAskItem(items: readonly AgentChatItem[]): AgentChatItem | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const tool = items[index].tool
    if (!tool?.question) continue
    return tool.result === undefined && !tool.isError ? items[index] : null
  }
  return null
}

/**
 * The question the card can answer: the pending AskUserQuestion while Claude's dialog for it is on screen
 * (`approval.usesTerminalInput`, its question one of the item's: the top of a long question may be cut off)
 */
export function answerableAskItem(items: readonly AgentChatItem[], approval: AgentChatApproval | null): AgentChatItem | null {
  if (!approval?.usesTerminalInput) return null
  const item = pendingAskItem(items)
  const questions = item?.tool?.question?.questions
  if (!item || !questions) return null
  const shown = compact(approval.question)
  if (!shown) return item
  return questions.some(entry => compact(entry.question) === shown || compact(entry.question).endsWith(shown)) ? item : null
}

/** One question's choices on the card */
export interface AskDraft {
  picks: number[]
  /** The typed answer is chosen (a single choice: instead of the choices) */
  otherOn: boolean
  other: string
}

export const emptyDraft = (): AskDraft => ({ picks: [], otherOn: false, other: '' })

/** Picks a choice: a single choice replaces the answer, a checklist toggles it */
export function pick(question: AgentAskQuestion, draft: AskDraft, index: number): AskDraft {
  if (!question.multiSelect) return { ...draft, picks: [index], otherOn: false }
  const picks = draft.picks.includes(index) ? draft.picks.filter(entry => entry !== index) : [...draft.picks, index].sort((a, b) => a - b)
  return { ...draft, picks }
}

/** Turns the typed answer on or off (a single choice: on drops the picked choice) */
export function toggleOther(question: AgentAskQuestion, draft: AskDraft, on: boolean): AskDraft {
  return question.multiSelect ? { ...draft, otherOn: on } : { ...draft, otherOn: on, picks: on ? [] : draft.picks }
}

// The CLI takes a typed answer as one line: keys and line breaks are refused by main as well
const OTHER_MAX = 500
const BAD_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u

export function otherProblem(draft: AskDraft): string | null {
  if (!draft.otherOn) return null
  const text = draft.other.trim()
  if (!text) return '직접 입력할 답을 적어 주세요.'
  if (text.length > OTHER_MAX) return `직접 입력은 ${OTHER_MAX}자까지입니다.`
  if (BAD_TEXT.test(draft.other)) return '직접 입력은 한 줄로 적어 주세요.'
  return null
}

/** The answer main gets for one question, or null while it is not complete */
export function answerOf(question: AgentAskQuestion, draft: AskDraft): AgentAskAnswer | null {
  if (otherProblem(draft)) return null
  const other = draft.otherOn ? draft.other.trim() : null
  const count = draft.picks.length + (other ? 1 : 0)
  if (question.multiSelect ? count < 1 : count !== 1) return null
  return { picks: draft.picks, other }
}

/** The answer as the review and Claude show it: the picked labels in the list's order, then the typed text */
export function answerText(question: AgentAskQuestion, draft: AskDraft): string {
  return [...draft.picks.map(index => question.options[index]?.label ?? ''), ...(draft.otherOn && draft.other.trim() ? [draft.other.trim()] : [])].join(', ')
}

/** Every answer, or null while one is missing */
export function answersOf(questions: readonly AgentAskQuestion[], drafts: readonly AskDraft[]): AgentAskAnswer[] | null {
  const answers = questions.map((question, index) => answerOf(question, drafts[index] ?? emptyDraft()))
  return answers.every(Boolean) ? answers as AgentAskAnswer[] : null
}
