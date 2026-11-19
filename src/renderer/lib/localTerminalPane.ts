/**
 * The sidebar's local work pane (below the session list). Left alone it is as tall as its rows while the
 * session list keeps about three rows (CSS). Once the user drags the divider, the chosen height is kept.
 */

export const LOCAL_PANE_STORAGE_KEY = 'sidebarLocalPane'

/** Header plus one row: the pane never gets smaller than this while open */
export const LOCAL_PANE_MIN_HEIGHT = 64
/** Room always left to the session list above (about three rows) */
export const SESSION_LIST_MIN_HEIGHT = 96

export interface LocalPanePrefs {
  /** Height chosen by dragging, in px. Absent: follow the number of terminals */
  height?: number
  collapsed: boolean
}

/** A dragged height kept inside the list area: at least one row, and the session list keeps its minimum */
export function clampPaneHeight(height: number, containerHeight: number): number {
  const max = Math.max(LOCAL_PANE_MIN_HEIGHT, containerHeight - SESSION_LIST_MIN_HEIGHT)
  if (!Number.isFinite(height)) return LOCAL_PANE_MIN_HEIGHT
  return Math.round(Math.min(max, Math.max(LOCAL_PANE_MIN_HEIGHT, height)))
}

/** Stored prefs; anything unreadable gives the defaults (automatic height, open) */
export function parseLocalPanePrefs(raw: string | null | undefined): LocalPanePrefs {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null
    if (!value || typeof value !== 'object') return { collapsed: false }
    const { height, collapsed } = value as Record<string, unknown>
    const isUsable = typeof height === 'number' && Number.isFinite(height) && height >= LOCAL_PANE_MIN_HEIGHT && height <= 4000
    return { ...(isUsable ? { height: Math.round(height) } : {}), collapsed: collapsed === true }
  } catch {
    return { collapsed: false }
  }
}

interface PaneLayout {
  mode: string
  activePaneType: 'primary' | 'secondary' | null
  primary: { activeTerminalId: string | null }
  secondary: { activeTerminalId: string | null } | null
  /** Every screen of a split (up to four) and the focused one; older callers give the first two only */
  panes?: ReadonlyArray<{ activeTerminalId: string | null }>
  activePane?: number | null
}

/** The tab the user is looking at: the focused pane's active tab when the screen is split */
export function visibleTerminalId(layout: PaneLayout, activeTerminalId: string | null): string | null {
  if (layout.mode !== 'split') return activeTerminalId
  if (layout.panes && layout.activePane !== undefined && layout.activePane !== null) return layout.panes[layout.activePane]?.activeTerminalId ?? null
  const pane = layout.activePaneType === 'secondary' ? layout.secondary : layout.primary
  return pane?.activeTerminalId ?? null
}
