import { useTerminalStore } from '../../stores/terminalStore'
import { RiWifiFill, RiWifiOffFill } from 'react-icons/ri'
import { VersionInfo } from '../Update/UpdateNotification'
import { ZoomStatus } from '../Zoom/ZoomStatus'
import { ZoomHud } from '../Zoom/ZoomHud'
import { McpActivityIndicator } from '../Mcp/McpActivityIndicator'
import { WorkspaceIndicator } from '../Workspace/WorkspaceIndicator'
import { AgentUsageFeed } from '../AgentUsage/AgentUsageMeters'
import { OpacityStatus } from './OpacityStatus'
import { DbIndicator } from '../DbClient/DbIndicator'
import { isSshTab } from '../../lib/sessionTabs'

export function Footer() {
  const { terminals } = useTerminalStore()
  // SSH connections only: a DB tab rides on one of them
  const activeConnections = Array.from(terminals.values()).filter(isSshTab).length

  return (
    <footer className="app-footer">
      <div className="footer-left">
        <div className="footer-status">
          {activeConnections > 0 ? (
            <>
              <RiWifiFill size={16} className="status-icon connected" />
              <span>{activeConnections}개 연결됨</span>
            </>
          ) : (
            <>
              <RiWifiOffFill size={16} className="status-icon disconnected" />
              <span>연결 없음</span>
            </>
          )}
        </div>
        <DbIndicator />
        {/* Usage reports of the agents; each local terminal shows its own below it (AgentPaneUsage) */}
        <AgentUsageFeed />
      </div>
      <div className="footer-right">
        <WorkspaceIndicator />
        <McpActivityIndicator />
        <OpacityStatus />
        <ZoomStatus />
        <VersionInfo />
      </div>
      <ZoomHud />
    </footer>
  )
}
