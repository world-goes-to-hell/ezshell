import { describe, expect, it } from 'vitest'
import { createClaudeParser } from './claudeTranscript.js'
import { createCodexParser } from './codexTranscript.js'
import { latestById } from './chats.js'
import { createLimitHistory } from './limitHistory.js'
import { limitsUsed } from './turnUsage.js'

// Lines shaped like this PC's transcripts (2026-11-21), contents replaced
const prompt = (uuid, text) => ({ type: 'user', uuid, timestamp: '2026-11-21T10:00:00Z', message: { role: 'user', content: text } })
const answer = (uuid, messageId, text, usage) => ({
  type: 'assistant', uuid, timestamp: '2026-11-21T10:00:01Z',
  message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }], usage }
})
const claudeUsage = (input, write, read, output) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output })
const duration = ms => ({ type: 'system', subtype: 'turn_duration', durationMs: ms, timestamp: '2026-11-21T10:00:09Z' })

function feed(parser, lines, older = false) {
  const items = []
  for (const line of lines) items.push(...parser.feed(line, { older }).items)
  return latestById(items)
}
const usageOf = (items, id) => {
  const usage = items.find(item => item.id === id)?.usage
  if (!usage) return usage
  const { lastAt, ...rest } = usage
  return rest
}

describe('the tokens of each question', () => {
  it('adds up a Claude turn, counting a message once although each of its blocks repeats the usage', () => {
    const items = feed(createClaudeParser(), [
      prompt('p1', '고쳐 줘'),
      answer('a1', 'm1', '보겠습니다', claudeUsage(2, 1000, 30000, 50)),
      answer('a2', 'm1', '이어서', claudeUsage(2, 1000, 30000, 50)),
      answer('a3', 'm2', '고쳤습니다', claudeUsage(1, 200, 31000, 400)),
      duration(9000),
      prompt('p2', '고마워'),
      answer('a4', 'm3', '네', claudeUsage(3, 0, 32000, 5))
    ])
    expect(usageOf(items, 'user:p1')).toEqual({ input: 62203, cached: 61000, output: 450, durationMs: 9000 })
    expect(usageOf(items, 'user:p2')).toEqual({ input: 32003, cached: 32000, output: 5 })
    // The question stays where it was asked
    expect(items[0].id).toBe('user:p1')
  })

  it('adds up a Codex turn from its token counts, an event repeated with the same total counted once', () => {
    const tokens = (total, input, cached, output, weekly = 16) => ({
      type: 'event_msg', timestamp: '2026-11-21T10:00:02Z',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } },
        rate_limits: { primary: { used_percent: weekly, window_minutes: 10080, resets_at: 1795567099 }, secondary: { used_percent: weekly * 2, window_minutes: 300, resets_at: 1795200000 } }
      }
    })
    const items = feed(createCodexParser(), [
      // The previous question's last call: the windows before this one
      tokens(500, 400, 300, 100, 15),
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { type: 'event_msg', timestamp: '2026-11-21T10:00:00Z', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: '봐 줘' }] } } },
      tokens(1000, 900, 800, 100),
      tokens(1000, 900, 800, 100),
      tokens(2100, 1000, 900, 100, 17),
      { type: 'event_msg', payload: { type: 'task_complete', duration_ms: 57783 } }
    ])
    // The weekly window went 15 → 17% and the 5-hour one 30 → 34% while it ran
    expect(usageOf(items, 'UserMessage:u1')).toEqual({
      input: 1900, cached: 1700, output: 200, durationMs: 57783,
      limits: { fiveHour: { before: 30, after: 34, used: 4 }, sevenDay: { before: 15, after: 17, used: 2 } }
    })
  })

  it('gives the lines that open what was read to the question found when scrolling up', () => {
    const parser = createClaudeParser()
    // The window starts inside a turn: its question is in the part before
    const first = feed(parser, [
      answer('a2', 'm2', '이어서', claudeUsage(0, 0, 100, 20)),
      duration(4000),
      prompt('p2', '다음'),
      answer('a3', 'm3', '네', claudeUsage(0, 0, 200, 7))
    ])
    expect(usageOf(first, 'user:p2')).toEqual({ input: 200, cached: 200, output: 7 })
    expect(first.some(item => item.id === 'user:p1')).toBe(false)

    parser.beginOlder()
    const older = feed(parser, [
      prompt('p1', '처음'),
      answer('a1', 'm1', '보겠습니다', claudeUsage(0, 0, 50, 10))
    ], true)
    older.push(...parser.endOlder())
    expect(usageOf(latestById(older), 'user:p1')).toEqual({ input: 150, cached: 150, output: 30, durationMs: 4000 })

    // Lines appended later still go to the latest question
    const more = feed(parser, [answer('a4', 'm4', '더', claudeUsage(0, 0, 300, 1))])
    expect(usageOf(more, 'user:p2')).toEqual({ input: 500, cached: 500, output: 8 })
  })

  it('makes the question found when scrolling up the owner of new lines when the window had none', () => {
    const parser = createClaudeParser()
    feed(parser, [answer('a2', 'm2', '긴 작업', claudeUsage(0, 0, 100, 20))])
    parser.beginOlder()
    feed(parser, [prompt('p1', '해 줘')], true)
    expect(usageOf(parser.endOlder(), 'user:p1')).toEqual({ input: 100, cached: 100, output: 20 })
    const more = feed(parser, [answer('a3', 'm3', '끝', claudeUsage(0, 0, 100, 5))])
    expect(usageOf(more, 'user:p1')).toEqual({ input: 200, cached: 200, output: 25 })
  })

  it('ignores numbers that are not counts', () => {
    const items = feed(createClaudeParser(), [
      prompt('p1', '해 줘'),
      answer('a1', 'm1', '네', { input_tokens: -5, cache_read_input_tokens: 'x', output_tokens: Infinity })
    ])
    expect(usageOf(items, 'user:p1')).toEqual({ input: 0, cached: 0, output: 0 })
  })

  it('preserves the readings across resets and small drops', () => {
    expect(limitsUsed(
      { fiveHour: { percent: 90, resetsAt: 1_000_000 }, sevenDay: { percent: 40, resetsAt: 1_000_000 } },
      { fiveHour: { percent: 3, resetsAt: 1_000_000 + 5 * 3600_000 }, sevenDay: { percent: 39.6, resetsAt: 1_000_020 } }
    )).toEqual({ fiveHour: { before: 90, after: 3, used: 3, reset: true }, sevenDay: { before: 40, after: 39.6, used: 0 } })
    expect(limitsUsed(
      { fiveHour: { percent: 40.25, resetsAt: null } },
      { fiveHour: { percent: 41.5, resetsAt: null }, sevenDay: { percent: 72, resetsAt: null } }
    )).toEqual({ fiveHour: { before: 40.25, after: 41.5, used: 1.3 } })
  })

  it('gives a Claude question the status line readings from before it started to after its last answer', () => {
    const history = createLimitHistory()
    const at = iso => Date.parse(iso)
    history.record({ fiveHour: { percent: 20, resetsAt: 9e12 }, sevenDay: { percent: 50, resetsAt: 9e12 } }, at('2026-11-21T09:59:00Z'))
    // Unchanged reports are not kept; a report without windows is skipped
    history.record({ fiveHour: { percent: 20, resetsAt: 9e12 }, sevenDay: { percent: 50, resetsAt: 9e12 } }, at('2026-11-21T09:59:30Z'))
    history.record({ fiveHour: null, sevenDay: null }, at('2026-11-21T10:00:01Z'))
    history.record({ fiveHour: { percent: 23, resetsAt: 9e12 }, sevenDay: { percent: 51, resetsAt: 9e12 } }, at('2026-11-21T10:00:04Z'))
    // A later question's use
    history.record({ fiveHour: { percent: 30, resetsAt: 9e12 }, sevenDay: { percent: 52, resetsAt: 9e12 } }, at('2026-11-21T10:05:00Z'))
    expect(history.between(at('2026-11-21T10:00:00Z'), at('2026-11-21T10:00:01Z') + 10_000)).toEqual({
      fiveHour: { before: 20, after: 23, used: 3 }, sevenDay: { before: 50, after: 51, used: 1 }
    })
    // Nothing read before the question: not known
    expect(history.between(at('2026-11-21T09:00:00Z'), at('2026-11-21T10:00:00Z'))).toBeUndefined()
  })
})
