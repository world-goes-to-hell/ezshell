import { describe, expect, it } from 'vitest'
import { AGENT_NEWLINE, agentNewlineFor } from './agentNewline'

const key = (extra: Partial<KeyboardEvent> = {}) => ({ key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...extra })

describe('agentNewlineFor', () => {
  it('sends ESC + Enter for Shift+Enter while an agent runs', () => {
    expect(agentNewlineFor(key(), () => true)).toBe(AGENT_NEWLINE)
    expect(AGENT_NEWLINE).toBe('\x1b\r')
  })

  it('leaves the key to xterm in a plain shell (ESC would clear the PowerShell line)', () => {
    expect(agentNewlineFor(key(), () => false)).toBeNull()
  })

  it('leaves plain Enter, other modifiers and input method composing alone', () => {
    expect(agentNewlineFor(key({ shiftKey: false }), () => true)).toBeNull()
    expect(agentNewlineFor(key({ ctrlKey: true }), () => true)).toBeNull()
    expect(agentNewlineFor(key({ altKey: true }), () => true)).toBeNull()
    expect(agentNewlineFor(key({ isComposing: true }), () => true)).toBeNull()
    expect(agentNewlineFor(key({ key: 'a' }), () => true)).toBeNull()
  })
})
