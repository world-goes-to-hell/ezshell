import { useEffect, useState } from 'react'
import { RiCloseLine, RiStopCircleLine } from 'react-icons/ri'
import type { McpActivityItem } from '../../types'
import { useMcpActivityStore } from '../../stores/mcpActivityStore'
import type { McpActivityView } from '../../stores/mcpActivityStore'
import { ACTIVITY_STATE_LABELS, formatClock, formatElapsed, isActiveState } from '../../lib/mcpActivity'
import { RISK_LABELS, revealHiddenChars } from '../../lib/mcpLabels'
import { McpActivityTerminal } from './McpActivityTerminal'
import { stopMcpRequest } from './stopMcpRequest'
import './Mcp.css'

const TICK_MS = 1000
const VIEWS: ReadonlyArray<{ id: McpActivityView; label: string }> = [
  { id: 'list', label: '목록' },
  { id: 'terminal', label: '터미널' }
]

function ActivityRow({ item, now }: { item: McpActivityItem; now: number }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const active = isActiveState(item.state)
  const command = revealHiddenChars(item.command).text
  const detailId = `mcp-activity-detail-${item.id}`

  return (
    <li className={`mcp-activity-item state-${item.state}`}>
      <div className="mcp-activity-row">
        <button
          type="button"
          className="mcp-activity-summary"
          onClick={() => setIsExpanded(value => !value)}
          aria-expanded={isExpanded}
          aria-controls={detailId}
        >
          <span className="mcp-activity-meta">
            <span className="mcp-activity-time">{formatClock(item.time)}</span>
            <span className="mcp-activity-session" title={item.sessionName}>{item.sessionName}</span>
            <span className={`mcp-risk mcp-risk-${item.level}`}>{RISK_LABELS[item.level] ?? item.level}</span>
            <span className={`mcp-activity-state mcp-activity-state-${item.state}`}>{ACTIVITY_STATE_LABELS[item.state] ?? item.state}</span>
            <span className="mcp-activity-extra">
              {active
                ? formatElapsed(now - item.startedAt)
                : item.exitCode != null && `종료 코드 ${item.exitCode}`}
            </span>
          </span>
          <code className="mcp-activity-command" title={command}>{command}</code>
        </button>
        {active && (
          <button type="button" className="mcp-activity-stop" onClick={() => stopMcpRequest(item.id)} title="이 요청 중지">
            <RiStopCircleLine size={14} aria-hidden="true" />
            <span>중지</span>
          </button>
        )}
      </div>
      {isExpanded && (
        <div className="mcp-activity-detail" id={detailId}>
          {item.reasons.length > 0 && (
            <ul className="mcp-activity-reasons">
              {item.reasons.map(reason => <li key={reason}>{reason}</li>)}
            </ul>
          )}
          {item.error && <p className="mcp-error">{item.error}</p>}
          <pre className="mcp-activity-output">{item.output ?? '아직 출력이 없습니다.'}</pre>
        </div>
      )}
    </li>
  )
}

export function McpActivityPanel() {
  const items = useMcpActivityStore(state => state.items)
  const setPanelOpen = useMcpActivityStore(state => state.setPanelOpen)
  const view = useMcpActivityStore(state => state.view)
  const setView = useMcpActivityStore(state => state.setView)
  const [now, setNow] = useState(() => Date.now())
  const hasActive = items.some(item => isActiveState(item.state))

  useEffect(() => {
    if (!hasActive) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [hasActive])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setPanelOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setPanelOpen])

  return (
    <aside className={`mcp-activity-panel view-${view}`} id="mcp-activity-panel" role="complementary" aria-label="MCP 활동">
      <header className="mcp-activity-header">
        <div>
          <h2>MCP 활동</h2>
          <p>출력은 앱이 켜져 있는 동안만 보관합니다.</p>
        </div>
        <div className="mcp-activity-tools">
          <div className="mcp-activity-views" role="group" aria-label="보기 방식">
            {VIEWS.map(option => (
              <button
                key={option.id}
                type="button"
                className={`mcp-activity-view-btn${view === option.id ? ' is-active' : ''}`}
                aria-pressed={view === option.id}
                onClick={() => setView(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="button" className="mcp-icon-btn" onClick={() => setPanelOpen(false)} aria-label="MCP 활동 닫기" title="닫기 (Esc)">
            <RiCloseLine size={18} />
          </button>
        </div>
      </header>
      {items.length === 0 ? (
        <p className="mcp-activity-empty">아직 MCP 요청이 없습니다.</p>
      ) : view === 'terminal' ? (
        <McpActivityTerminal items={items} now={now} />
      ) : (
        <ul className="mcp-activity-list">
          {items.map(item => <ActivityRow key={item.id} item={item} now={now} />)}
        </ul>
      )}
    </aside>
  )
}
