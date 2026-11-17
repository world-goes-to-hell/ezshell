// How a tab's terminal area is divided. A tab starts as one pane (the main terminal); splitting a
// pane puts a new one beside it ('row') or below it ('col'), and a pane made that way can be split
// again. So the layout is a tree: leaves are panes, inner nodes are a division with a ratio.
//
// Only shapes live here. TerminalPanel keeps every pane as a flat, stably keyed element and gives
// it the rectangle computed here, so changing the tree never remounts a pane that stays
// (a remount closes its shell).

export type PaneId = string
export const MAIN_PANE: PaneId = 'main'
/** 'row': the two parts sit side by side. 'col': one above the other. */
export type SplitAxis = 'row' | 'col'

export type SplitNode =
  | { kind: 'pane'; pane: PaneId }
  /** The place of a pane whose shell moved out to a tab of its own; `pane` is that pane's old id */
  | { kind: 'vacant'; pane: PaneId }
  | { kind: 'split'; axis: SplitAxis; ratio: number; first: SplitNode; second: SplitNode }

/** Fractions (0..1) of the terminal area */
export interface Rect { x: number; y: number; w: number; h: number }

export interface DividerLine {
  /** Which division this line belongs to: 'r' is the root, then '0' (first) / '1' (second) per level */
  path: string
  axis: SplitAxis
  /** The area the division covers; the line runs across it */
  region: Rect
  ratio: number
}

export interface SplitLayout {
  panes: Array<{ pane: PaneId; rect: Rect }>
  vacants: Array<{ pane: PaneId; rect: Rect }>
  dividers: DividerLine[]
}

export const MAX_PANES = 6
export const MIN_RATIO = 0.1
export const MAX_RATIO = 0.9

export const singlePane = (): SplitNode => ({ kind: 'pane', pane: MAIN_PANE })
export const paneId = (seq: number): PaneId => `split-${seq}`

const clampRatio = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number.isFinite(ratio) ? ratio : 0.5))

/** Panes with a shell, in reading order of the tree */
export function paneIds(node: SplitNode): PaneId[] {
  if (node.kind === 'pane') return [node.pane]
  if (node.kind === 'vacant') return []
  return [...paneIds(node.first), ...paneIds(node.second)]
}

/** Panes and empty places together: what the limit and the "is it split" question count */
export function leafCount(node: SplitNode): number {
  return node.kind === 'split' ? leafCount(node.first) + leafCount(node.second) : 1
}

export const isSplitTree = (node: SplitNode | undefined): boolean => !!node && node.kind === 'split'

