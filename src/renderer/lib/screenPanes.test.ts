import { describe, expect, it } from 'vitest'
import { MAX_SCREENS, MIN_SHARE, addScreen, addScreenRefusal, buildScreens, dragDivider, paneIndex, screensOf, type ScreenPane } from './screenPanes'

const pane = (ids: string[], active?: string): ScreenPane => ({ terminalIds: ids, activeTerminalId: active ?? ids[0] ?? null })
const close = (values: number[]) => values.map(value => Math.round(value * 1000) / 1000)

describe('buildScreens', () => {
  it('keeps two to four screens with the first two as primary and secondary', () => {
    const layout = buildScreens({ panes: [pane(['a']), pane(['b']), pane(['c'])], activePane: 2, direction: 'horizontal' })
    expect(layout.mode).toBe('split')
    expect(layout.panes.map(p => p.terminalIds)).toEqual([['a'], ['b'], ['c']])
    expect(close(layout.sizes)).toEqual([0.333, 0.333, 0.333])
    expect(layout.activePane).toBe(2)
    expect(layout.primary.terminalIds).toEqual(['a'])
    expect(layout.secondary?.terminalIds).toEqual(['b'])
    expect(layout.activePaneType).toBe('secondary')
  })

  it('drops an empty screen, giving its share to the others and its focus to a neighbour', () => {
    const layout = buildScreens({ panes: [pane(['a']), pane([]), pane(['c'])], sizes: [0.5, 0.25, 0.25], activePane: 1 })
    expect(layout.panes.map(p => p.terminalIds)).toEqual([['a'], ['c']])
    expect(close(layout.sizes)).toEqual([0.667, 0.333])
    expect(layout.activePane).toBe(0)
  })

  it('becomes the single screen when one screen is left', () => {
    const layout = buildScreens({ panes: [pane([]), pane(['b', 'c'], 'c')] })
    expect(layout).toMatchObject({ mode: 'single', panes: [{ terminalIds: ['b', 'c'], activeTerminalId: 'c' }], secondary: null, activePane: null, activePaneType: null })
  })

  it('never loses a tab: tabs in no screen join the first, closed tabs leave', () => {
    const layout = buildScreens({ panes: [pane(['a']), pane(['b', 'gone'])], allIds: ['a', 'b', 'new'] })
    expect(layout.panes.map(p => p.terminalIds)).toEqual([['a', 'new'], ['b']])
  })

  it('keeps a tab in one screen only', () => {
    expect(buildScreens({ panes: [pane(['a', 'b']), pane(['b', 'c'])] }).panes.map(p => p.terminalIds)).toEqual([['a', 'b'], ['c']])
  })
})

describe('adding screens', () => {
  const two = buildScreens({ panes: [pane(['a', 'b']), pane(['c'])], direction: 'horizontal' })

  it('splits a single screen in two', () => {
    const single = buildScreens({ panes: [pane(['a', 'b'])] })
    expect(addScreen(single, 'b', 'end', 'vertical')).toEqual({ panes: [pane(['a']), pane(['b'])], sizes: [0.5, 0.5], activePane: 1 })
  })

  it('adds a third screen at either end, taking the tab out of its screen', () => {
    const end = addScreen(two, 'b', 'end', 'horizontal')
    expect(end?.panes.map(p => p.terminalIds)).toEqual([['a'], ['c'], ['b']])
    expect(close(end!.sizes)).toEqual([0.333, 0.333, 0.333])
    expect(end?.activePane).toBe(2)
    expect(addScreen(two, 'b', 'start', 'horizontal')?.panes.map(p => p.terminalIds)).toEqual([['b'], ['a'], ['c']])
  })

  it('refuses a fifth screen and the other direction, with the reason', () => {
    const four = buildScreens({ panes: [pane(['a']), pane(['b']), pane(['c']), pane(['d'])], direction: 'horizontal' })
    expect(four.panes).toHaveLength(MAX_SCREENS)
    expect(addScreen(four, 'a', 'end', 'horizontal')).toBeNull()
    expect(addScreenRefusal(four, 'horizontal')).toContain('4개까지')
    expect(addScreen(two, 'b', 'end', 'vertical')).toBeNull()
    expect(addScreenRefusal(two, 'vertical')).toContain('왼쪽·오른쪽')
    expect(addScreenRefusal(two, 'horizontal')).toBeNull()
  })
})

describe('dragDivider', () => {
  it('moves only the two neighbours and keeps each above the minimum', () => {
    expect(close(dragDivider([0.25, 0.25, 0.5], 0, 0.1))).toEqual([0.12, 0.38, 0.5])
    expect(close(dragDivider([0.25, 0.25, 0.5], 1, 0.6))).toEqual([0.25, 0.35, 0.4])
    expect(close(dragDivider([0.5, 0.5], 0, 0.99))).toEqual([1 - MIN_SHARE, MIN_SHARE].map(v => Math.round(v * 1000) / 1000))
  })
})

describe('old names and layouts', () => {
  it('reads primary and secondary as the first two screens', () => {
    expect([paneIndex('primary'), paneIndex('secondary'), paneIndex(3)]).toEqual([0, 1, 3])
    expect(screensOf({ mode: 'split', primary: pane(['a']), secondary: pane(['b']) }).map(p => p.terminalIds)).toEqual([['a'], ['b']])
    expect(screensOf({ mode: 'single', primary: pane(['a']), secondary: null }).map(p => p.terminalIds)).toEqual([['a']])
  })
})
