import { describe, it, expect } from 'vitest'
import { clampPaneHeight, parseLocalPanePrefs, visibleTerminalId, LOCAL_PANE_MIN_HEIGHT, SESSION_LIST_MIN_HEIGHT } from './localTerminalPane'

describe('clampPaneHeight', () => {
  it('keeps a dragged height that fits', () => {
    expect(clampPaneHeight(200, 600)).toBe(200)
  })

  it('never goes under one row or takes the minimum of the session list', () => {
    expect(clampPaneHeight(10, 600)).toBe(LOCAL_PANE_MIN_HEIGHT)
    expect(clampPaneHeight(5000, 600)).toBe(600 - SESSION_LIST_MIN_HEIGHT)
  })

  it('still returns the minimum in a list area too small for both', () => {
    expect(clampPaneHeight(300, 100)).toBe(LOCAL_PANE_MIN_HEIGHT)
    expect(clampPaneHeight(Number.NaN, 600)).toBe(LOCAL_PANE_MIN_HEIGHT)
  })
})

describe('parseLocalPanePrefs', () => {
  it('reads a stored height and collapsed state', () => {
    expect(parseLocalPanePrefs('{"height":180.4,"collapsed":true}')).toEqual({ height: 180, collapsed: true })
  })

  it('falls back to automatic height and open', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '{"height":"180"}', '{"height":-5}', '{"height":1e9}']) {
      expect(parseLocalPanePrefs(raw)).toEqual({ collapsed: false })
    }
  })
})

describe('visibleTerminalId', () => {
  const split = { mode: 'split', activePaneType: 'secondary' as const, primary: { activeTerminalId: 'a' }, secondary: { activeTerminalId: 'local:1' } }

  it('is the active tab on a single screen', () => {
    expect(visibleTerminalId({ ...split, mode: 'single', secondary: null, activePaneType: null }, 'x')).toBe('x')
  })

  it('is the tab of the focused pane on a split screen', () => {
    expect(visibleTerminalId(split, 'x')).toBe('local:1')
    expect(visibleTerminalId({ ...split, activePaneType: 'primary' }, 'x')).toBe('a')
    expect(visibleTerminalId({ ...split, activePaneType: null }, 'x')).toBe('a')
  })
})
