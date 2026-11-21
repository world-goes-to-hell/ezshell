import { useEffect, useState, type MutableRefObject } from 'react'
import { useTerminalStore, type TabStripPosition } from '../stores/terminalStore'
import { tabHost } from '../lib/tabHosts'
import { MERGE_BLOCKED_TITLE, mergeBlock } from '../lib/tabMerge'
import { mergeTabIntoPane, treeWithArrival, type MergePlace } from '../lib/tabToPane'
import { toast } from '../stores/toastStore'
import { halfOf, zoneAt, type DropSide } from '../lib/paneDropZones'

interface MergeHover {
  kind: 'merge'
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

interface TabOrderHover {
  kind: 'order'
  position: TabStripPosition
  box: { left: number; top: number; height: number }
}

type TabDropHover = MergeHover | TabOrderHover
type DragPoint = Pick<DragEvent, 'clientX' | 'clientY' | 'altKey'>

const PANES = '[data-pane], [data-vacant]'
/** Tabs of the single tab strip and of the split view's strips (they carry their tab id) */
const TABS = '.terminal-tab[data-tab-id], .split-pane-tab-item[data-tab-id]'
const TAB_STRIPS = '.terminal-tab-items, .terminal-tabs:not(.terminal-tab-header), .split-pane-tabs'
const TAB_MERGE_HOLD_MS = 700
const TAB_MERGE_SLOP_PX = 8
/** Band along the terminal area's edges that means "split the screen" while a tab of the single strip is dragged */
export const SCREEN_SPLIT_BAND_PX = 48

function tabOrderAt(strip: HTMLElement, draggingId: string, x: number): TabOrderHover {
  const all = [...document.querySelectorAll<HTMLElement>(TABS)]
  const inStrip = all.filter(tab => tab.parentElement === strip)
  const bounds = strip.getBoundingClientRect()
  const choices = inStrip.flatMap(tab => {
    if (tab.dataset.tabId === draggingId) return []
    const rect = tab.getBoundingClientRect()
    return rect.width > 0 && rect.right > bounds.left && rect.left < bounds.right ? [{ tab, rect }] : []
  })
  const before = choices.find(({ rect }) => x < rect.left + rect.width / 2)
  const target = before ?? choices[choices.length - 1]
  const rect = target?.rect ?? bounds
  return {
    kind: 'order',
    position: {
      screen: Number(strip.closest<HTMLElement>('.split-pane[data-screen]')?.dataset.screen ?? 0),
      targetId: target?.tab.dataset.tabId ?? (inStrip.some(tab => tab.dataset.tabId === draggingId) ? draggingId : null),
      after: !before,
      visibleIds: all.map(tab => tab.dataset.tabId!)
    },
    box: {
      left: Math.max(bounds.left + 2, Math.min(bounds.right - 2, !target ? bounds.left + 4 : before ? rect.left : rect.right)),
      top: Math.max(rect.top, bounds.top) + 3,
      height: Math.max(4, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top) - 6)
    }
  }
}

const tabAt = (elements: Element[]) => elements.find((element): element is HTMLElement => element instanceof HTMLElement && element.matches(TABS))

function hoverAt(draggingId: string, point: DragPoint, hasEdgeZones: boolean, heldTab: HTMLElement | null, underPointer = document.elementsFromPoint(point.clientX, point.clientY)): TabDropHover | null {
  const { clientX: x, clientY: y, altKey } = point
  const tabs = useTerminalStore.getState().terminals
  const source = tabs.get(draggingId)
  if (!source) return null
  const strip = underPointer.find(candidate => candidate.matches(TAB_STRIPS))
  const tabElement = tabAt(underPointer)
  const mergeOnTab = (altKey || heldTab === tabElement) && !source.db && !source.browser && tabElement && tabElement.dataset.tabId !== draggingId
  if (strip instanceof HTMLElement && !mergeOnTab) return tabOrderAt(strip, draggingId, x)
  // A DB tab is never a pane: no marker at all rather than a refusal on every terminal it passes
  if (source.db || source.browser) return null
  // A held-over tab or an Alt-drop uses its first empty place or its largest pane.
  if (mergeOnTab) {
    const targetId = tabElement.dataset.tabId ?? ''
    if (!tabs.has(targetId) || targetId === draggingId) return null
    let blocked = mergeBlock(tabs, draggingId, targetId)
    if (!blocked) {
      const arrival = treeWithArrival(targetId)
      if ('error' in arrival) blocked = arrival.error
    }
    const rect = tabElement.getBoundingClientRect()
    return { kind: 'merge', targetId, onTab: true, box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, blocked }
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
  const element = underPointer.find(candidate => candidate.matches(PANES))
  if (!(element instanceof HTMLElement)) return null
  const targetId = Array.from(tabs.keys()).find(id => tabHost(id).contains(element))
  if (!targetId || targetId === draggingId || tabs.get(targetId)?.db || tabs.get(targetId)?.browser) return null
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
  return { kind: 'merge', targetId, place, onTab: false, box: { left: shown.x, top: shown.y, width: shown.w, height: shown.h }, blocked }
}

function sameHover(a: TabDropHover | null, b: TabDropHover | null): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind || a.box.left !== b.box.left || a.box.top !== b.box.top || a.box.height !== b.box.height) return false
  if (a.kind === 'order' && b.kind === 'order') return a.position.screen === b.position.screen && a.position.targetId === b.position.targetId && a.position.after === b.position.after
  return a.kind === 'merge' && b.kind === 'merge' && a.targetId === b.targetId && a.onTab === b.onTab &&
    a.place?.pane === b.place?.pane && a.place?.side === b.place?.side && a.blocked === b.blocked && a.box.width === b.box.width
}

