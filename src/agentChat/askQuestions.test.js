import { describe, expect, it } from 'vitest'
import { askQuestionsOf, askAnswersOf, cleanAnswer } from './askQuestions.js'
import { createClaudeParser } from './claudeTranscript.js'

// The input and result shapes of Claude Code's AskUserQuestion (this PC's transcripts, 2026-11-23)
const input = {
  questions: [
    { question: 'Which fruits?', header: 'Fruits', multiSelect: true, options: [{ label: 'Apple', description: 'red' }, { label: 'Banana', description: 'yellow' }, { label: 'Cherry', description: 'small' }] },
    { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Green', description: 'calm' }] }
  ]
}

describe('AskUserQuestion input and answers', () => {
  it('keeps the questions, headers, choices and whether several can be picked', () => {
    const { questions } = askQuestionsOf(input)
    expect(questions).toHaveLength(2)
    expect(questions[0]).toEqual({ question: 'Which fruits?', header: 'Fruits', multiSelect: true, options: input.questions[0].options })
    expect(questions[1].multiSelect).toBe(false)
  })

  it('gives up on an input it cannot draw', () => {
    expect(askQuestionsOf(null)).toBeNull()
    expect(askQuestionsOf({ questions: [] })).toBeNull()
    expect(askQuestionsOf({ questions: [{ question: 'Q', options: [] }] })).toBeNull()
    expect(askQuestionsOf({ questions: [{ question: 'Q', options: [{ label: '' }] }] })).toBeNull()
    expect(askQuestionsOf({ questions: Array.from({ length: 7 }, () => input.questions[1]) })).toBeNull()
  })

  it('reads the answers by question, null for one left unanswered', () => {
    const { questions } = askQuestionsOf(input)
    expect(askAnswersOf({ answers: { 'Which fruits?': 'Apple, Cherry' } }, questions)).toEqual(['Apple, Cherry', null])
    expect(askAnswersOf(undefined, questions)).toBeUndefined()
  })

  it('accepts one choice or a typed answer for a single choice, one or more for a checklist', () => {
    const [fruits, color] = askQuestionsOf(input).questions
    expect(cleanAnswer(color, { picks: [1] })).toEqual({ picks: [1], other: null })
    expect(cleanAnswer(color, { picks: [], other: ' 보라 ' })).toEqual({ picks: [], other: '보라' })
    expect(cleanAnswer(color, { picks: [0, 1] })).toBeNull()
    expect(cleanAnswer(color, { picks: [] })).toBeNull()
    expect(cleanAnswer(fruits, { picks: [2, 0], other: '빨간사과' })).toEqual({ picks: [0, 2], other: '빨간사과' })
    expect(cleanAnswer(fruits, { picks: [3] })).toBeNull()
    expect(cleanAnswer(fruits, { picks: [0, 0] })).toBeNull()
    expect(cleanAnswer(fruits, { picks: [1.5] })).toBeNull()
  })

  it('refuses a typed answer with keys or line breaks in it', () => {
    const [, color] = askQuestionsOf(input).questions
    for (const other of ['a\rb', 'a\nb', 'a\x1b[B', 'a\u2028b', 'x'.repeat(501), 3]) {
      expect(cleanAnswer(color, { picks: [], other })).toBeNull()
    }
  })
})

describe('AskUserQuestion in the transcript parser', () => {
  const ask = { type: 'assistant', uuid: 'a1', timestamp: '2026-11-23T01:00:00Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input }] } }
  const answered = {
    type: 'user', uuid: 'u1', timestamp: '2026-11-23T01:01:00Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'Your questions have been answered' }] },
    toolUseResult: { questions: input.questions, answers: { 'Which fruits?': 'Apple, Cherry', 'Which color?': 'Green' } }
  }

  it('puts the questions on the tool item instead of its JSON input, and the parser hands them back until answered', () => {
    const parser = createClaudeParser()
    const [item] = parser.feed(ask).items
    expect(item.tool.input).toBe('')
    expect(item.tool.question.questions.map(question => question.header)).toEqual(['Fruits', 'Color'])
    expect(parser.question('tool:toolu_q')).toBe(item.tool.question)
    expect(parser.question('tool:other')).toBeNull()

    const [after] = parser.feed(answered).items
    expect(after.tool.answers).toEqual(['Apple, Cherry', 'Green'])
    expect(parser.question('tool:toolu_q')).toBeNull()
  })

  it('pairs answers read before their question (reading older parts goes backwards)', () => {
    const parser = createClaudeParser()
    expect(parser.feed(answered).items).toEqual([])
    const [item] = parser.feed(ask).items
    expect(item.tool.answers).toEqual(['Apple, Cherry', 'Green'])
  })
})
