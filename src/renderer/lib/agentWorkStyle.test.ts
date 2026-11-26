import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_WORK_STYLES, AGENT_WORK_STYLE_KEY, DEFAULT_AGENT_WORK_STYLE, applyAgentWorkStyle, getAgentWorkStyle, parseAgentWorkStyle, setAgentWorkStyle } from './agentWorkStyle'

// The tests run in Node: the little of a page this module touches
beforeEach(() => {
  const items = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, String(value)) } })
  vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string> } })
  vi.stubGlobal('window', { dispatchEvent: vi.fn(), addEventListener: vi.fn() })
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init?: unknown) {} })
})
afterEach(() => vi.unstubAllGlobals())

describe('agent work indicator style', () => {
  it('offers the four styles, lightest first by default, each telling its CPU cost', () => {
    expect(AGENT_WORK_STYLES.map(style => style.id)).toEqual(['glow', 'pulse', 'trace', 'static'])
    expect(DEFAULT_AGENT_WORK_STYLE).toBe('glow')
    for (const style of AGENT_WORK_STYLES) expect(style.cpu).toMatch(/CPU/)
  })

  it('reads only a known style, else the default', () => {
    expect(parseAgentWorkStyle('trace')).toBe('trace')
    for (const raw of [null, '', 'rainbow', '{"x":1}']) expect(parseAgentWorkStyle(raw)).toBe('glow')
  })

  it('keeps the choice and puts it on the page for the stylesheet', () => {
    expect(getAgentWorkStyle()).toBe('glow')
    setAgentWorkStyle('pulse')
    expect(localStorage.getItem(AGENT_WORK_STYLE_KEY)).toBe('pulse')
    expect(document.documentElement.dataset.agentWorkStyle).toBe('pulse')
    delete document.documentElement.dataset.agentWorkStyle
    applyAgentWorkStyle()
    expect(document.documentElement.dataset.agentWorkStyle).toBe('pulse')
    localStorage.setItem(AGENT_WORK_STYLE_KEY, 'unknown')
    applyAgentWorkStyle()
    expect(document.documentElement.dataset.agentWorkStyle).toBe('glow')
  })
})
