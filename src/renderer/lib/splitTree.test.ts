import { describe, it, expect } from 'vitest'
import {
  singlePane, splitPane, closePane, swapPanes, vacatePane, mergeVacant, layoutOf, setRatio, equalize, equalizeAt,
  paneIds, leafCount, leafAt, nextPaneSeq, isSplitTree, mergePaneLayout, MAX_PANES, type SplitNode, type Rect
} from './splitTree'

const rectOf = (tree: SplitNode, pane: string): Rect | undefined => {
  const layout = layoutOf(tree)
  return [...layout.panes, ...layout.vacants].find(entry => entry.pane === pane)?.rect
}
const near = (rect: Rect | undefined, x: number, y: number, w: number, h: number) =>
  !!rect && [rect.x - x, rect.y - y, rect.w - w, rect.h - h].every(diff => Math.abs(diff) < 1e-9)

/** main | (a over b) */
const threePanes = () => splitPane(splitPane(singlePane(), 'main', 'row', 'a'), 'a', 'col', 'b')
/** (main | a) over (b | c): a 2x2 block made by splitting down first */
const quad = () => {
  let tree = splitPane(singlePane(), 'main', 'col', 'b')
  tree = splitPane(tree, 'main', 'row', 'a')
  return splitPane(tree, 'b', 'row', 'c')
}

describe('splitPane', () => {
  it('halves only the pane that was asked for', () => {
    const tree = threePanes()
    expect(paneIds(tree)).toEqual(['main', 'a', 'b'])
    expect(near(rectOf(tree, 'main'), 0, 0, 0.5, 1)).toBe(true)
    expect(near(rectOf(tree, 'a'), 0.5, 0, 0.5, 0.5)).toBe(true)
    expect(near(rectOf(tree, 'b'), 0.5, 0.5, 0.5, 0.5)).toBe(true)
  })

  it('puts the new pane to the right or below, and can split a split pane again', () => {
    let tree = splitPane(singlePane(), 'main', 'row', 'a')
    tree = splitPane(tree, 'a', 'row', 'b')
    // three side by side: a shape a 2x2 grid cannot hold
    expect(near(rectOf(tree, 'a'), 0.5, 0, 0.25, 1)).toBe(true)
    expect(near(rectOf(tree, 'b'), 0.75, 0, 0.25, 1)).toBe(true)
  })

  it('stops at the pane limit and ignores an id already in use', () => {
    let tree = singlePane()
    for (let i = 1; i < MAX_PANES; i++) tree = splitPane(tree, 'main', 'row', `p${i}`)
    expect(leafCount(tree)).toBe(MAX_PANES)
    expect(splitPane(tree, 'main', 'row', 'extra')).toBe(tree)
    const two = splitPane(singlePane(), 'main', 'row', 'a')
    expect(splitPane(two, 'main', 'col', 'a')).toBe(two)
  })
})

describe('closePane', () => {
  it('lets the part it was divided from take the place', () => {
    const tree = closePane(threePanes(), 'b')
    expect(paneIds(tree)).toEqual(['main', 'a'])
    expect(near(rectOf(tree, 'a'), 0.5, 0, 0.5, 1)).toBe(true)
    expect(near(rectOf(tree, 'main'), 0, 0, 0.5, 1)).toBe(true)
  })

  it('never closes the main terminal, and ends the split with the last other pane', () => {
    const two = splitPane(singlePane(), 'main', 'row', 'a')
    expect(closePane(two, 'main')).toBe(two)
    expect(isSplitTree(closePane(two, 'a'))).toBe(false)
  })
})

