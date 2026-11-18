import { useEffect } from 'react'
import { currentPaneDrag, endPaneDrag, isPaneDrag } from '../lib/paneDrag'
import { movePaneToTab } from '../lib/paneToTab'
import { MAIN_PANE, paneIds } from '../lib/splitTree'
import { useTerminalStore } from '../stores/terminalStore'
import { toast } from '../stores/toastStore'

/** The tab strips a pane can be dropped on (single view, and each side of the split view) */
const TAB_STRIPS = '.terminal-tabs, .split-pane-header'
const TARGET_CLASS = 'pane-drop-target'

/**
 * A split pane dragged by its grip onto a tab strip becomes a tab (its shell as it is).
 * Listens on the document in the capture phase: the strips have their own drop handling for tabs,
 * which must not see a pane's drop.
 */
export function usePaneDropOnTabs(): void {
  useEffect(() => {
    let marked: Element | null = null
    const mark = (strip: Element | null) => {
      if (marked === strip) return
      marked?.classList.remove(TARGET_CLASS)
      strip?.classList.add(TARGET_CLASS)
      marked = strip
    }
    const stripOf = (event: DragEvent): Element | null => {
      if (!event.dataTransfer || !isPaneDrag(event.dataTransfer.types)) return null
      const drag = currentPaneDrag()
      if (!drag) return null
      const tree = useTerminalStore.getState().terminals.get(drag.sessionId)?.splitTree
      if (drag.pane === MAIN_PANE && (!tree || paneIds(tree).length < 2)) return null
      return event.target instanceof Element ? event.target.closest(TAB_STRIPS) : null
    }

    const onDragOver = (event: DragEvent) => {
      const strip = stripOf(event)
      mark(strip)
      if (!strip || !event.dataTransfer) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
    }
    const onDrop = (event: DragEvent) => {
      const strip = stripOf(event)
      const drag = currentPaneDrag()
      mark(null)
      if (!strip || !drag) return
      event.preventDefault()
      event.stopPropagation()
      endPaneDrag()
      // In the split view each side has its own strip: the first one in the document is the primary side
      const strips = Array.from(document.querySelectorAll('.split-pane-header'))
      const side = strips.length < 2 || !strips.includes(strip) ? undefined : strips.indexOf(strip) === 0 ? 'primary' : 'secondary'
      void movePaneToTab(drag.sessionId, drag.pane, side).then((result) => {
        if (!result.ok) toast.error('탭으로 옮기지 못했습니다', result.error)
      }).catch(() => toast.error('탭으로 옮기지 못했습니다', '잠시 후 다시 시도해 주세요.'))
    }
    const onDragEnd = () => mark(null)

    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    document.addEventListener('dragend', onDragEnd, true)
    return () => {
      mark(null)
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
      document.removeEventListener('dragend', onDragEnd, true)
    }
  }, [])
}
