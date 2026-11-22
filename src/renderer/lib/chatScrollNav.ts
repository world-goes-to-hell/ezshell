// Moving through a long chat (2026-11-22 user request, as the agent CLIs do): a bar over the top of the
// conversation goes to the question before what is on screen, a button over the bottom goes back down.

import type { AgentChatItem } from '../types'

/** The room the bar takes over the conversation: a question it jumps to lands below it */
export const QUESTION_BAR_PX = 36
/** Farther than this from the end of the conversation, the button to go back down shows */
export const AWAY_FROM_BOTTOM_PX = 160

/** A line the user typed (not the agent mail notices ezShell put in the composer) */
export function isChatQuestion(item: AgentChatItem): boolean {
  return item.kind === 'user' && !item.inboxNotice
}

/** The nearest question that has scrolled out of view above, by row start (rows in order) */
export function previousQuestionIndex(questions: readonly { index: number; start: number }[], scrollTop: number): number | null {
  let low = 0
  let high = questions.length - 1
  let found: number | null = null
  while (low <= high) {
    const middle = (low + high) >> 1
    if (questions[middle].start < scrollTop) {
      found = questions[middle].index
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

export function isAwayFromBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight > AWAY_FROM_BOTTOM_PX
}

/** The question as one line for the bar */
export function questionLine(item: AgentChatItem): string {
  const line = item.text?.split('\n').find(text => text.trim())?.trim()
  return line || '스크린샷 첨부'
}
