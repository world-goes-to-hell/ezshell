import { useCallback, useEffect, useMemo, useState, type DragEvent, type RefObject } from 'react'
import { RiMoreFill } from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import {
  MAIN_PANE, layoutOf, leafAt, swapPanes, setRatio, equalizeAt, mergeVacant, paneBox, dividerBox,
  type PaneId, type DividerLine, type SplitAxis, type SplitNode
} from '../../lib/splitTree'
import { PANE_DRAG_TYPE, startPaneDrag, endPaneDrag, isPaneDrag } from '../../lib/paneDrag'

/** Width of the line between two panes */
export const PANE_DIVIDER_PX = 6
/** The grip appears when the pointer is this close to a pane's top edge */
const PANE_GRIP_ZONE_PX = 28

const refit = () => requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))

interface SplitChromeProps {
  /** The tab whose split tree this is (an SSH tab or a local terminal tab) */
  tabId: string
  tree: SplitNode
  /** The element the panes are placed in; pointer positions are measured against it */
  containerRef: RefObject<HTMLDivElement | null>
}

/**
 * Everything of a split tab that is not a terminal: the divider lines (drag to resize, double-click
 * to even out), the grip on each pane's top edge (drag onto another pane to swap, onto a tab strip
 * to make it a tab), the drop zones shown during such a drag, and the empty places of panes that
 * became tabs. All are flat children of the split container, placed by the tree's rectangles.
 */
