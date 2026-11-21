import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_IDLE, minutesLabel, parseAgentIdlePrefs } from './agentIdlePrefs'

describe('the idle agent settings', () => {
  it('reads only the listed choices; giving back memory is on and sleeping off by default', () => {
    expect(DEFAULT_AGENT_IDLE).toEqual({ trimMinutes: 10, sleepMinutes: 0 })
    expect(parseAgentIdlePrefs(null)).toEqual(DEFAULT_AGENT_IDLE)
    expect(parseAgentIdlePrefs('{"trimMinutes":30,"sleepMinutes":60}')).toEqual({ trimMinutes: 30, sleepMinutes: 60 })
    expect(parseAgentIdlePrefs('{"trimMinutes":7,"sleepMinutes":"60"}')).toEqual(DEFAULT_AGENT_IDLE)
    expect(parseAgentIdlePrefs('not json')).toEqual(DEFAULT_AGENT_IDLE)
  })

  it('names the minutes', () => {
    expect(minutesLabel(15)).toBe('15분')
    expect(minutesLabel(60)).toBe('1시간')
    expect(minutesLabel(90)).toBe('1시간 30분')
  })
})
