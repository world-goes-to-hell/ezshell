import { useMcpActivityStore } from '../../stores/mcpActivityStore'
import { useMcpActivityFeed } from '../../hooks/useMcpActivityFeed'
import { countActive } from '../../lib/mcpActivity'
import { McpActivityPanel } from './McpActivityPanel'
import './McpActivity.css'

/** Status bar entry for MCP requests; renders nothing until the first request arrives. */
export function McpActivityIndicator() {
  useMcpActivityFeed()
  const items = useMcpActivityStore(state => state.items)
  const isOpen = useMcpActivityStore(state => state.isPanelOpen)
  const setPanelOpen = useMcpActivityStore(state => state.setPanelOpen)

  if (items.length === 0) return null

  const { waiting, running } = countActive(items)
  const parts = [waiting > 0 && `확인 대기 ${waiting}`, running > 0 && `실행 중 ${running}`].filter(Boolean)
  const isBusy = parts.length > 0

  return (
    <>
      <button
        type="button"
        className={`mcp-activity-indicator${isBusy ? ' busy' : ''}`}
        onClick={() => setPanelOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls="mcp-activity-panel"
        title="MCP 활동 보기"
      >
        {isBusy && <span className="mcp-activity-dot" aria-hidden="true" />}
        <span>{isBusy ? `MCP · ${parts.join(' · ')}` : 'MCP 활동'}</span>
      </button>
      {isOpen && <McpActivityPanel />}
    </>
  )
}
