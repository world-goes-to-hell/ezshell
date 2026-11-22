import { describe, expect, it } from 'vitest'
import { isAwayFromBottom, isChatQuestion, previousQuestionIndex, questionLine } from './chatScrollNav'
import type { AgentChatItem } from '../types'

const item = (fields: Partial<AgentChatItem>) => ({ id: 'a', kind: 'user', text: '', time: null, ...fields }) as AgentChatItem

describe('moving through a long chat', () => {
  const questions = [{ index: 1, start: 12 }, { index: 5, start: 400 }, { index: 9, start: 1200 }]

  it('goes to the nearest question above the screen', () => {
    expect(previousQuestionIndex(questions, 0)).toBeNull()
    expect(previousQuestionIndex(questions, 12)).toBeNull()
    expect(previousQuestionIndex(questions, 13)).toBe(1)
    expect(previousQuestionIndex(questions, 800)).toBe(5)
    expect(previousQuestionIndex(questions, 5000)).toBe(9)
    expect(previousQuestionIndex([], 500)).toBeNull()
  })

  it('walks up one question each time: the question it went to is on screen', () => {
    // scrollToIndex leaves the bar's room above the row
    expect(previousQuestionIndex(questions, 400 - 36)).toBe(1)
  })

  it('offers the way down only away from the end', () => {
    expect(isAwayFromBottom(840, 400, 1400)).toBe(false)
    expect(isAwayFromBottom(500, 400, 1400)).toBe(true)
  })

  it('counts typed lines, not the mail notices', () => {
    expect(isChatQuestion(item({}))).toBe(true)
    expect(isChatQuestion(item({ inboxNotice: true }))).toBe(false)
    expect(isChatQuestion(item({ kind: 'assistant' }))).toBe(false)
  })

  it('shows the first written line', () => {
    expect(questionLine(item({ text: '\n  고쳐 줘\n둘째 줄' }))).toBe('고쳐 줘')
    expect(questionLine(item({ text: '' }))).toBe('스크린샷 첨부')
  })
})
