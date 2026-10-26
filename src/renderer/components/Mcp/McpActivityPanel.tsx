import { useEffect, useState } from 'react'
import { RiCloseLine, RiExternalLinkLine, RiStopCircleLine } from 'react-icons/ri'
import type { McpActivityItem } from '../../types'
import { useMcpActivityStore } from '../../stores/mcpActivityStore'
import type { McpActivityView } from '../../stores/mcpActivityStore'
import { ACTIVITY_STATE_LABELS, collapsesMcpPanel, countActive, formatClock, formatElapsed, isActiveState } from '../../lib/mcpActivity'
import { RISK_LABELS, revealHiddenChars } from '../../lib/mcpLabels'
import { McpActivityLanes } from './McpActivityLanes'
import { McpActivityTerminal } from './McpActivityTerminal'
import { stopMcpRequest } from './stopMcpRequest'
import { McpTransferBar } from './McpTransferBar'
import { toast } from '../../stores/toastStore'
import './Mcp.css'

const TICK_MS = 1000
const VIEWS: ReadonlyArray<{ id: McpActivityView; label: string }> = [
  { id: 'list', label: '목록' },
  { id: 'terminal', label: '터미널' },
  { id: 'lanes', label: '서버별' }
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
            {item.background && <span className="mcp-job-tag">백그라운드</span>}
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
      {item.transfer && <McpTransferBar transfer={item.transfer} state={item.state} now={now} />}
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

/**
 * `overlay`: the panel over the main window, opened from the status bar; it slides aside on a press behind it.
 * `window`: the whole content of the popped-out MCP activity window, which has its own title bar.
 */
export function McpActivityPanel({ variant = 'overlay' }: { variant?: 'overlay' | 'window' }) {
  const isWindow = variant === 'window'
  const items = useMcpActivityStore(state => state.items)
  const setPanelOpen = useMcpActivityStore(state => state.setPanelOpen)
  const view = useMcpActivityStore(state => state.view)
  const setView = useMcpActivityStore(state => state.setView)
  const isCollapsed = useMcpActivityStore(state => state.isPanelCollapsed) && !isWindow
  const setCollapsed = useMcpActivityStore(state => state.setPanelCollapsed)
  const canPopOut = !isWindow && typeof window.electronAPI?.openMcpActivityWindow === 'function'
  const [now, setNow] = useState(() => Date.now())
  const hasActive = items.some(item => isActiveState(item.state))
  const { waiting, running } = countActive(items)

  useEffect(() => {
    if (!hasActive) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [hasActive])

  // While collapsed, Esc belongs to the shell (vim and the like), not to the panel
  useEffect(() => {
    if (isWindow || isCollapsed) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setPanelOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isWindow, isCollapsed, setPanelOpen])

  // A press on the shell or SFTP behind the panel slides it aside. Capture phase, so a terminal that
  // stops the event still counts; the press itself goes on to the shell as usual.
  useEffect(() => {
    if (isWindow || isCollapsed) return
    const onPointerDown = (event: PointerEvent) => {
      if (collapsesMcpPanel(event.target instanceof Element ? event.target : null)) setCollapsed(true)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [isWindow, isCollapsed, setCollapsed])

  const openInWindow = async () => {
    try {
      const result = await window.electronAPI.openMcpActivityWindow?.()
      if (result?.success) {
        setPanelOpen(false)
        return
      }
      toast.error('MCP 활동', result?.error ?? '새 창을 열지 못했습니다.')
    } catch {
      toast.error('MCP 활동', '새 창을 열지 못했습니다.')
    }
  }

  return (
    <aside className={`mcp-activity-panel view-${view}${isCollapsed ? ' is-collapsed' : ''}${isWindow ? ' is-window' : ''}`} id="mcp-activity-panel" role="complementary" aria-label="MCP 활동">
      {isCollapsed && (
        <button type="button" className="mcp-activity-strip" onClick={() => setCollapsed(false)} aria-label="MCP 활동 펼치기" title="MCP 활동 펼치기">
          {waiting > 0 && <span className="mcp-activity-strip-count is-waiting" title={`확인 대기 ${waiting}`}>{waiting}</span>}
          {running > 0 && <span className="mcp-activity-strip-count is-running" title={`실행 중 ${running}`}>{running}</span>}
          <span className="mcp-activity-strip-label">MCP 활동</span>
        </button>
      )}
      {/* Off screen while collapsed: kept mounted so scroll positions survive, but out of reach of Tab */}
      <div className="mcp-activity-body" inert={isCollapsed}>
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
          {canPopOut && (
            <button type="button" className="mcp-icon-btn" onClick={() => void openInWindow()} aria-label="MCP 활동 새 창으로 열기" title="새 창으로 열기">
              <RiExternalLinkLine size={16} />
            </button>
          )}
          {!isWindow && (
            <button type="button" className="mcp-icon-btn" onClick={() => setPanelOpen(false)} aria-label="MCP 활동 닫기" title="닫기 (Esc)">
              <RiCloseLine size={18} />
            </button>
          )}
        </div>
      </header>
      {items.length === 0 ? (
        <p className="mcp-activity-empty">아직 MCP 요청이 없습니다.</p>
      ) : view === 'terminal' ? (
        <McpActivityTerminal items={items} now={now} />
      ) : view === 'lanes' ? (
        <McpActivityLanes items={items} now={now} />
      ) : (
        <ul className="mcp-activity-list">
          {items.map(item => <ActivityRow key={item.id} item={item} now={now} />)}
        </ul>
      )}
      </div>
    </aside>
  )
}
