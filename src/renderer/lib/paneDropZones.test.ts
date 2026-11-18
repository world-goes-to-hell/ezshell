import { describe, it, expect } from 'vitest'
import { zoneAt, halfOf, canHalve, insertBeside, movePaneBeside, axisOf, splitGestureLine } from './paneDropZones'
import { layoutOf, paneIds, type SplitNode } from './splitTree'

const pane = (id: string): SplitNode => ({ kind: 'pane', pane: id })
const row = (first: SplitNode, second: SplitNode): SplitNode => ({ kind: 'split', axis: 'row', ratio: 0.5, first, second })
const col = (first: SplitNode, second: SplitNode): SplitNode => ({ kind: 'split', axis: 'col', ratio: 0.5, first, second })
const box = { x: 100, y: 50, w: 400, h: 200 }
/** Where each pane ends up, rounded, as [x, y, w, h] in shares of the area */
const places = (tree: SplitNode) => Object.fromEntries(layoutOf(tree).panes.map(({ pane: id, rect }) => [id, [rect.x, rect.y, rect.w, rect.h].map(n => Math.round(n * 100) / 100)]))

describe('splitGestureLine', () => {
  it('uses the stroke direction and where it was drawn', () => {
    expect(splitGestureLine(box, { x: 290, y: 70 }, { x: 310, y: 220 })).toEqual({ axis: 'row', ratio: 0.5 })
    expect(splitGestureLine({ ...box, h: 400 }, { x: 430, y: 290 }, { x: 120, y: 290 })).toEqual({ axis: 'col', ratio: 0.6 })
  })

  it('discards short strokes, diagonals and cuts too close to an edge', () => {
    expect(splitGestureLine(box, { x: 300, y: 150 }, { x: 300, y: 160 })).toBeNull()
    expect(splitGestureLine(box, { x: 220, y: 70 }, { x: 370, y: 220 })).toBeNull()
    expect(splitGestureLine(box, { x: 180, y: 70 }, { x: 180, y: 220 })).toBeNull()
  })
})

describe('zoneAt', () => {
  it('gives the side nearest the pointer (the pane cut along its diagonals)', () => {
    expect(zoneAt(box, 110, 150, false)).toBe('left')
    expect(zoneAt(box, 490, 150, false)).toBe('right')
    expect(zoneAt(box, 300, 55, false)).toBe('top')
    expect(zoneAt(box, 300, 245, false)).toBe('bottom')
    // Near the top-left corner, but nearer the top edge in proportion
    expect(zoneAt(box, 150, 60, false)).toBe('top')
  })

  it('has a middle part only when asked (moving a pane: swap)', () => {
    expect(zoneAt(box, 300, 150, true)).toBe('center')
    expect(zoneAt(box, 300, 150, false)).toBe('right')
    expect(zoneAt(box, 130, 150, true)).toBe('left')
  })
})

describe('halfOf and canHalve', () => {
  it('is the half the new pane takes', () => {
    expect(halfOf(box, 'left')).toEqual({ x: 100, y: 50, w: 200, h: 200 })
    expect(halfOf(box, 'right')).toEqual({ x: 300, y: 50, w: 200, h: 200 })
    expect(halfOf(box, 'top')).toEqual({ x: 100, y: 50, w: 400, h: 100 })
    expect(halfOf(box, 'bottom')).toEqual({ x: 100, y: 150, w: 400, h: 100 })
  })

  it('refuses a half too small for a terminal', () => {
    expect(canHalve(400, 150, 'left')).toBe(true)
    expect(canHalve(400, 150, 'top')).toBe(false)
    expect(canHalve(300, 400, 'right')).toBe(false)
    expect(axisOf('bottom')).toBe('col')
  })
})

describe('insertBeside', () => {
  it('halves the pane on the chosen side', () => {
    expect(places(insertBeside(pane('main'), 'main', 'left', 'split-1'))).toEqual({ 'split-1': [0, 0, 0.5, 1], main: [0.5, 0, 0.5, 1] })
    expect(places(insertBeside(pane('main'), 'main', 'bottom', 'split-1'))).toEqual({ main: [0, 0, 1, 0.5], 'split-1': [0, 0.5, 1, 0.5] })
  })

  it('touches only that pane', () => {
    const tree = row(pane('main'), pane('split-1'))
    expect(places(insertBeside(tree, 'split-1', 'top', 'split-2'))).toEqual({ main: [0, 0, 0.5, 1], 'split-2': [0.5, 0, 0.5, 0.5], 'split-1': [0.5, 0.5, 0.5, 0.5] })
  })

  it('leaves the tree alone when full, when the id is taken or the pane is missing', () => {
    const six = row(row(pane('main'), pane('a')), row(row(pane('b'), pane('c')), row(pane('d'), pane('e'))))
    expect(insertBeside(six, 'main', 'left', 'f')).toBe(six)
    const two = row(pane('main'), pane('a'))
    expect(insertBeside(two, 'main', 'left', 'a')).toBe(two)
    expect(insertBeside(two, 'nope', 'left', 'b')).toBe(two)
  })
})

describe('movePaneBeside', () => {
  it('moves a pane next to another one, keeping its id', () => {
    // main | (a over b)  ->  b goes to the left of main: b | main | a
    const tree = row(pane('main'), col(pane('a'), pane('b')))
    const moved = movePaneBeside(tree, 'b', 'main', 'left')
    expect(paneIds(moved).sort()).toEqual(['a', 'b', 'main'])
    expect(places(moved)).toEqual({ b: [0, 0, 0.25, 1], main: [0.25, 0, 0.25, 1], a: [0.5, 0, 0.5, 1] })
  })

  it('turns a side-by-side pair into a stacked one', () => {
    expect(places(movePaneBeside(row(pane('main'), pane('a')), 'a', 'main', 'bottom'))).toEqual({ main: [0, 0, 1, 0.5], a: [0, 0.5, 1, 0.5] })
    expect(places(movePaneBeside(row(pane('main'), pane('a')), 'main', 'a', 'top'))).toEqual({ main: [0, 0, 1, 0.5], a: [0, 0.5, 1, 0.5] })
  })

  it('can move the tab\'s first pane too', () => {
    const moved = movePaneBeside(row(pane('main'), pane('a')), 'main', 'a', 'right')
    expect(places(moved)).toEqual({ a: [0, 0, 0.5, 1], main: [0.5, 0, 0.5, 1] })
  })

  it('does nothing onto itself or with a missing pane', () => {
    const tree = row(pane('main'), pane('a'))
    expect(movePaneBeside(tree, 'a', 'a', 'left')).toBe(tree)
    expect(movePaneBeside(tree, 'x', 'a', 'left')).toBe(tree)
    expect(movePaneBeside(tree, 'a', 'x', 'left')).toBe(tree)
  })
})
