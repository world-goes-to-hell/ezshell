import { useCallback, useEffect, useMemo, useState, type DragEvent, type RefObject } from 'react'
import { RiCloseLine, RiMoreFill } from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import {
  layoutOf, leafAt, swapPanes, setRatio, equalizeAt, mergeVacant, paneBox, dividerBox,
  type PaneId, type DividerLine, type SplitAxis, type SplitLayout, type SplitNode
} from '../../lib/splitTree'
import { PANE_DRAG_TYPE, currentPaneDrag, startPaneDrag, endPaneDrag, isPaneDrag } from '../../lib/paneDrag'
import { zoneAt, canHalve, movePaneBeside, sideWord, TOO_NARROW, type DropZone } from '../../lib/paneDropZones'
import { PANE_GESTURE_CANCEL_RADIUS, usePaneGesture } from '../../hooks/usePaneGesture'

/** Where a dragged pane would go on the pane under the pointer, and whether it can */
interface PaneDropTarget { pane: PaneId; zone: DropZone; blocked: string | null }

function paneDropTarget(event: DragEvent, pane: PaneId): PaneDropTarget {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const zone = zoneAt({ x: rect.left, y: rect.top, w: rect.width, h: rect.height }, event.clientX, event.clientY, true)
  const blocked = zone !== 'center' && !canHalve(rect.width, rect.height, zone) ? TOO_NARROW : null
  return { pane, zone, blocked }
}

const dropLabel = (target: PaneDropTarget) =>
  target.blocked ?? (target.zone === 'center' ? '여기와 자리 바꾸기' : `이 칸의 ${sideWord(target.zone)}으로 옮기기`)

/** Width of the line between two panes */
export const PANE_DIVIDER_PX = 6
/** The grip appears when the pointer is this close to a pane's top edge */
const PANE_GRIP_ZONE_PX = 28

const refit = () => requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))

