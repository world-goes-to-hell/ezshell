// The screen split (tabs side by side, each screen with its own tab strip) as a list of up to four
// screens (docs/plan/2026-11-19-screen-split-up-to-four.md). Pure: the store keeps the result.
// `primary` / `secondary` / `activePaneType` stay on the layout as views of the first two screens,
// so code written for two screens keeps working; screens are otherwise named by their index.

export const MAX_SCREENS = 4
/** No screen gets narrower than this share when a divider is dragged */
export const MIN_SHARE = 0.12

export interface ScreenPane {
  terminalIds: string[]
  activeTerminalId: string | null
}

export type ScreenDirection = 'horizontal' | 'vertical'

export interface ScreenLayout {
  mode: 'single' | 'split'
  direction: ScreenDirection
  panes: ScreenPane[]
  /** Shares of the width (horizontal) or height (vertical), summing to 1 */
  sizes: number[]
  /** The screen with the keyboard; null when the screen is not split */
  activePane: number | null
  // Views of the first two screens, for code written for two
  primary: ScreenPane
  secondary: ScreenPane | null
  activePaneType: 'primary' | 'secondary' | null
}

/** A screen by index, or by its old name ('primary' is the first, 'secondary' the second) */
export type PaneRef = 'primary' | 'secondary' | number

export const paneIndex = (ref: PaneRef): number => (ref === 'primary' ? 0 : ref === 'secondary' ? 1 : ref)

export const evenSizes = (count: number): number[] => Array.from({ length: count }, () => 1 / count)

const empty = (): ScreenPane => ({ terminalIds: [], activeTerminalId: null })

/** Shares that fit `count` screens: the given ones scaled to sum 1, or even when they do not fit */
function fitSizes(sizes: readonly number[] | undefined, count: number): number[] {
  if (!sizes || sizes.length !== count || sizes.some(size => !Number.isFinite(size) || size <= 0)) return evenSizes(count)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  return sizes.map(size => size / total)
}

const withActive = (pane: ScreenPane): ScreenPane => ({
  terminalIds: pane.terminalIds,
  activeTerminalId: pane.activeTerminalId && pane.terminalIds.includes(pane.activeTerminalId) ? pane.activeTerminalId : pane.terminalIds[0] ?? null
})

/**
 * The layout for these screens: empty screens are dropped (their share goes to the others), a tab in
 * no screen joins the first one (`allIds`, so a tab is never lost), and one screen left is the plain
 * single screen.
 */
export function buildScreens(input: {
  panes: readonly ScreenPane[]
  sizes?: readonly number[]
  activePane?: number | null
  direction?: ScreenDirection
  allIds?: readonly string[]
}): ScreenLayout {
  const direction = input.direction ?? 'horizontal'
  const seen = new Set<string>()
  // Each tab in one screen only (the first that has it)
  let panes = input.panes.slice(0, MAX_SCREENS).map(pane => ({
    terminalIds: pane.terminalIds.filter(id => !seen.has(id) && (seen.add(id), true)),
    activeTerminalId: pane.activeTerminalId
  }))
  const missing = (input.allIds ?? []).filter(id => !seen.has(id))
  if (missing.length > 0) panes = panes.length > 0 ? [{ ...panes[0], terminalIds: [...panes[0].terminalIds, ...missing] }, ...panes.slice(1)] : [{ terminalIds: missing, activeTerminalId: null }]
  if (input.allIds) {
    const present = new Set(input.allIds)
    panes = panes.map(pane => ({ ...pane, terminalIds: pane.terminalIds.filter(id => present.has(id)) }))
  }
  const sizes = fitSizes(input.sizes, input.panes.slice(0, MAX_SCREENS).length)
  const kept = panes.map((pane, index) => ({ pane: withActive(pane), size: sizes[index] ?? 0, index })).filter(entry => entry.pane.terminalIds.length > 0)
  if (kept.length <= 1) {
    const only = kept[0]?.pane ?? empty()
    return { mode: 'single', direction: 'horizontal', panes: [only], sizes: [1], activePane: null, primary: only, secondary: null, activePaneType: null }
  }
  // The focused screen keeps its focus where it moved to; a dropped one hands it to its neighbour
  const wanted = input.activePane ?? 0
  const at = kept.findIndex(entry => entry.index >= wanted)
  const activePane = at < 0 ? kept.length - 1 : kept[at].index === wanted ? at : Math.max(0, at - 1)
  const keptPanes = kept.map(entry => entry.pane)
  return {
    mode: 'split', direction, panes: keptPanes, sizes: fitSizes(kept.map(entry => entry.size), kept.length), activePane,
    primary: keptPanes[0], secondary: keptPanes[1], activePaneType: activePane === 0 ? 'primary' : 'secondary'
  }
}

