import { describe, expect, it } from 'vitest'
import type { AgentChatItem } from '../types'
import { limitStep, tokenCount, turnUsageSpots, turnUsageText } from './agentTurnUsage'

const item = (id: string, kind: AgentChatItem['kind'], usage?: AgentChatItem['usage']): AgentChatItem => ({ id, kind, time: null, text: id, ...(usage ? { usage } : {}) })

describe('the tokens of each question in the chat view', () => {
  it('goes after the last item of each turn that has usage', () => {
    const first = { input: 10, cached: 0, output: 1 }
    const last = { input: 20, cached: 0, output: 2 }
    const spots = turnUsageSpots([
      item('n', 'notice'),
      item('u1', 'user', first), item('a1', 'assistant'), item('t1', 'tool'),
      item('u2', 'user'), item('a2', 'assistant'),
      item('u3', 'user', last)
    ])
    expect([...spots]).toEqual([['t1', first], ['u3', last]])
  })

  it('reads as a short line with the exact numbers in its tooltip', () => {
    expect(tokenCount(3412)).toBe('3,412')
    expect(tokenCount(123456)).toBe('12.3만')
    expect(tokenCount(30000)).toBe('3만')
    expect(tokenCount(1234567)).toBe('123만')
    const line = turnUsageText({ input: 123456, cached: 120987, output: 3412, durationMs: 192400 })
    expect(line.text).toBe('토큰 입력 12.3만 · 출력 3,412 · 캐시 98% · 3분 12초')
    expect(line.title).toContain('입력 123,456 (캐시에서 읽음 120,987)')
    expect(turnUsageText({ input: 0, cached: 0, output: 0 }).text).toBe('토큰 입력 0 · 출력 0')
    const limited = turnUsageText({ input: 100, cached: 0, output: 5, limits: { fiveHour: 2, sevenDay: 0 } })
    expect(limited.text).toBe('토큰 입력 100 · 출력 5 · 5시간 +2% · 주간 <1%')
    expect(limited.title).toContain('다른 세션')
    expect(limitStep(0.4)).toBe('+0.4%')
    expect(limitStep(1.25)).toBe('+1.3%')
  })
})