describe('mergePaneLayout', () => {
  const tee = () => splitPane(splitPane(singlePane(), 'main', 'row', 'right', 0.6), 'main', 'col', 'bottom', 0.4)

  it('widens the bottom pane into the large right pane and leaves its upper part vacant', () => {
    const plan = mergePaneLayout(tee(), 'bottom', 'right', 5)!
    expect(near(plan.expanded, 0, 0.4, 1, 0.6)).toBe(true)
    expect(near(rectOf(plan.tree, 'main'), 0, 0, 0.6, 0.4)).toBe(true)
    expect(near(rectOf(plan.tree, 'bottom'), 0, 0.4, 1, 0.6)).toBe(true)
    expect(paneIds(plan.tree)).toEqual(['main', 'bottom'])
    expect(layoutOf(plan.tree).vacants.map(entry => entry.pane)).toEqual(['split-6'])
    expect(near(rectOf(plan.tree, 'split-6'), 0.6, 0, 0.4, 0.4)).toBe(true)
    expect(near(rectOf(mergeVacant(plan.tree, 'split-6', 'row')!, 'main'), 0, 0, 1, 0.4)).toBe(true)
  })

  it('keeps the shell at the drag origin in either direction', () => {
    const plan = mergePaneLayout(tee(), 'right', 'bottom')!
    expect(paneIds(plan.tree)).toEqual(['main', 'right'])
    expect(near(rectOf(plan.tree, 'right'), 0, 0.4, 1, 0.6)).toBe(true)
  })

  it('combines panes across equal edges while declining diagonal targets', () => {
    const plan = mergePaneLayout(quad(), 'main', 'a')!
    expect(near(plan.expanded, 0, 0, 1, 0.5)).toBe(true)
    expect(layoutOf(plan.tree).vacants).toEqual([])
    expect(mergePaneLayout(quad(), 'main', 'c')).toBeNull()
  })
})

describe('swapPanes', () => {
  it('exchanges two panes without changing the shape', () => {
    const tree = swapPanes(threePanes(), 'main', 'b')
    expect(near(rectOf(tree, 'b'), 0, 0, 0.5, 1)).toBe(true)
    expect(near(rectOf(tree, 'main'), 0.5, 0.5, 0.5, 0.5)).toBe(true)
    expect(swapPanes(threePanes(), 'main', 'nope')).toEqual(threePanes())
  })
})

describe('vacatePane and mergeVacant (a shell moved out to a tab)', () => {
  it('leaves the place empty, keeps the others where they are', () => {
    const tree = vacatePane(quad(), 'a')
    expect(paneIds(tree)).toEqual(['main', 'b', 'c'])
    expect(layoutOf(tree).vacants.map(entry => entry.pane)).toEqual(['a'])
    expect(near(rectOf(tree, 'a'), 0.5, 0, 0.5, 0.5)).toBe(true)
    expect(leafCount(tree)).toBe(4)
    expect(vacatePane(quad(), 'main')).toEqual(quad())
  })

  it('merges sideways: the pane beside it grows', () => {
    const tree = mergeVacant(vacatePane(quad(), 'a'), 'a', 'row')!
    expect(near(rectOf(tree, 'main'), 0, 0, 1, 0.5)).toBe(true)
    expect(near(rectOf(tree, 'b'), 0, 0.5, 0.5, 0.5)).toBe(true)
    expect(near(rectOf(tree, 'c'), 0.5, 0.5, 0.5, 0.5)).toBe(true)
  })

  it('merges up or down in a 2x2 block: the pane below grows, the others keep their places', () => {
    const tree = mergeVacant(vacatePane(quad(), 'a'), 'a', 'col')!
    expect(near(rectOf(tree, 'c'), 0.5, 0, 0.5, 1)).toBe(true)
    expect(near(rectOf(tree, 'main'), 0, 0, 0.5, 0.5)).toBe(true)
    expect(near(rectOf(tree, 'b'), 0, 0.5, 0.5, 0.5)).toBe(true)
    expect(layoutOf(tree).vacants).toEqual([])
  })

  it('does the same for a block made by splitting sideways first', () => {
    // (main over b) | (a over c); c leaves, main's column neighbour is b, its row neighbour is a
    let tree = splitPane(singlePane(), 'main', 'row', 'a')
    tree = splitPane(tree, 'main', 'col', 'b')
    tree = splitPane(tree, 'a', 'col', 'c')
    const sideways = mergeVacant(vacatePane(tree, 'c'), 'c', 'row')!
    expect(near(rectOf(sideways, 'b'), 0, 0.5, 1, 0.5)).toBe(true)
    expect(near(rectOf(sideways, 'main'), 0, 0, 0.5, 0.5)).toBe(true)
    expect(near(rectOf(sideways, 'a'), 0.5, 0, 0.5, 0.5)).toBe(true)
    const upward = mergeVacant(vacatePane(tree, 'c'), 'c', 'col')!
    expect(near(rectOf(upward, 'a'), 0.5, 0, 0.5, 1)).toBe(true)
  })

  it('refuses a direction with no single neighbour', () => {
    // main | (a over b): b's only neighbour is a (above); nothing is beside it alone
    expect(mergeVacant(vacatePane(threePanes(), 'b'), 'b', 'row')).toBeNull()
    expect(mergeVacant(vacatePane(threePanes(), 'b'), 'b', 'col')).not.toBeNull()
    expect(mergeVacant(threePanes(), 'b', 'col')).toBeNull()
  })

  it('ends the split when the last other place is merged away', () => {
    const tree = mergeVacant(vacatePane(splitPane(singlePane(), 'main', 'row', 'a'), 'a'), 'a', 'row')!
    expect(isSplitTree(tree)).toBe(false)
  })
})

