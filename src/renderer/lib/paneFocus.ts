// Going to one pane of a split tab from outside the tab (the sidebar's layout maps). The pane is
// found in the tab's own DOM node (lib/tabHosts.ts) by its data-pane attribute; the store is not changed.
import type { CSSProperties } from 'react'
import { tabHost } from './tabHosts'
import type { PaneId, Rect } from './splitTree'

/** The tab comes into view first; its terminal takes the focus, so the pane's is given a moment later */
const FOCUS_DELAY_MS = 60

/** Show the tab and put the keyboard in `pane` */
export function focusTabPane(focusTerminal: (tabId: string) => void, tabId: string, pane: PaneId): void {
  focusTerminal(tabId)
  window.setTimeout(() => {
    tabHost(tabId).querySelector<HTMLElement>(`[data-pane="${CSS.escape(pane)}"] .xterm-helper-textarea`)?.focus()
  }, FOCUS_DELAY_MS)
}

/** The pane of the tab that holds the keyboard now (null when the focus is elsewhere) */
export function focusedPaneOf(tabId: string): PaneId | null {
  const active = document.activeElement
  if (!active || !tabHost(tabId).contains(active)) return null
  return active.closest<HTMLElement>('[data-pane]')?.dataset.pane ?? null
}

/** Where a pane sits in a map drawn at any size (the tree's rectangles are fractions of the tab) */
export function cellStyle(rect: Rect): CSSProperties {
  return { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }
}