/**
 * A tab dragged onto a strip changes order until it is held over one tab. Holding changes the
 * preview to merge, as does Alt. Dropping onto another tab's pane also merges it.
 * Listens on the document in the capture phase because the terminals swallow drag events.
 * `hasEdgeZones`: the edges of the terminal area are taken by "split the screen" (single tab strip).
 * `dropTaken`: set when a drop was handled here, so the drag's own end
 * handling (pop out to a window when it left the terminal area) does nothing.
 */
export function useTabDropOnPane(draggingId: string | null, hasEdgeZones: boolean, dropTaken?: MutableRefObject<boolean>): TabDropHover | null {
  const [hover, setHover] = useState<TabDropHover | null>(null)

  useEffect(() => {
    if (!draggingId) {
      setHover(null)
      return
    }
    let current: TabDropHover | null = null
    let waiting: { tab: HTMLElement; point: DragPoint } | null = null
    let lastPoint: DragPoint | null = null
    let heldTab: HTMLElement | null = null
    let holdTimer: number | undefined
    const show = (next: TabDropHover | null) => {
      if (sameHover(current, next)) return
      current = next
      setHover(next)
    }
    const clearHold = () => {
      clearTimeout(holdTimer)
      waiting = null
      heldTab = null
    }
    const nearHoldPoint = (point: DragPoint) => waiting &&
      Math.hypot(point.clientX - waiting.point.clientX, point.clientY - waiting.point.clientY) <= TAB_MERGE_SLOP_PX
    const trackHold = (point: DragPoint, tab: HTMLElement | undefined) => {
      lastPoint = point
      if (tab && waiting?.tab === tab && nearHoldPoint(point)) return
      clearHold()
      const tabs = useTerminalStore.getState().terminals
      const source = tabs.get(draggingId)
      const target = tab?.dataset.tabId ? tabs.get(tab.dataset.tabId) : undefined
      if (!tab || tab.dataset.tabId === draggingId || !source || source.db || source.browser || !target || target.db || target.browser) return
      waiting = { tab, point }
      holdTimer = window.setTimeout(() => {
        if (!lastPoint || tabAt(document.elementsFromPoint(lastPoint.clientX, lastPoint.clientY)) !== tab) return
        heldTab = tab
        show(hoverAt(draggingId, lastPoint, hasEdgeZones, heldTab))
      }, TAB_MERGE_HOLD_MS)
    }
    const onDragOver = (event: DragEvent) => {
      const { clientX, clientY, altKey } = event
      const underPointer = document.elementsFromPoint(clientX, clientY)
      trackHold({ clientX, clientY, altKey }, tabAt(underPointer))
      const next = hoverAt(draggingId, event, hasEdgeZones, heldTab, underPointer)
      show(next)
      if (!next) return
      // Without this the drop event never comes
      event.preventDefault()
      if (next.kind === 'order' || next.onTab) event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = next.kind === 'merge' && !next.onTab && next.blocked ? 'none' : 'move'
    }
    const onDragLeave = (event: DragEvent) => {
      const tab = waiting?.tab
      if (event.target !== tab && event.target !== document.documentElement && event.target !== document.body) return
      if (tab && event.relatedTarget instanceof Node && tab.contains(event.relatedTarget)) return
      clearHold()
      show(null)
    }
    const onDrop = (event: DragEvent) => {
      const target = hoverAt(draggingId, event, hasEdgeZones, nearHoldPoint(event) ? heldTab : null)
      clearHold()
      show(null)
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      if (dropTaken) dropTaken.current = true
      if (target.kind === 'order') {
        // Moving across screens may remove the source element. Let it receive dragend first.
        window.setTimeout(() => useTerminalStore.getState().moveTabInStrip(draggingId, target.position), 0)
        return
      }
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
    document.addEventListener('dragleave', onDragLeave, true)
    document.addEventListener('drop', onDrop, true)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('dragleave', onDragLeave, true)
      document.removeEventListener('drop', onDrop, true)
      clearHold()
      setHover(null)
    }
  }, [draggingId, hasEdgeZones, dropTaken])

  return hover
}
