import { describe, expect, it } from 'vitest'
import { createAntigravityParser } from './antigravityTranscript.js'
import { completeLines } from './chats.js'
import { LIMITS } from './items.js'

const time = 1_700_000_000_000
const step = (step_index, source, type, fields) => ({
  step_index, source, type, status: 'DONE', created_at: new Date(time + step_index * 1000).toISOString(), ...fields
})
const user = (index, content, fields) => step(index, 'USER_EXPLICIT', 'USER_INPUT', { content, ...fields })
const model = (index, fields) => step(index, 'MODEL', 'PLANNER_RESPONSE', fields)

describe('Antigravity transcript parser', () => {
  it('extracts the user request and drops the adjacent SDK context', () => {
    const parser = createAntigravityParser()
    const wrapped = '<USER_REQUEST>\r\n  Review this mock project.\r\nKeep the details.\r\n</USER_REQUEST>\r\n\r\n' +
      '<ADDITIONAL_METADATA>\r\nprivate synthetic metadata\r\n</ADDITIONAL_METADATA>'
    expect(parser.feed(user(0, wrapped)).items).toEqual([
      { id: 'agy-user:0', kind: 'user', time, text: 'Review this mock project.\r\nKeep the details.' }
    ])
    expect(parser.feed(user(1, 'Show the literal <USER_REQUEST> tag.')).items[0].text).toBe('Show the literal <USER_REQUEST> tag.')
    expect(parser.feed(user(2, '<USER_REQUEST>Unfinished\n<ADDITIONAL_METADATA>hidden')).items).toEqual([])
  })

  it('preserves user text that quotes a closing tag and allows a completed envelope without metadata', () => {
    const parser = createAntigravityParser()
    expect(parser.feed(user(1, '<USER_REQUEST>\nExplain </USER_REQUEST> as text.\n</USER_REQUEST>')).items[0].text)
      .toBe('Explain </USER_REQUEST> as text.')
  })

  it('keeps only the image flag for attached media, including an image-only prompt', () => {
    const parser = createAntigravityParser()
    const media = [{ mime_type: 'image/png', uri: 'data:image/png;base64,ZmFrZQ==' }]
    expect(parser.feed(user(2, '', { media })).items).toEqual([
      { id: 'agy-user:2', kind: 'user', time: time + 2000, text: '', hasImage: true }
    ])
    expect(parser.feed(user(3, '', { media: [{ mime_type: 'audio/wav', uri: 'fake.wav' }] })).items).toEqual([])
  })

  it('renders thinking, answer and named tool calls with stable IDs and safe summaries', () => {
    const parser = createAntigravityParser()
    const items = parser.feed(model(4, {
      content: 'A sample answer.', thinking: 'Consider both fixtures.', tool_calls: [
        { name: 'view_file', args: { AbsolutePath: 'example.txt', Content: 'not forwarded' } },
        null,
        { name: 'run_command', args: { toolSummary: 'Inspect the fixture\nwithout editing it', CommandLine: 'echo fixture' } },
        { name: 'mock_tool', args: { secret: 'not forwarded' } }
      ]
    })).items
    expect(items).toEqual([
      { id: 'agy-thinking:4', kind: 'thinking', time: time + 4000, text: 'Consider both fixtures.' },
      { id: 'agy-assistant:4', kind: 'assistant', time: time + 4000, text: 'A sample answer.' },
      { id: 'tool:agy-4-0', kind: 'tool', time: time + 4000, tool: { name: 'view_file', summary: 'example.txt', input: '', result: '' } },
      { id: 'tool:agy-4-2', kind: 'tool', time: time + 4000, tool: { name: 'run_command', summary: 'Inspect the fixture without editing it', input: '', result: '' } },
      { id: 'tool:agy-4-3', kind: 'tool', time: time + 4000, tool: { name: 'mock_tool', summary: '', input: '', result: '' } }
    ])
    expect(parser.feed(model(5, { tool_calls: [{ name: 'read_file', args: { Path: 'second.txt' } }] })).items)
      .toMatchObject([{ id: 'tool:agy-5-0', kind: 'tool', tool: { summary: 'second.txt' } }])
  })

  it('ignores all other source/type pairs and malformed records', () => {
    const parser = createAntigravityParser()
    const hidden = { content: 'private synthetic text', thinking: 'hidden', input_tokens: 100, tool_calls: [{ name: 'fake' }] }
    for (const record of [null, [], 'bad', user(-1, 'invalid step'), model('1', hidden), model(1.5, hidden),
      step(2, 'SYSTEM_SDK', 'SYSTEM_MESSAGE', hidden), step(3, 'MODEL', 'GENERIC', hidden),
      step(4, 'MODEL', 'USER_INPUT', hidden), step(5, 'USER_EXPLICIT', 'PLANNER_RESPONSE', hidden),
      step(6, 'SYSTEM', 'ERROR_MESSAGE', hidden), step(7, 'SYSTEM', 'CHECKPOINT', hidden),
      model(8, { content: ' ', thinking: {}, tool_calls: [{ name: ' ' }, { args: 'bad' }, 4] })]) {
      expect(parser.feed(record).items).toEqual([])
    }
    expect(parser.feed({ ...user(9, 'Missing time'), created_at: 'invalid' }).items[0].time).toBeNull()
  })

  it('clips user, model, thought and tool labels with the existing limits', () => {
    const parser = createAntigravityParser()
    const long = 'a'.repeat(LIMITS.text + 1)
    expect(parser.feed(user(0, long)).items[0].text).toBe('a'.repeat(LIMITS.text) + '\n…')
    const [thought, answer, tool] = parser.feed(model(1, {
      thinking: 'b'.repeat(LIMITS.thinking + 1), content: long,
      tool_calls: [{ name: 'c'.repeat(LIMITS.summary + 1), args: { Path: 'd'.repeat(LIMITS.summary + 1) } }]
    })).items
    expect(thought.text).toBe('b'.repeat(LIMITS.thinking) + '\n…')
    expect(answer.text).toBe('a'.repeat(LIMITS.text) + '\n…')
    expect(tool.tool.name).toBe('c'.repeat(LIMITS.summary) + '…')
    expect(tool.tool.summary).toBe('d'.repeat(LIMITS.summary) + '…')
  })

  it('adds per-step token usage to the latest question and counts a re-read step once', () => {
    const parser = createAntigravityParser()
    parser.feed(user(0, 'What changed?'))
    const first = model(1, { input_tokens: 3, cache_read_tokens: 12, output_tokens: 4 })
    const second = model(2, { content: 'This sample changed.', input_tokens: 6, cache_read_tokens: 2, output_tokens: 5 })
    expect(parser.feed(first).items[0].usage).toEqual({ input: 15, cached: 12, output: 4, lastAt: time + 1000 })
    const [answer, owner] = parser.feed(second).items
    expect(answer.kind).toBe('assistant')
    expect(owner).toMatchObject({ id: 'agy-user:0', usage: { input: 23, cached: 14, output: 9, lastAt: time + 2000 } })
    expect(parser.feed(second).items[1]).toEqual(owner)

    parser.feed(user(3, 'What comes next?'))
    expect(parser.feed(model(4, { input_tokens: '6', cache_read_tokens: -2, output_tokens: 0 })).items).toEqual([])
    expect(parser.feed(model(5, { cache_read_tokens: 2, output_tokens: 1 })).items[0]).toMatchObject({
      id: 'agy-user:3', usage: { input: 2, cached: 2, output: 1 }
    })
  })

  it('attributes usage from a tail-only open to an earlier question once its page is loaded', () => {
    const parser = createAntigravityParser()
    const later = parser.feed(model(3, { content: 'Later answer.', input_tokens: 10, cache_read_tokens: 18, output_tokens: 3 }))
    expect(later.items.map(item => item.kind)).toEqual(['assistant'])

    parser.beginOlder()
    parser.feed(model(2, { input_tokens: 4 }), { older: true })
    expect(parser.endOlder()).toEqual([])
    parser.beginOlder()
    parser.feed(user(0, 'Earlier question.'), { older: true })
    parser.feed(model(1, { input_tokens: 2, output_tokens: 1 }), { older: true })
    expect(parser.endOlder()).toMatchObject([{ id: 'agy-user:0', usage: { input: 34, cached: 18, output: 4, lastAt: time + 3000 } }])
    expect(parser.feed(model(4, { output_tokens: 5 })).items[0]).toMatchObject({ id: 'agy-user:0', usage: { output: 9 } })
  })

  it('leaves live usage isolated from older pages and from a parser for a replacement file', () => {
    const parser = createAntigravityParser()
    parser.feed(user(4, 'The current question.'))
    parser.beginOlder()
    parser.feed(user(0, 'An earlier question.'), { older: true })
    parser.feed(model(1, { input_tokens: 9 }), { older: true })
    expect(parser.endOlder()).toMatchObject([{ id: 'agy-user:0', usage: { input: 9 } }])
    expect(parser.feed(model(5, { input_tokens: 4 })).items).toMatchObject([{ id: 'agy-user:4', usage: { input: 4 } }])

    const replacement = createAntigravityParser()
    expect(replacement.feed(model(1, { input_tokens: 3 })).items).toEqual([])
    expect(replacement.feed(user(2, 'The replacement question.')).items[0]).not.toHaveProperty('usage')
  })

  it('attributes leading usage across two older pages without changing the live turn', () => {
    const parser = createAntigravityParser()
    parser.feed(model(4, { input_tokens: 1, cache_read_tokens: 4, output_tokens: 2 }))
    parser.feed(user(5, 'Live question.'))
    parser.feed(model(6, { output_tokens: 5 }))

    parser.beginOlder()
    parser.feed(model(1, { input_tokens: 7 }), { older: true })
    parser.feed(user(2, 'Middle question.'), { older: true })
    parser.feed(model(3, { input_tokens: 3 }), { older: true })
    expect(parser.endOlder()).toMatchObject([{ id: 'agy-user:2', usage: { input: 8, cached: 4, output: 2 } }])

    parser.beginOlder()
    parser.feed(user(0, 'First question.'), { older: true })
    expect(parser.endOlder()).toMatchObject([{ id: 'agy-user:0', usage: { input: 7, cached: 0, output: 0 } }])
    expect(parser.feed(model(7, { output_tokens: 2 })).items).toMatchObject([
      { id: 'agy-user:5', usage: { input: 0, cached: 0, output: 7 } }
    ])
  })

  it('consumes a partial UTF-8 append once and resets usage for a shortened transcript', () => {
    const encode = (record) => Buffer.from(JSON.stringify(record) + '\n')
    const parser = createAntigravityParser()
    const first = encode(user(0, 'Original synthetic question.'))
    const replyText = '가짜 답변입니다.'
    const reply = encode(model(1, { content: replyText, input_tokens: 12, output_tokens: 3 }))
    const split = reply.indexOf(Buffer.from(replyText)) + 1
    const initialBytes = Buffer.concat([first, reply.subarray(0, split)])
    const initial = completeLines(initialBytes)
    expect(initial.used).toBe(first.length)
    expect(initial.lines.flatMap(line => parser.feed(line).items)).toMatchObject([{ id: 'agy-user:0' }])

    const appended = completeLines(Buffer.concat([initialBytes.subarray(initial.used), reply.subarray(split)]))
    expect(appended.used).toBe(reply.length)
    expect(appended.lines.flatMap(line => parser.feed(line).items)).toMatchObject([
      { id: 'agy-assistant:1', text: replyText },
      { id: 'agy-user:0', usage: { input: 12, cached: 0, output: 3 } }
    ])

    const shortened = completeLines(Buffer.concat([encode(user(0, 'New question.')), encode(model(1, { output_tokens: 1 }))]))
    expect(shortened.used).toBeLessThan(initial.used + appended.used)
    const replacement = createAntigravityParser()
    expect(shortened.lines.flatMap(line => replacement.feed(line).items)).toMatchObject([
      { id: 'agy-user:0', text: 'New question.' },
      { id: 'agy-user:0', text: 'New question.', usage: { input: 0, cached: 0, output: 1 } }
    ])
  })
})
