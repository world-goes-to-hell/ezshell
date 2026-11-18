// Where something dragged onto a pane goes: the pane is cut along its diagonals into four parts
// (the side nearest the pointer gets the new pane), with a middle part for panes being moved
// (dropped there, the two panes trade places).

import { MAX_PANES, MIN_RATIO, MAX_RATIO, leafCount, paneIds, type PaneId, type SplitAxis, type SplitNode } from './splitTree'

export type DropSide = 'left' | 'right' | 'top' | 'bottom'
export type DropZone = DropSide | 'center'

export interface Box { x: number; y: number; w: number; h: number }

/** The middle part (for moving a pane: swap) is this share of the pane on each axis */
const CENTER_SHARE = 0.4
/** A half of a divided pane must still be usable as a terminal */
export const MIN_HALF_WIDTH_PX = 180
export const MIN_HALF_HEIGHT_PX = 100

/**
 * The part of `box` under the point. Without `withCenter` every point belongs to a side.
 * A point exactly in the middle goes to the right (then the bottom): new panes went there before.
 */
export function zoneAt(box: Box, px: number, py: number, withCenter: boolean): DropZone {
  const nx = box.w > 0 ? (px - box.x) / box.w : 0.5
  const ny = box.h > 0 ? (py - box.y) / box.h : 0.5
  const low = (1 - CENTER_SHARE) / 2
  if (withCenter && nx >= low && nx <= 1 - low && ny >= low && ny <= 1 - low) return 'center'
  const distances: Array<[DropSide, number]> = [['right', 1 - nx], ['bottom', 1 - ny], ['left', nx], ['top', ny]]
  return distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))[0]
}

export const axisOf = (side: DropSide): SplitAxis => (side === 'left' || side === 'right' ? 'row' : 'col')

/** The half of `box` the new pane will take */
export function halfOf(box: Box, side: DropSide): Box {
  switch (side) {
    case 'left': return { ...box, w: box.w / 2 }
    case 'right': return { ...box, x: box.x + box.w / 2, w: box.w / 2 }
    case 'top': return { ...box, h: box.h / 2 }
    case 'bottom': return { ...box, y: box.y + box.h / 2, h: box.h / 2 }
  }
}

/** Whether a pane of this size (in pixels) can be halved on that side */
export function canHalve(width: number, height: number, side: DropSide): boolean {
  return axisOf(side) === 'row' ? width / 2 >= MIN_HALF_WIDTH_PX : height / 2 >= MIN_HALF_HEIGHT_PX
}

interface Point { x: number; y: number }

/** A stroke inside a pane marks a divider. Diagonals and short strokes leave the pane alone. */
export function splitGestureLine(box: Box, start: Point, end: Point): { axis: SplitAxis; ratio: number } | null {
  const dx = Math.abs(end.x - start.x)
  const dy = Math.abs(end.y - start.y)
  if (Math.max(dx, dy) < 36 || Math.min(dx, dy) * 1.25 > Math.max(dx, dy)) return null
  const vertical = dy > dx
  const dimension = vertical ? box.w : box.h
  const position = vertical ? (start.x + end.x) / 2 - box.x : (start.y + end.y) / 2 - box.y
  const min = vertical ? MIN_HALF_WIDTH_PX : MIN_HALF_HEIGHT_PX
  const ratio = position / dimension
  if (ratio < MIN_RATIO || ratio > MAX_RATIO || position < min || dimension - position < min) return null
  return { axis: vertical ? 'row' : 'col', ratio }
}

const SIDE_WORDS: Record<DropSide, string> = { left: '왼쪽', right: '오른쪽', top: '위쪽', bottom: '아래쪽' }
export const sideWord = (side: DropSide): string => SIDE_WORDS[side]

export const TOO_NARROW = '이 칸은 이쪽으로 더 나눌 수 없습니다. 다른 쪽이나 다른 칸에 놓아 주세요.'

function hasLeaf(node: SplitNode, pane: PaneId): boolean {
  return node.kind === 'split' ? hasLeaf(node.first, pane) || hasLeaf(node.second, pane) : node.pane === pane
}

function replaceLeaf(node: SplitNode, pane: PaneId, change: (leaf: SplitNode) => SplitNode): SplitNode {
  if (node.kind !== 'split') return node.pane === pane ? change(node) : node
  const first = replaceLeaf(node.first, pane, change)
  const second = replaceLeaf(node.second, pane, change)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** The tree without that leaf: the part it was divided from takes its place */
function withoutLeaf(node: SplitNode, pane: PaneId): SplitNode {
  if (node.kind !== 'split') return node
  if (node.first.kind !== 'split' && node.first.pane === pane) return node.second
  if (node.second.kind !== 'split' && node.second.pane === pane) return node.first
  const first = withoutLeaf(node.first, pane)
  const second = withoutLeaf(node.second, pane)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** `target` is halved on `side` and `pane` goes into that half */
function besides(tree: SplitNode, target: PaneId, side: DropSide, pane: PaneId): SplitNode {
  const arriving: SplitNode = { kind: 'pane', pane }
  const isFirst = side === 'left' || side === 'top'
  return replaceLeaf(tree, target, leaf => ({
    kind: 'split', axis: axisOf(side), ratio: 0.5,
    first: isFirst ? arriving : leaf,
    second: isFirst ? leaf : arriving
  }))
}

/** A new pane on `side` of the pane `target` (a tab merged in). Unchanged when the tab is full or the id is taken. */
export function insertBeside(tree: SplitNode, target: PaneId, side: DropSide, newPane: PaneId): SplitNode {
  if (leafCount(tree) >= MAX_PANES || paneIds(tree).includes(newPane) || !paneIds(tree).includes(target)) return tree
  return besides(tree, target, side, newPane)
}

/**
 * The pane `moving` leaves its place (the part it was divided from takes it) and goes to `side` of
 * `target`. The pane keeps its id, so its shell stays as it is. Unchanged when it cannot.
 */
export function movePaneBeside(tree: SplitNode, moving: PaneId, target: PaneId, side: DropSide): SplitNode {
  if (moving === target || !paneIds(tree).includes(moving) || !paneIds(tree).includes(target)) return tree
  const rest = withoutLeaf(tree, moving)
  if (rest === tree || hasLeaf(rest, moving)) return tree
  return besides(rest, target, side, moving)
}