function mapLeaf(node: SplitNode, pane: PaneId, change: (leaf: SplitNode) => SplitNode): SplitNode {
  if (node.kind !== 'split') return node.pane === pane ? change(node) : node
  const first = mapLeaf(node.first, pane, change)
  const second = mapLeaf(node.second, pane, change)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** The pane is halved: it keeps the left / upper half, the new pane gets the other. Others do not move. */
export function splitPane(tree: SplitNode, pane: PaneId, axis: SplitAxis, newPane: PaneId): SplitNode {
  if (leafCount(tree) >= MAX_PANES || paneIds(tree).includes(newPane)) return tree
  return mapLeaf(tree, pane, leaf => (leaf.kind === 'pane'
    ? { kind: 'split', axis, ratio: 0.5, first: leaf, second: { kind: 'pane', pane: newPane } }
    : leaf))
}

/** Removes a leaf; the part it was divided from takes its place. The root leaf stays. */
function removeLeaf(node: SplitNode, pane: PaneId): SplitNode {
  if (node.kind !== 'split') return node
  if (node.first.kind !== 'split' && node.first.pane === pane) return node.second
  if (node.second.kind !== 'split' && node.second.pane === pane) return node.first
  const first = removeLeaf(node.first, pane)
  const second = removeLeaf(node.second, pane)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** Closes a pane (its shell ends). The tab's main terminal cannot be closed this way. */
export function closePane(tree: SplitNode, pane: PaneId): SplitNode {
  return pane === MAIN_PANE ? tree : removeLeaf(tree, pane)
}

/** Both panes keep their shells; only the places change */
export function swapPanes(tree: SplitNode, a: PaneId, b: PaneId): SplitNode {
  const ids = paneIds(tree)
  if (a === b || !ids.includes(a) || !ids.includes(b)) return tree
  const swap = (node: SplitNode): SplitNode => {
    if (node.kind === 'split') return { ...node, first: swap(node.first), second: swap(node.second) }
    if (node.kind === 'pane' && node.pane === a) return { kind: 'pane', pane: b }
    if (node.kind === 'pane' && node.pane === b) return { kind: 'pane', pane: a }
    return node
  }
  return swap(tree)
}

/** The pane's shell moved out to a tab: its place stays, empty, until it is merged away */
export function vacatePane(tree: SplitNode, pane: PaneId): SplitNode {
  if (pane === MAIN_PANE) return tree
  return mapLeaf(tree, pane, leaf => (leaf.kind === 'pane' ? { kind: 'vacant', pane } : leaf))
}

interface Found { parent: Extract<SplitNode, { kind: 'split' }>; isFirst: boolean; grand?: Extract<SplitNode, { kind: 'split' }>; parentIsFirst?: boolean }

function findVacant(node: SplitNode, pane: PaneId, grand?: Found['grand'], parentIsFirst?: boolean): Found | null {
  if (node.kind !== 'split') return null
  if (node.first.kind === 'vacant' && node.first.pane === pane) return { parent: node, isFirst: true, grand, parentIsFirst }
  if (node.second.kind === 'vacant' && node.second.pane === pane) return { parent: node, isFirst: false, grand, parentIsFirst }
  return findVacant(node.first, pane, node, true) ?? findVacant(node.second, pane, node, false)
}

function replaceNode(node: SplitNode, target: SplitNode, replacement: SplitNode): SplitNode {
  if (node === target) return replacement
  if (node.kind !== 'split') return node
  const first = replaceNode(node.first, target, replacement)
  const second = replaceNode(node.second, target, replacement)
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/**
 * An empty place is taken over by a neighbour. 'row' (가로로 병합): the part beside it grows into it.
 * 'col' (세로로 병합): the part above or below does. One of the two is always the part it was divided
 * from. The other is possible when the two divisions line up like a 2x2 block: the block is then
 * re-divided the other way round. Null when there is no such neighbour.
 */
export function mergeVacant(tree: SplitNode, pane: PaneId, axis: SplitAxis): SplitNode | null {
  const found = findVacant(tree, pane)
  if (!found) return null
  const { parent, isFirst, grand, parentIsFirst } = found
  const sibling = isFirst ? parent.second : parent.first
  if (parent.axis === axis) return replaceNode(tree, parent, sibling)
  if (!grand || grand.axis !== axis) return null
  const uncle = parentIsFirst ? grand.second : grand.first
  if (uncle.kind !== 'split' || uncle.axis !== parent.axis) return null
  // The neighbour across the other line (same side of the uncle) grows into the empty place;
  // the remaining two parts keep the grandparent's line between them
  const grower = isFirst ? uncle.first : uncle.second
  const uncleRest = isFirst ? uncle.second : uncle.first
  const rest: SplitNode = {
    kind: 'split', axis: grand.axis, ratio: grand.ratio,
    first: parentIsFirst ? sibling : uncleRest,
    second: parentIsFirst ? uncleRest : sibling
  }
  const regrouped: SplitNode = {
    kind: 'split', axis: parent.axis, ratio: parent.ratio,
    first: isFirst ? grower : rest,
    second: isFirst ? rest : grower
  }
  return replaceNode(tree, grand, regrouped)
}

/** Rectangles of every pane and empty place, and the divider line of every division */
export function layoutOf(tree: SplitNode): SplitLayout {
  const layout: SplitLayout = { panes: [], vacants: [], dividers: [] }
  const walk = (node: SplitNode, rect: Rect, path: string) => {
    if (node.kind === 'pane') { layout.panes.push({ pane: node.pane, rect }); return }
    if (node.kind === 'vacant') { layout.vacants.push({ pane: node.pane, rect }); return }
    layout.dividers.push({ path, axis: node.axis, region: rect, ratio: node.ratio })
    if (node.axis === 'row') {
      walk(node.first, { ...rect, w: rect.w * node.ratio }, path + '0')
      walk(node.second, { ...rect, x: rect.x + rect.w * node.ratio, w: rect.w * (1 - node.ratio) }, path + '1')
    } else {
      walk(node.first, { ...rect, h: rect.h * node.ratio }, path + '0')
      walk(node.second, { ...rect, y: rect.y + rect.h * node.ratio, h: rect.h * (1 - node.ratio) }, path + '1')
    }
  }
  walk(tree, { x: 0, y: 0, w: 1, h: 1 }, 'r')
  return layout
}

function updateAt(node: SplitNode, path: string, change: (split: Extract<SplitNode, { kind: 'split' }>) => SplitNode, at = 'r'): SplitNode {
  if (node.kind !== 'split') return node
  if (at === path) return change(node)
  if (!path.startsWith(at)) return node
  const first = updateAt(node.first, path, change, at + '0')
  const second = updateAt(node.second, path, change, at + '1')
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

/** Moves one divider line */
export function setRatio(tree: SplitNode, path: string, ratio: number): SplitNode {
  return updateAt(tree, path, split => ({ ...split, ratio: clampRatio(ratio) }))
}

/** How many panes stand side by side (axis 'row') or one above the other ('col') inside a part */
function spanOf(node: SplitNode, axis: SplitAxis): number {
  if (node.kind !== 'split') return 1
  const first = spanOf(node.first, axis)
  const second = spanOf(node.second, axis)
  return node.axis === axis ? first + second : Math.max(first, second)
}

const evenRatio = (split: Extract<SplitNode, { kind: 'split' }>) => {
  const first = spanOf(split.first, split.axis)
  return clampRatio(first / (first + spanOf(split.second, split.axis)))
}

/**
 * Every line is placed again so panes in a row get equal widths (and equal heights in a column):
 * three side by side get a third each, not a half and two quarters. The shape does not change.
 */
export function equalize(tree: SplitNode): SplitNode {
  if (tree.kind !== 'split') return tree
  return { ...tree, ratio: evenRatio(tree), first: equalize(tree.first), second: equalize(tree.second) }
}

/** The same for one divider line only */
export function equalizeAt(tree: SplitNode, path: string): SplitNode {
  return updateAt(tree, path, split => ({ ...split, ratio: evenRatio(split) }))
}

/** The pane or empty place under a point (fractions of the terminal area) */
export function leafAt(layout: SplitLayout, x: number, y: number): { pane: PaneId; rect: Rect; isVacant: boolean } | null {
  const inside = (rect: Rect) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
  const pane = layout.panes.find(entry => inside(entry.rect))
  if (pane) return { ...pane, isVacant: false }
  const vacant = layout.vacants.find(entry => inside(entry.rect))
  return vacant ? { ...vacant, isVacant: true } : null
}

/** Next number for a new pane id: ids are never reused inside a tab, so element keys stay unique */
export function nextPaneSeq(tree: SplitNode, lastSeq = 0): number {
  const used = (node: SplitNode): number[] => (node.kind === 'split'
    ? [...used(node.first), ...used(node.second)]
    : [Number(/^split-(\d+)$/.exec(node.pane)?.[1] ?? 0)])
  return Math.max(lastSeq, ...used(tree)) + 1
}

const EDGE = 1e-6

/**
 * CSS box of a pane inside the terminal area: its rectangle, minus half a divider on every side
 * that borders another pane (the divider is drawn in that gap).
 */
export function paneBox(rect: Rect, dividerPx: number): { position: 'absolute'; left: string; top: string; width: string; height: string } {
  const half = dividerPx / 2
  const left = rect.x > EDGE ? half : 0
  const top = rect.y > EDGE ? half : 0
  const right = rect.x + rect.w < 1 - EDGE ? half : 0
  const bottom = rect.y + rect.h < 1 - EDGE ? half : 0
  return {
    position: 'absolute',
    left: `calc(${rect.x * 100}% + ${left}px)`,
    top: `calc(${rect.y * 100}% + ${top}px)`,
    width: `calc(${rect.w * 100}% - ${left + right}px)`,
    height: `calc(${rect.h * 100}% - ${top + bottom}px)`
  }
}

/**
 * CSS box of a divider line: across its division's area, centred on the boundary. Its ends stop
 * half a divider short where the area borders another division: there the other line runs, and a
 * line reaching into it would take the pointer at the crossing.
 */
export function dividerBox(line: DividerLine, dividerPx: number): { position: 'absolute'; left: string; top: string; width: string; height: string } {
  const { region, ratio } = line
  const half = dividerPx / 2
  const left = region.x > EDGE ? half : 0
  const top = region.y > EDGE ? half : 0
  const right = region.x + region.w < 1 - EDGE ? half : 0
  const bottom = region.y + region.h < 1 - EDGE ? half : 0
  if (line.axis === 'row') {
    return {
      position: 'absolute',
      left: `calc(${(region.x + region.w * ratio) * 100}% - ${half}px)`,
      top: `calc(${region.y * 100}% + ${top}px)`,
      width: `${dividerPx}px`,
      height: `calc(${region.h * 100}% - ${top + bottom}px)`
    }
  }
  return {
    position: 'absolute',
    left: `calc(${region.x * 100}% + ${left}px)`,
    top: `calc(${(region.y + region.h * ratio) * 100}% - ${half}px)`,
    width: `calc(${region.w * 100}% - ${left + right}px)`,
    height: `${dividerPx}px`
  }
}