/** The screens of a layout, also of one written the old way (primary / secondary only) */
export function screensOf(layout: Partial<ScreenLayout> & { mode: 'single' | 'split'; primary: ScreenPane; secondary: ScreenPane | null }): ScreenPane[] {
  if (layout.panes && layout.panes.length > 0) return layout.panes
  return layout.mode === 'split' && layout.secondary ? [layout.primary, layout.secondary] : [layout.primary]
}

/** The screen holding a tab, or -1 */
export const screenOfTab = (panes: readonly ScreenPane[], id: string): number => panes.findIndex(pane => pane.terminalIds.includes(id))

/** Without the tab in any screen */
export const withoutTab = (panes: readonly ScreenPane[], id: string): ScreenPane[] =>
  panes.map(pane => ({ ...pane, terminalIds: pane.terminalIds.filter(item => item !== id) }))

/**
 * A new screen at the start or end holding `id` (taken out of its screen). Null when there are
 * already four screens, or when the screen is split the other way.
 */
export function addScreen(layout: ScreenLayout, id: string, side: 'start' | 'end', direction: ScreenDirection): { panes: ScreenPane[]; sizes: number[]; activePane: number } | null {
  if (layout.mode === 'split' && (layout.panes.length >= MAX_SCREENS || layout.direction !== direction)) return null
  const panes = withoutTab(layout.mode === 'split' ? layout.panes : [layout.primary], id)
  const sizes = layout.mode === 'split' ? layout.sizes : [1]
  const share = 1 / (panes.length + 1)
  const scaled = sizes.map(size => size * (1 - share))
  const arriving = { terminalIds: [id], activeTerminalId: id }
  return side === 'start'
    ? { panes: [arriving, ...panes], sizes: [share, ...scaled], activePane: 0 }
    : { panes: [...panes, arriving], sizes: [...scaled, share], activePane: panes.length }
}

/** Why a new screen cannot be made, for the notice; null when it can */
export function addScreenRefusal(layout: ScreenLayout, direction: ScreenDirection): string | null {
  if (layout.mode !== 'split') return null
  if (layout.panes.length >= MAX_SCREENS) return `화면은 ${MAX_SCREENS}개까지 나눌 수 있습니다.`
  if (layout.direction !== direction) return layout.direction === 'horizontal' ? '좌우로 나눈 화면은 왼쪽·오른쪽 끝에만 더할 수 있습니다.' : '위아래로 나눈 화면은 위·아래 끝에만 더할 수 있습니다.'
  return null
}

/**
 * The shares after dragging the divider between screen `index` and the next one to `ratio` (where
 * the divider sits as a share of the whole). Only the two neighbours change; neither goes below MIN_SHARE.
 */
export function dragDivider(sizes: readonly number[], index: number, ratio: number): number[] {
  if (index < 0 || index >= sizes.length - 1) return [...sizes]
  const before = sizes.slice(0, index).reduce((sum, size) => sum + size, 0)
  const pair = sizes[index] + sizes[index + 1]
  const first = Math.min(pair - MIN_SHARE, Math.max(MIN_SHARE, ratio - before))
  return sizes.map((size, at) => (at === index ? first : at === index + 1 ? pair - first : size))
}