/** An input-transparent outline over the pane that just opened or moved. */
export function PaneArrival({ tabId, layout }: { tabId: string; layout?: SplitLayout }) {
  const arrival = useTerminalStore(state => state.terminals.get(tabId)?.paneArrival)
  if (!arrival) return null
  const rect = layout?.panes.find(({ pane }) => pane === arrival.pane)?.rect
  if (layout && !rect) return null

  return (
    <div
      key={arrival.seq}
      className="pane-arrival"
      data-pane-arrival={arrival.pane}
      style={rect ? paneBox(rect, PANE_DIVIDER_PX) : undefined}
      aria-hidden="true"
      onAnimationEnd={() => {
        const store = useTerminalStore.getState()
        if (store.terminals.get(tabId)?.paneArrival === arrival) {
          store.updateTerminalMeta(tabId, { paneArrival: undefined })
        }
      }}
    />
  )
}

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
  const drawnDivider = useTerminalStore(state => state.terminals.get(tabId)?.paneArrival?.dividerPath)
  const layout = useMemo(() => layoutOf(tree), [tree])
  const { canvas, preview, trail } = usePaneGesture(tabId, containerRef)
  // Grip of the pane whose top edge the pointer is near, the pane being dragged, the pane under it
  const [gripPane, setGripPane] = useState<PaneId | null>(null)
  const [dragPane, setDragPane] = useState<PaneId | null>(null)
  const [dropTarget, setDropTarget] = useState<PaneDropTarget | null>(null)
  const [resizingLine, setResizingLine] = useState<DividerLine | null>(null)

  // The grip shows for the pane whose top edge the pointer is near
  useEffect(() => {
    const container = containerRef.current
    if (!container || layout.dividers.length === 0) return
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
    const drag = { sessionId: tabId, pane }
    startPaneDrag(drag)
    // After the drag has started: changing the page inside dragstart can cancel the drag
    setTimeout(() => {
      if (currentPaneDrag() === drag) setDragPane(pane)
    }, 0)
  }, [tabId])

  const handleGripDragEnd = useCallback(() => {
    endPaneDrag()
    setDragPane(null)
    setDropTarget(null)
    setGripPane(null)
  }, [])

  // The drag also ends when its grip is gone before dragend: a pane dropped on a tab strip leaves the
  // tree at once, and a removed element never gets its dragend. The drop zones covered the panes then
  // and the shells under them could not be used (2026-11-20 user report, after merging the tab back).
  // A drop anywhere, a mouse move or press (none come during a drag), or the pane leaving ends it.
  useEffect(() => {
    if (!dragPane) return
    if (!layout.panes.some(entry => entry.pane === dragPane)) {
      handleGripDragEnd()
      return
    }
    const endSoon = () => window.setTimeout(handleGripDragEnd, 0)
    window.addEventListener('dragend', handleGripDragEnd, true)
    window.addEventListener('drop', endSoon, true)
    window.addEventListener('mousemove', handleGripDragEnd, true)
    window.addEventListener('pointerdown', handleGripDragEnd, true)
    return () => {
      window.removeEventListener('dragend', handleGripDragEnd, true)
      window.removeEventListener('drop', endSoon, true)
      window.removeEventListener('mousemove', handleGripDragEnd, true)
      window.removeEventListener('pointerdown', handleGripDragEnd, true)
    }
  }, [dragPane, layout, handleGripDragEnd])

  // The panes keep their shells; only their places change, so every terminal is fitted again.
  // In the middle of a pane the two trade places; near a side the dragged pane leaves its place and
  // takes that half of the pane.
  const handlePaneDrop = useCallback((event: DragEvent, target: PaneId) => {
    event.preventDefault()
    event.stopPropagation()
    const drop = paneDropTarget(event, target)
    if (dragPane && dragPane !== target && !drop.blocked) {
      const next = drop.zone === 'center' ? swapPanes(tree, dragPane, target) : movePaneBeside(tree, dragPane, target, drop.zone)
      if (next !== tree) {
        setSplitTree(tabId, next, dragPane)
        refit()
      }
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

  const cancelTarget = preview?.cancelTarget
  const from = preview && !cancelTarget?.active && layout.panes.find(entry => entry.pane === preview.from)?.rect
  const action = preview?.action
  const merge = action?.kind === 'merge' ? action : null
  const to = merge && layout.panes.find(entry => entry.pane === merge.to)?.rect
  const split = action?.kind === 'split' ? action : null
  const closing = action?.kind === 'close'
  const gesture = (
    <>
      <canvas ref={canvas} className={`pane-merge-trail${trail ? ` is-${trail}` : ''}`} aria-hidden="true" />
      {from && !closing && <div className="pane-merge-preview is-source" style={paneBox(from, PANE_DIVIDER_PX)} aria-hidden="true" />}
      {from && closing && <div className="pane-merge-preview is-closing" style={paneBox(from, PANE_DIVIDER_PX)} aria-hidden="true"><span>놓으면 이 칸을 닫습니다 · Esc 취소</span></div>}
      {merge && <div className="pane-merge-preview is-area" style={paneBox(merge.expanded, PANE_DIVIDER_PX)} aria-hidden="true" />}
      {to && <div className="pane-merge-preview is-destination" style={paneBox(to, PANE_DIVIDER_PX)} aria-hidden="true"><span>놓으면 이 셸을 닫습니다</span></div>}
      {from && split && <div className={`pane-gesture-divider is-${split.axis}`} style={dividerBox({ ...split, path: '', region: from }, PANE_DIVIDER_PX)} aria-hidden="true" />}
      {cancelTarget && (
        <>
          <div
            className={`pane-gesture-cancel-target${cancelTarget.active ? ' is-active' : ''}`}
            style={{ left: cancelTarget.x, top: cancelTarget.y, width: PANE_GESTURE_CANCEL_RADIUS * 2, height: PANE_GESTURE_CANCEL_RADIUS * 2 }}
            aria-hidden="true"
          >
            <RiCloseLine size={18} />
          </div>
          <span
            className={`pane-gesture-cancel-label${cancelTarget.above ? ' is-above' : ''}`}
            style={{ left: cancelTarget.labelX, top: cancelTarget.y + (cancelTarget.above ? -1 : 1) * (PANE_GESTURE_CANCEL_RADIUS + 6) }}
            role="status"
          >
            {cancelTarget.active ? '놓으면 취소' : '시작점에서 취소'}
          </span>
        </>
      )}
    </>
  )

  return (
    <>
      {gesture}
      {tree.kind === 'split' && <>
      {/* One line per division of the split tree */}
      {layout.dividers.map(line => (
        <div
          key={`divider-${line.path}`}
          className={`pane-divider ${line.axis === 'row' ? 'pane-divider-v' : 'pane-divider-h'}${drawnDivider === line.path ? ' is-drawing' : ''}`}
          style={dividerBox(line, PANE_DIVIDER_PX)}
          title="끌어서 크기 조절 · 두 번 눌러 양쪽을 같은 크기로"
          onMouseDown={(event) => { event.preventDefault(); setResizingLine(line) }}
          onDoubleClick={() => { setSplitTree(tabId, equalizeAt(tree, line.path)); refit() }}
        />
      ))}
      <PaneArrival tabId={tabId} layout={layout} />
      {/* The place of a pane whose shell became a tab: it stays empty until a neighbour takes it */}
      {layout.vacants.map(({ pane, rect }) => {
        const mergeTo = (axis: SplitAxis) => mergeVacant(tree, pane, axis)
        const sideways = mergeTo('row')
        const upDown = mergeTo('col')
        return (
          <div key={`vacant-${pane}`} className="pane-vacant" data-vacant={pane} style={paneBox(rect, PANE_DIVIDER_PX)}>
            <span className="pane-vacant-text">빈 칸</span>
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
            title="끌어서 다른 칸과 자리 바꾸기 · 탭 줄에 놓으면 새 탭으로 · Alt+본문 드래그로 분할·병합"
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
          className={`pane-drop-zone${dropTarget?.pane === pane ? ' is-over' : ''}${dropTarget?.pane === pane && dropTarget.blocked ? ' is-blocked' : ''}`}
          data-drop-zone={dropTarget?.pane === pane ? dropTarget.zone : undefined}
          style={paneBox(rect, PANE_DIVIDER_PX)}
          onDragOver={(event) => {
            if (!isPaneDrag(event.dataTransfer.types)) return
            event.preventDefault()
            event.stopPropagation()
            const next = paneDropTarget(event, pane)
            event.dataTransfer.dropEffect = next.blocked ? 'none' : 'move'
            setDropTarget(current => (current && current.pane === next.pane && current.zone === next.zone && current.blocked === next.blocked ? current : next))
          }}
          onDragLeave={() => setDropTarget(current => (current?.pane === pane ? null : current))}
          onDrop={(event) => handlePaneDrop(event, pane)}
        >
          {/* The part of the pane the dragged one would take (all of it: swap) */}
          {dropTarget?.pane === pane
            ? <div className="pane-drop-preview"><span>{dropLabel(dropTarget)}</span></div>
            : <span>가운데: 자리 바꾸기 · 가장자리: 그쪽으로 옮기기</span>}
        </div>
      ))}
      </>}
    </>
  )
}
