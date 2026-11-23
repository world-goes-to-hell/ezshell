import { describe, expect, it } from 'vitest'
import type { AgentAskQuestion, AgentChatApproval, AgentChatItem } from '../types'
import { answerableAskItem, answerOf, answersOf, answerText, emptyDraft, otherProblem, pendingAskItem, pick, toggleOther } from './askQuestion'

const color: AgentAskQuestion = { question: 'Which color do you want for the new theme?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Green', description: 'calm' }] }
const fruits: AgentAskQuestion = { question: 'Which fruits?', header: 'Fruits', multiSelect: true, options: [{ label: 'Apple', description: '' }, { label: 'Banana', description: '' }, { label: 'Cherry', description: '' }] }

const ask = (id: string, extra: Partial<NonNullable<AgentChatItem['tool']>> = {}): AgentChatItem =>
  ({ id, kind: 'tool', time: 1, tool: { name: 'AskUserQuestion', summary: '', input: '', question: { questions: [color, fruits] }, ...extra } })
const approval = (question: string | null): AgentChatApproval => ({ question, detail: [], options: [], selected: null, signature: 's', usesTerminalInput: true })

describe('which question the card answers', () => {
  it('takes the latest AskUserQuestion while it has no answer', () => {
    const bash: AgentChatItem = { id: 'b', kind: 'tool', time: 1, tool: { name: 'Bash', summary: '', input: 'ls' } }
    expect(pendingAskItem([ask('old', { result: 'done' }), ask('new'), bash])?.id).toBe('new')
    expect(pendingAskItem([ask('new', { result: 'answered' })])).toBeNull()
    expect(pendingAskItem([ask('old'), ask('new', { isError: true })])).toBeNull()
  })

  it('answers it only while Claude’s dialog shows one of its questions (the top may be cut off)', () => {
    const items = [ask('q')]
    expect(answerableAskItem(items, approval('Which fruits?'))?.id).toBe('q')
    expect(answerableAskItem(items, approval('for the new theme?'))?.id).toBe('q')
    expect(answerableAskItem(items, approval(null))?.id).toBe('q')
    expect(answerableAskItem(items, approval('Something else?'))).toBeNull()
    expect(answerableAskItem(items, { ...approval('Which fruits?'), usesTerminalInput: false })).toBeNull()
    expect(answerableAskItem(items, null)).toBeNull()
  })
})

describe('the card’s choices', () => {
  it('replaces a single choice and toggles a checklist', () => {
    let draft = pick(color, emptyDraft(), 0)
    draft = pick(color, draft, 1)
    expect(answerOf(color, draft)).toEqual({ picks: [1], other: null })
    let list = pick(fruits, emptyDraft(), 2)
    list = pick(fruits, list, 0)
    list = pick(fruits, list, 2)
    expect(answerOf(fruits, list)).toEqual({ picks: [0], other: null })
  })

  it('takes a typed answer instead of a single choice, or with the checked ones', () => {
    let draft = toggleOther(color, pick(color, emptyDraft(), 0), true)
    expect(answerOf(color, draft)).toBeNull()
    draft = { ...draft, other: ' 보라 ' }
    expect(answerOf(color, draft)).toEqual({ picks: [], other: '보라' })
    const list = { ...toggleOther(fruits, pick(fruits, emptyDraft(), 1), true), other: '빨간사과' }
    expect(answerOf(fruits, list)).toEqual({ picks: [1], other: '빨간사과' })
    expect(answerText(fruits, list)).toBe('Banana, 빨간사과')
  })

  it('names what is wrong with a typed answer', () => {
    expect(otherProblem({ picks: [], otherOn: true, other: ' ' })).toContain('적어 주세요')
    expect(otherProblem({ picks: [], otherOn: true, other: 'a\nb' })).toContain('한 줄')
    expect(otherProblem({ picks: [], otherOn: true, other: 'x'.repeat(501) })).toContain('500자')
    expect(otherProblem({ picks: [], otherOn: false, other: '' })).toBeNull()
  })

  it('gives every answer only once all are complete', () => {
    expect(answersOf([color, fruits], [pick(color, emptyDraft(), 0)])).toBeNull()
    expect(answersOf([color, fruits], [pick(color, emptyDraft(), 0), emptyDraft()])).toBeNull()
    expect(answersOf([color, fruits], [pick(color, emptyDraft(), 0), pick(fruits, emptyDraft(), 1)])).toEqual([{ picks: [0], other: null }, { picks: [1], other: null }])
  })
})
