// A split pane being dragged by its grip. dataTransfer data cannot be read while the drag is over
// a target (only on drop), so the pane in flight is also kept here for the targets to look at.

import type { PaneId } from './splitTree'

export const PANE_DRAG_TYPE = 'application/x-ezshell-term-pane'

export interface PaneDrag {
  /** The tab the pane belongs to */
  sessionId: string
  pane: PaneId
}

let current: PaneDrag | null = null

export const startPaneDrag = (drag: PaneDrag) => { current = drag }
export const endPaneDrag = () => { current = null }
export const currentPaneDrag = (): PaneDrag | null => current
export const isPaneDrag = (types: readonly string[]) => types.includes(PANE_DRAG_TYPE)
