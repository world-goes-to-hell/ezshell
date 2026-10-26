import { useEffect } from 'react'
import { RiPulseLine } from 'react-icons/ri'
import { PopoutTitleBar } from '../TitleBar/PopoutTitleBar'
import { usePopoutTheme } from '../../hooks/usePopoutTheme'
import { useMcpActivityFeed } from '../../hooks/useMcpActivityFeed'
import { McpActivityPanel } from './McpActivityPanel'
import './McpActivity.css'

/**
 * The MCP activity panel in a window of its own. It reads the activity list from the main process
 * like the main window does; the main process closes it when the app locks.
 */
export function McpActivityWindow() {
  usePopoutTheme()
  useMcpActivityFeed()

  useEffect(() => {
    document.title = 'MCP 활동 - ezShell'
  }, [])

  return (
    <div className="mcp-activity-window">
      <PopoutTitleBar icon={<RiPulseLine size={16} />} title="MCP 활동" />
      <McpActivityPanel variant="window" />
    </div>
  )
}
