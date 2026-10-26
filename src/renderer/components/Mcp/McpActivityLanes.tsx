import { useId, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { RiCloseLine, RiDraggable } from 'react-icons/ri'
import type { McpActivityItem } from '../../types'
import { groupBySession, isActiveState, isLaneHidden, moveLane, orderLanes } from '../../lib/mcpActivity'
import type { McpActivityLane } from '../../lib/mcpActivity'
import { useMcpActivityStore } from '../../stores/mcpActivityStore'
import { TerminalEntry, useFollowBottom } from './McpActivityTerminal'

/** Drag data of a lane; anything else dragged over a lane (tabs, files) is ignored */
const LANE_DRAG_TYPE = 'application/x-ezshell-mcp-lane'

const isLaneDrag = (event: DragEvent) => event.dataTransfer.types.includes(LANE_DRAG_TYPE)

interface LaneDrag {
  isDragging: boolean
  isDropTarget: boolean
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDragLeave: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onDragEnd: () => void
}

/** One session's requests as its own log, with its own scroll position. Dragged by its header. */
function Lane({ lane, now, onHide, drag }: { lane: McpActivityLane; now: number; onHide: () => void; drag: LaneDrag }) {
  const { scrollRef, onScroll } = useFollowBottom<HTMLOListElement>(lane.items)
  const isActive = lane.waiting + lane.running > 0
  const titleId = useId()
  const className = [
    'mcp-lane',
    isActive && 'is-active',
    drag.isDragging && 'is-dragging',
    drag.isDropTarget && 'is-drop-target'
  ].filter(Boolean).join(' ')

  return (
    <section
      className={className}
      aria-labelledby={titleId}
      onDragOver={drag.onDragOver}
      onDragLeave={drag.onDragLeave}
      onDrop={drag.onDrop}
    >
      <header className="mcp-lane-header" draggable onDragStart={drag.onDragStart} onDragEnd={drag.onDragEnd} title="끌어서 위치를 바꿀 수 있습니다">
        <RiDraggable className="mcp-lane-grip" size={14} aria-hidden="true" />
        <h3 className="mcp-lane-title" id={titleId} title={lane.sessionName}>{lane.sessionName}</h3>
        <span className="mcp-lane-counts">
          {lane.waiting > 0 && <span className="mcp-lane-count mcp-lane-count-waiting">확인 대기 {lane.waiting}</span>}
          {lane.running > 0 && <span className="mcp-lane-count mcp-lane-count-running">실행 중 {lane.running}</span>}
          {!isActive && <span className="mcp-lane-count">요청 {lane.items.length}개</span>}
          <button type="button" className="mcp-icon-btn mcp-lane-hide" onClick={onHide} aria-label={`${lane.sessionName} 영역 숨기기`} title="숨기기 (새 요청이 오면 다시 보입니다)">
            <RiCloseLine size={14} />
          </button>
        </span>
      </header>
      <ol className="mcp-term mcp-lane-log" ref={scrollRef} onScroll={onScroll} aria-label={`${lane.sessionName} 명령 기록`} aria-live="off" tabIndex={0}>
        {lane.items.map(item => (
          // Finished entries get a constant `now`, so the one-second tick re-renders only the active ones
          <TerminalEntry key={item.id} item={item} now={isActiveState(item.state) ? now : 0} />
        ))}
      </ol>
    </section>
  )
}

/** Every MCP request, split into one area per session so that work on several servers does not interleave. */
export function McpActivityLanes({ items, now }: { items: McpActivityItem[]; now: number }) {
  const isActiveOnly = useMcpActivityStore(state => state.isActiveOnly)
  const setActiveOnly = useMcpActivityStore(state => state.setActiveOnly)
  const hiddenLanes = useMcpActivityStore(state => state.hiddenLanes)
  const hideLane = useMcpActivityStore(state => state.hideLane)
  const showAllLanes = useMcpActivityStore(state => state.showAllLanes)
  const laneOrder = useMcpActivityStore(state => state.laneOrder)
  const setLaneOrder = useMcpActivityStore(state => state.setLaneOrder)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const grouped = useMemo(() => groupBySession(items), [items])
  const lanes = useMemo(() => orderLanes(grouped, laneOrder), [grouped, laneOrder])
  const visible = lanes.filter(lane => !isLaneHidden(lane, hiddenLanes))
  const hiddenCount = lanes.length - visible.length
  const shown = isActiveOnly ? visible.filter(lane => lane.waiting + lane.running > 0) : visible
  const emptyText = hiddenCount > 0 && !isActiveOnly
    ? '모든 서버를 숨겼습니다. 새 요청이 오면 다시 보입니다.'
    : '지금 작업 중인 서버가 없습니다.'

  const endDrag = () => {
    setDraggingId(null)
    setDropTargetId(null)
  }

  const dragFor = (lane: McpActivityLane): LaneDrag => ({
    isDragging: draggingId === lane.sessionId,
    isDropTarget: dropTargetId === lane.sessionId && draggingId !== lane.sessionId,
    onDragStart: (event) => {
      event.dataTransfer.setData(LANE_DRAG_TYPE, lane.sessionId)
      event.dataTransfer.effectAllowed = 'move'
      setDraggingId(lane.sessionId)
    },
    onDragOver: (event) => {
      if (!isLaneDrag(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (dropTargetId !== lane.sessionId) setDropTargetId(lane.sessionId)
    },
    onDragLeave: (event) => {
      // Moving onto a child of the lane also fires dragleave; only leaving the lane itself counts
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
      setDropTargetId(current => (current === lane.sessionId ? null : current))
    },
    onDrop: (event) => {
      if (!isLaneDrag(event)) return
      event.preventDefault()
      const fromId = event.dataTransfer.getData(LANE_DRAG_TYPE)
      if (fromId) setLaneOrder(moveLane(lanes, laneOrder, fromId, lane.sessionId))
      endDrag()
    },
    onDragEnd: endDrag
  })

  return (
    <div className="mcp-lanes">
      <div className="mcp-lanes-bar">
        <span className="mcp-lanes-summary">
          서버 {lanes.length}곳{isActiveOnly && ` 중 ${shown.length}곳 작업 중`}
          {hiddenCount > 0 && (
            <>
              {` · ${hiddenCount}곳 숨김`}
              <button type="button" className="mcp-lanes-show-all" onClick={showAllLanes}>모두 보기</button>
            </>
          )}
        </span>
        <label className="mcp-lanes-filter">
          <input type="checkbox" checked={isActiveOnly} onChange={event => setActiveOnly(event.target.checked)} />
          <span>작업 중만</span>
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="mcp-activity-empty">{emptyText}</p>
      ) : (
        <div className="mcp-lanes-grid">
          {shown.map(lane => <Lane key={lane.sessionId} lane={lane} now={now} onHide={() => hideLane(lane)} drag={dragFor(lane)} />)}
        </div>
      )}
    </div>
  )
}