export function SplitChrome({ tabId, tree, containerRef }: SplitChromeProps) {
  const setSplitTree = useTerminalStore(state => state.setSplitTree)
  const layout = useMemo(() => layoutOf(tree), [tree])
  // Grip of the pane whose top edge the pointer is near, the pane being dragged, the pane under it
  const [gripPane, setGripPane] = useState<PaneId | null>(null)
  const [dragPane, setDragPane] = useState<PaneId | null>(null)
  const [dropPane, setDropPane] = useState<PaneId | null>(null)
  const [resizingLine, setResizingLine] = useState<DividerLine | null>(null)

  // The grip shows for the pane whose top edge the pointer is near
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const leaf = leafAt(layout, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
      const isNearTop = !!leaf && !leaf.isVacant && event.clientY - rect.top - leaf.rect.y * rect.height < PANE_GRIP_ZONE_PX
      setGripPane(isNearTop && leaf ? leaf.pane : null)
    }
    const onLeave = () => setGripPane(null)
    container.addEventListener('mousemove', onMove)
    container.addEventListener('mouseleave', onLeave)
    return () => {
      container.removeEventListener('mousemove', onMove)
      container.removeEventListener('mouseleave', onLeave)
    }
  }, [containerRef, layout])

  const handleGripDragStart = useCallback((event: DragEvent, pane: PaneId) => {
    event.stopPropagation()
    event.dataTransfer.setData(PANE_DRAG_TYPE, JSON.stringify({ sessionId: tabId, pane }))
    event.dataTransfer.effectAllowed = 'move'
    startPaneDrag({ sessionId: tabId, pane })
    // After the drag has started: changing the page inside dragstart can cancel the drag
    setTimeout(() => setDragPane(pane), 0)
  }, [tabId])

  const handleGripDragEnd = useCallback(() => {
    endPaneDrag()
    setDragPane(null)
    setDropPane(null)
    setGripPane(null)
  }, [])

  // The panes keep their shells; only their places change, so every terminal is fitted again
  const handlePaneDrop = useCallback((event: DragEvent, target: PaneId) => {
    event.preventDefault()
    event.stopPropagation()
    if (dragPane && dragPane !== target) {
      setSplitTree(tabId, swapPanes(tree, dragPane, target))
      refit()
    }
    handleGripDragEnd()
  }, [dragPane, tree, tabId, setSplitTree, handleGripDragEnd])

  // Dragging a divider line moves that one division; the tree is read fresh on every move
  useEffect(() => {
    if (!resizingLine) return

    const handleMouseMove = (event: MouseEvent) => {
      const container = containerRef.current
      const current = useTerminalStore.getState().terminals.get(tabId)?.splitTree
      if (!container || !current) return
      const rect = container.getBoundingClientRect()
      const { region, axis, path } = resizingLine
      const ratio = axis === 'row'
        ? ((event.clientX - rect.left) / rect.width - region.x) / region.w
        : ((event.clientY - rect.top) / rect.height - region.y) / region.h
      setSplitTree(tabId, setRatio(current, path, ratio))
    }

    const handleMouseUp = () => {
      setResizingLine(null)
      document.body.classList.remove('resizing')
      window.dispatchEvent(new Event('resize'))
    }

    document.body.classList.add('resizing')
    window.addEventListener('mousemove', handleMouseMove, true)
    window.addEventListener('mouseup', handleMouseUp, true)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove, true)
      window.removeEventListener('mouseup', handleMouseUp, true)
    }
  }, [resizingLine, tabId, setSplitTree, containerRef])

  const mergeInto = (merged: SplitNode | null) => {
    if (!merged) return
    setSplitTree(tabId, merged)
    refit()
  }

  return (
    <>
      {/* One line per division of the split tree */}
      {layout.dividers.map(line => (
        <div
          key={`divider-${line.path}`}
          className={`pane-divider ${line.axis === 'row' ? 'pane-divider-v' : 'pane-divider-h'}`}
          style={dividerBox(line, PANE_DIVIDER_PX)}
          title="끌어서 크기 조절 · 두 번 눌러 양쪽을 같은 크기로"
          onMouseDown={(event) => { event.preventDefault(); setResizingLine(line) }}
          onDoubleClick={() => { setSplitTree(tabId, equalizeAt(tree, line.path)); refit() }}
        />
      ))}
      {/* The place of a pane whose shell became a tab: it stays empty until a neighbour takes it */}
      {layout.vacants.map(({ pane, rect }) => {
        const mergeTo = (axis: SplitAxis) => mergeVacant(tree, pane, axis)
        const sideways = mergeTo('row')
        const upDown = mergeTo('col')
        return (
          <div key={`vacant-${pane}`} className="pane-vacant" style={paneBox(rect, PANE_DIVIDER_PX)}>
            <span className="pane-vacant-text">탭으로 옮긴 칸입니다</span>
            <div className="pane-vacant-actions">
              <button type="button" className="pane-vacant-btn" disabled={!sideways} onClick={() => mergeInto(sideways)}
                title={sideways ? '옆 칸이 이 자리까지 넓어집니다' : '옆에 넓힐 수 있는 칸이 없습니다'}>
                가로로 병합
              </button>
              <button type="button" className="pane-vacant-btn" disabled={!upDown} onClick={() => mergeInto(upDown)}
                title={upDown ? '위나 아래 칸이 이 자리까지 넓어집니다' : '위아래에 넓힐 수 있는 칸이 없습니다'}>
                세로로 병합
              </button>
            </div>
          </div>
        )
      })}
      {/* Grip on the top edge of each pane */}
      {layout.panes.map(({ pane, rect }) => (
        <div key={`grip-${pane}`} className="pane-grip-area" style={paneBox(rect, PANE_DIVIDER_PX)}>
          <div
            className={`pane-grip${gripPane === pane || dragPane === pane ? ' is-shown' : ''}`}
            draggable
            title={pane === MAIN_PANE ? '끌어서 다른 칸과 자리 바꾸기' : '끌어서 다른 칸과 자리 바꾸기 · 탭 줄에 놓으면 새 탭으로'}
            aria-hidden="true"
            onDragStart={(event) => handleGripDragStart(event, pane)}
            onDragEnd={handleGripDragEnd}
          >
            <RiMoreFill size={16} />
          </div>
        </div>
      ))}
      {/* While a pane is dragged, every other pane is a place to drop it (the terminals themselves
          would swallow the drag events) */}
      {dragPane && layout.panes.filter(entry => entry.pane !== dragPane).map(({ pane, rect }) => (
        <div
          key={`drop-${pane}`}
          className={`pane-drop-zone${dropPane === pane ? ' is-over' : ''}`}
          style={paneBox(rect, PANE_DIVIDER_PX)}
          onDragOver={(event) => {
            if (!isPaneDrag(event.dataTransfer.types)) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'move'
            setDropPane(pane)
          }}
          onDragLeave={() => setDropPane(current => (current === pane ? null : current))}
          onDrop={(event) => handlePaneDrop(event, pane)}
        >
          <span>여기와 자리 바꾸기</span>
        </div>
      ))}
    </>
  )
}
