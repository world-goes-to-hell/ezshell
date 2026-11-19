import { describe, expect, it } from 'vitest'
import { claudeUsageFromStatus, codexUsageFromTokenCount, sanitizeUsage, sameUsage } from './agentUsage.js'

describe('claudeUsageFromStatus', () => {
  it('takes the model, the context and the two subscription windows', () => {
    expect(claudeUsageFromStatus({
      model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
      effort: { level: 'high' },
      session_id: 'abcdef12-1111-4222-8333-444455556666',
      context_window: { used_percentage: 38.4, context_window_size: 1000000 },
      rate_limits: { five_hour: { used_percentage: 23, resets_at: 1795000000 }, seven_day: { used_percentage: 41.2, resets_at: 1795400000 } },
      transcript_path: 'C:\\secret\\path.jsonl', cwd: 'D:\\work'
    })).toEqual({
      agent: 'claude', model: 'Opus 5.5', effort: 'high', sessionId: 'abcdef12-1111-4222-8333-444455556666',
      context: { percent: 38.4, size: 1000000 },
      fiveHour: { percent: 23, resetsAt: 1795000000000 },
      sevenDay: { percent: 41.2, resetsAt: 1795400000000 }
    })
  })

  it('leaves out what is missing (no limits before the first answer, or for API key users)', () => {
    expect(claudeUsageFromStatus({ model: { id: 'x' } })).toEqual({ agent: 'claude', model: 'x', effort: null, sessionId: null, context: null, fiveHour: null, sevenDay: null })
    expect(claudeUsageFromStatus(null)).toBeNull()
    expect(claudeUsageFromStatus('nope')).toBeNull()
  })
})

describe('codexUsageFromTokenCount', () => {
  const payload = {
    type: 'token_count',
    info: { last_token_usage: { total_tokens: 64000 }, model_context_window: 256000 },
    rate_limits: {
      primary: { used_percent: 12, window_minutes: 300, resets_at: 1795000000 },
      secondary: { used_percent: 55, window_minutes: 10080, resets_at: 1795400000 }
    }
  }

  it('reads the windows by their length and the context from the last turn', () => {
    expect(codexUsageFromTokenCount(payload, 'gpt-6', 'xhigh', '01a1ec18-9b8a-71c1-839d-2e31c010300f')).toEqual({
      agent: 'codex', model: 'gpt-6', effort: 'xhigh', sessionId: '01a1ec18-9b8a-71c1-839d-2e31c010300f',
      context: { percent: 25, size: 256000 },
      fiveHour: { percent: 12, resetsAt: 1795000000000 },
      sevenDay: { percent: 55, resetsAt: 1795400000000 }
    })
  })

  it('puts a weekly window that comes first in its place', () => {
    const swapped = { ...payload, rate_limits: { primary: payload.rate_limits.secondary, secondary: null } }
    expect(codexUsageFromTokenCount(swapped, null)).toMatchObject({ fiveHour: null, sevenDay: { percent: 55 } })
  })
})

describe('sanitizeUsage', () => {
  it('keeps only known fields with sane numbers', () => {
    expect(sanitizeUsage({
      agent: 'claude', model: 'M'.repeat(200), effort: 'way too long or <b>odd</b>', sessionId: '../../etc', extra: 'drop me',
      context: { percent: 140, size: -1 }, fiveHour: { percent: 'x', resetsAt: 1 }, sevenDay: { percent: 10, resetsAt: 1795400000000 }
    }, 'claude')).toEqual({
      agent: 'claude', model: 'M'.repeat(60), effort: null, sessionId: null,
      context: { percent: 100, size: null }, fiveHour: null, sevenDay: { percent: 10, resetsAt: 1795400000000 }
    })
  })

  it('keeps a plain effort word', () => {
    expect(sanitizeUsage({ agent: 'codex', effort: 'xhigh', sessionId: '01A1EC18-9B8A-71C1-839D-2E31C010300F' }, 'codex')).toMatchObject({ effort: 'xhigh', sessionId: '01a1ec18-9b8a-71c1-839d-2e31c010300f' })
  })

  it('refuses a report for another kind of agent', () => {
    expect(sanitizeUsage({ agent: 'codex' }, 'claude')).toBeNull()
  })
})

describe('sameUsage', () => {
  it('compares the values, not the objects', () => {
    const a = { agent: 'claude', model: 'x', effort: 'low', context: { percent: 1, size: 2 }, fiveHour: null, sevenDay: null }
    expect(sameUsage(a, JSON.parse(JSON.stringify(a)))).toBe(true)
    expect(sameUsage(a, { ...a, context: { percent: 2, size: 2 } })).toBe(false)
  })
})
