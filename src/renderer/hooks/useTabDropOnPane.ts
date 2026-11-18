import { useEffect, useState, type MutableRefObject } from 'react'
import { useTerminalStore } from '../stores/terminalStore'
import { tabHost } from '../lib/tabHosts'
import { MERGE_BLOCKED_TITLE, mergeBlock } from '../lib/tabMerge'
import { mergeTabIntoPane, treeWithArrival, type MergePlace } from '../lib/tabToPane'
import { toast } from '../stores/toastStore'
import { halfOf, zoneAt, type DropSide } from '../lib/paneDropZones'

export interface MergeHover {
  targetId: string
  /** The pane or empty place under the pointer; absent over a tab (the tab picks its own place) */
  place?: MergePlace
  /** Over the target's tab in a tab strip rather than over one of its panes */
  onTab: boolean
  /** The pane (or tab) under the pointer, in viewport coordinates */
  box: { left: number; top: number; width: number; height: number }
  /** Why the dragged tab cannot be merged here; null when it can */
  blocked: string | null
}

const PANES = '[data-pane], [data-vacant]'
/** Tabs of the single tab strip and of the split view's strips (they carry their tab id) */
const TABS = '.terminal-tab[data-tab-id], .split-pane-tab-item[data-tab-id]'
/** Band along the terminal area's edges that means "split the screen" while a tab of the single strip is dragged */
export const SCREEN_SPLIT_BAND_PX = 48

function hoverAt(draggingId: string, x: number, y: number, hasEdgeZones: boolean): MergeHover | null {
  const tabs = useTerminalStore.getState().terminals
  const source = tabs.get(draggingId)
  // A DB tab is never a pane: no marker at all rather than a refusal on every terminal it passes
  if (!source || source.db) return null
  // Over another tab in a tab strip: merged into that tab (an empty place first, else its largest pane)
  const tabElement = document.elementsFromPoint(x, y).find(candidate => candidate.matches(TABS))
  if (tabElement instanceof HTMLElement) {
    const targetId = tabElement.dataset.tabId ?? ''
    if (!tabs.has(targetId) || targetId === draggingId) return null
    let blocked = mergeBlock(tabs, draggingId, targetId)
    if (!blocked) {
      const arrival = treeWithArrival(targetId)
      if ('error' in arrival) blocked = arrival.error
    }
    const rect = tabElement.getBoundingClientRect()
    return { targetId, onTab: true, box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, blocked }
  }
  // The edge zones exist only when there are two tabs to put side by side
  if (hasEdgeZones && tabs.size >= 2) {
    const area = document.querySelector('.terminal-area')?.getBoundingClientRect()
    if (!area) return null
    const isAtEdge = x < area.left + SCREEN_SPLIT_BAND_PX || x > area.right - SCREEN_SPLIT_BAND_PX
      || y < area.top + SCREEN_SPLIT_BAND_PX || y > area.bottom - SCREEN_SPLIT_BAND_PX
    if (isAtEdge) return null
  }
  // Tabs that are not in front are hidden with visibility and are not found here
  const element = document.elementsFromPoint(x, y).find(candidate => candidate.matches(PANES))
  if (!(element instanceof HTMLElement)) return null
  const targetId = Array.from(tabs.keys()).find(id => tabHost(id).contains(element))
  if (!targetId || targetId === draggingId || tabs.get(targetId)?.db) return null
  const vacant = element.dataset.vacant
  const rect = element.getBoundingClientRect()
  const paneBox = { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
  // A pane is halved on the side nearest the pointer; an empty place is filled as it is
  const side: DropSide | undefined = vacant ? undefined : zoneAt(paneBox, x, y, false) as DropSide
  const place: MergePlace = vacant ? { pane: vacant, isVacant: true } : { pane: element.dataset.pane ?? '', isVacant: false, side }
  const shown = side ? halfOf(paneBox, side) : paneBox
  let blocked = mergeBlock(tabs, draggingId, targetId)
  if (!blocked) {
    const arrival = treeWithArrival(targetId, place)
    if ('error' in arrival) blocked = arrival.error
  }
  return { targetId, place, onTab: false, box: { left: shown.x, top: shown.y, width: shown.w, height: shown.h }, blocked }
}

const sameHover = (a: MergeHover | null, b: MergeHover | null): boolean =>
  a === b || (!!a && !!b && a.targetId === b.targetId && a.onTab === b.onTab && a.place?.pane === b.place?.pane && a.place?.side === b.place?.side && a.blocked === b.blocked
    && a.box.left === b.box.left && a.box.top === b.box.top && a.box.width === b.box.width && a.box.height === b.box.height)

/**
 * A tab dragged onto a pane of another tab is merged into that tab as a pane (lib/tabToPane.ts).
 * Listens on the document in the capture phase: the terminals swallow drag events, and the tab
 * strips and the terminal area have drop handling of their own.
 * Dropping it on another tab in a tab strip does the same (into that tab's empty place or largest pane).
 * `hasEdgeZones`: the edges of the terminal area are taken by "split the screen" (single tab strip).
 * `dropTaken`: set when a drop was handled here (merged or refused), so the drag's own end
 * handling (pop out to a window when it left the terminal area) does nothing.
 */
export function useTabDropOnPane(draggingId: string | null, hasEdgeZones: boolean, dropTaken?: MutableRefObject<boolean>): MergeHover | null {
  const [hover, setHover] = useState<MergeHover | null>(null)

  useEffect(() => {
    if (!draggingId) {
      setHover(null)
      return
    }
    let current: MergeHover | null = null
    const show = (next: MergeHover | null) => {
      if (sameHover(current, next)) return
      current = next
      setHover(next)
    }
    const onDragOver = (event: DragEvent) => {
      const next = hoverAt(draggingId, event.clientX, event.clientY, hasEdgeZones)
      show(next)
      if (!next) return
      // Without this the drop event never comes
      event.preventDefault()
      // Over a tab: the strip's own handling (move the tab to that side of the split view) stays out
      if (next.onTab) event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = next.blocked ? 'none' : 'move'
    }
    const onDrop = (event: DragEvent) => {
      const target = current
      show(null)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      if (dropTaken) dropTaken.current = true
      if (target.blocked) {
        toast.warning(MERGE_BLOCKED_TITLE, target.blocked)
        return
      }
      // After the drag has ended: the dragged tab's element goes away with the merge, and an element
      // removed mid-drag never gets its dragend
      window.setTimeout(() => {
        void mergeTabIntoPane(draggingId, target.targetId, target.place)
          .then((result) => { if (!result.ok) toast.warning(MERGE_BLOCKED_TITLE, result.error) })
          .catch(() => toast.error('탭을 병합하지 못했습니다', '잠시 후 다시 시도해 주세요.'))
      }, 0)
    }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
      setHover(null)
    }
  }, [draggingId, hasEdgeZones, dropTaken])

  return hover
}
