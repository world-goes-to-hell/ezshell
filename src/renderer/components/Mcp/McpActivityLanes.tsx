import { useId, useMemo } from 'react'
import { RiCloseLine } from 'react-icons/ri'
import type { McpActivityItem } from '../../types'
import { groupBySession, isActiveState, isLaneHidden } from '../../lib/mcpActivity'
import type { McpActivityLane } from '../../lib/mcpActivity'
import { useMcpActivityStore } from '../../stores/mcpActivityStore'
import { TerminalEntry, useFollowBottom } from './McpActivityTerminal'

/** One session's requests as its own log, with its own scroll position. */
function Lane({ lane, now, onHide }: { lane: McpActivityLane; now: number; onHide: () => void }) {
  const { scrollRef, onScroll } = useFollowBottom<HTMLOListElement>(lane.items)
  const isActive = lane.waiting + lane.running > 0
  const titleId = useId()

  return (
    <section className={`mcp-lane${isActive ? ' is-active' : ''}`} aria-labelledby={titleId}>
      <header className="mcp-lane-header">
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
  const lanes = useMemo(() => groupBySession(items), [items])
  const visible = lanes.filter(lane => !isLaneHidden(lane, hiddenLanes))
  const hiddenCount = lanes.length - visible.length
  const shown = isActiveOnly ? visible.filter(lane => lane.waiting + lane.running > 0) : visible
  const emptyText = hiddenCount > 0 && !isActiveOnly
    ? '모든 서버를 숨겼습니다. 새 요청이 오면 다시 보입니다.'
    : '지금 작업 중인 서버가 없습니다.'

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
          {shown.map(lane => <Lane key={lane.sessionId} lane={lane} now={now} onHide={() => hideLane(lane)} />)}
        </div>
      )}
    </div>
  )
}