describe('layoutOf and setRatio', () => {
  it('lists one divider per division with the area it runs across', () => {
    const dividers = layoutOf(threePanes()).dividers
    expect(dividers.map(line => `${line.path}:${line.axis}`)).toEqual(['r:row', 'r1:col'])
    expect(near(dividers[1].region, 0.5, 0, 0.5, 1)).toBe(true)
  })

  it('moves one line and keeps it inside its limits', () => {
    const tree = setRatio(threePanes(), 'r1', 0.25)
    expect(near(rectOf(tree, 'a'), 0.5, 0, 0.5, 0.25)).toBe(true)
    expect(near(rectOf(tree, 'main'), 0, 0, 0.5, 1)).toBe(true)
    expect(near(rectOf(setRatio(threePanes(), 'r', 5), 'main'), 0, 0, 0.9, 1)).toBe(true)
  })

  it('finds the leaf under a point', () => {
    const layout = layoutOf(vacatePane(threePanes(), 'b'))
    expect(leafAt(layout, 0.1, 0.9)?.pane).toBe('main')
    expect(leafAt(layout, 0.9, 0.1)).toMatchObject({ pane: 'a', isVacant: false })
    expect(leafAt(layout, 0.9, 0.9)).toMatchObject({ pane: 'b', isVacant: true })
  })
})

describe('equalize', () => {
  it('gives three panes in a row a third each', () => {
    let tree = splitPane(singlePane(), 'main', 'row', 'a')
    tree = equalize(splitPane(tree, 'a', 'row', 'b'))
    for (const pane of ['main', 'a', 'b']) expect(Math.abs(rectOf(tree, pane)!.w - 1 / 3)).toBeLessThan(1e-9)
  })

  it('counts a stacked part as one column', () => {
    const tree = equalize(setRatio(setRatio(threePanes(), 'r', 0.8), 'r1', 0.2))
    expect(near(rectOf(tree, 'main'), 0, 0, 0.5, 1)).toBe(true)
    expect(near(rectOf(tree, 'a'), 0.5, 0, 0.5, 0.5)).toBe(true)
  })

  it('can even out one line only', () => {
    const moved = setRatio(setRatio(threePanes(), 'r', 0.8), 'r1', 0.2)
    const tree = equalizeAt(moved, 'r1')
    expect(near(rectOf(tree, 'main'), 0, 0, 0.8, 1)).toBe(true)
    expect(Math.abs(rectOf(tree, 'a')!.h - 0.5)).toBeLessThan(1e-9)
  })
})

describe('nextPaneSeq', () => {
  it('never reuses a number in the tab', () => {
    expect(nextPaneSeq(singlePane())).toBe(1)
    const tree = splitPane(splitPane(singlePane(), 'main', 'row', 'split-1'), 'main', 'col', 'split-2')
    expect(nextPaneSeq(tree)).toBe(3)
    expect(nextPaneSeq(closePane(tree, 'split-2'), 2)).toBe(3)
    expect(nextPaneSeq(vacatePane(tree, 'split-2'))).toBe(3)
  })
})
