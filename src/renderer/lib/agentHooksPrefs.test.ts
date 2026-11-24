import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_HOOKS, parseAgentHooksPrefs } from './agentHooksPrefs'

describe('parseAgentHooksPrefs', () => {
  it('is on by default', () => {
    expect(DEFAULT_AGENT_HOOKS).toEqual({ enabled: true })
    expect(parseAgentHooksPrefs(null)).toEqual({ enabled: true })
  })

  it('reads a saved switch', () => {
    expect(parseAgentHooksPrefs('{"enabled":false}')).toEqual({ enabled: false })
    expect(parseAgentHooksPrefs('{"enabled":true,"extra":1}')).toEqual({ enabled: true })
  })

  it('falls back to the default on anything else', () => {
    for (const raw of ['', 'not json', 'null', '[]', '{"enabled":"no"}', '{"enabled":0}', '{}'])
      expect(parseAgentHooksPrefs(raw), raw).toEqual({ enabled: true })
  })
})
