import { describe, expect, it } from 'vitest'
import type { AgentUsage } from '../types'
import { timeLeft, usageLevel, usageSummary } from './agentUsageView'

const NOW = new Date(2026, 10, 19, 12, 0).getTime()
const usage = (over: Partial<AgentUsage> = {}): AgentUsage => ({ agent: 'claude', model: 'Opus 5.5', effort: 'high', sessionId: null, context: { percent: 38, size: 1000000 }, fiveHour: { percent: 23, resetsAt: NOW + 130 * 60_000 }, sevenDay: { percent: 41, resetsAt: NOW + 76 * 3600_000 }, ...over })

describe('usageLevel', () => {
  it('turns yellow at 70 and red at 90', () => {
    expect([69.9, 70, 89.9, 90].map(usageLevel)).toEqual(['ok', 'warn', 'warn', 'high'])
  })
})

describe('timeLeft', () => {
  it('reads minutes, hours and days', () => {
    expect(timeLeft(NOW + 45 * 60_000, NOW)).toBe('45m')
    expect(timeLeft(NOW + 130 * 60_000, NOW)).toBe('2h10m')
    expect(timeLeft(NOW + 76 * 3600_000, NOW)).toBe('3d4h')
    expect(timeLeft(NOW - 1000, NOW)).toBeNull()
    expect(timeLeft(null, NOW)).toBeNull()
  })
})

describe('usageSummary', () => {
  it('says what each number is', () => {
    expect(usageSummary(usage(), NOW)).toBe('Opus 5.5 (effort high) · 5시간 23% 사용, 2h10m 뒤 초기화 · 7일 41% 사용, 3d4h 뒤 초기화 · 컨텍스트 38%')
    expect(usageSummary(usage({ model: null, effort: null, agent: 'codex', fiveHour: null, sevenDay: null, context: null }), NOW)).toBe('Codex')
  })
})
