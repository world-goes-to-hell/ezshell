import { useState } from 'react'
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
import { countSshTabs } from '../../lib/sessionTabs'
import { ByteDaemonStatus } from '../ByteDaemon/ByteDaemonStatus'

export function Footer() {
  const terminals = useTerminalStore(state => state.terminals)
  const [zoomOpen, setZoomOpen] = useState(false)
  // SSH connections only: a DB tab rides on one of them
  const { connected, reconnecting, disconnected } = countSshTabs(terminals)
  const offlineIconClass = reconnecting > 0 ? 'footer-reconnecting' : disconnected > 0 ? 'footer-connection-lost' : ''

  return (
    <footer className="app-footer">
      <div className="footer-left">
        <div className="footer-status">
          {connected > 0
            ? <RiWifiFill size={16} className="status-icon connected" aria-hidden="true" />
            : <RiWifiOffFill size={16} className={`status-icon ${offlineIconClass}`} aria-hidden="true" />}
          {connected + reconnecting + disconnected > 0 ? (
            <span>
              {connected} 연결
              {reconnecting > 0 && <> · <span className="footer-reconnecting">{reconnecting} 재연결 중</span></>}
              {disconnected > 0 && <> · <span className="footer-connection-lost">{disconnected} 끊김</span></>}
            </span>
          ) : <span>연결 없음</span>}
        </div>
        <DbIndicator />
        {/* Usage reports of the agents; each local terminal shows its own below it (AgentPaneUsage) */}
        <AgentUsageFeed />
      </div>
      <div className="footer-right">
        <WorkspaceIndicator />
        <McpActivityIndicator />
        <OpacityStatus />
        <ZoomStatus open={zoomOpen} onOpenChange={setZoomOpen} />
        <VersionInfo />
        {/* The mini game hidden at the very end (docs/plan/2026-11-24-byte-daemon-mini-game.md) */}
        <ByteDaemonStatus />
      </div>
      <ZoomHud suppressed={zoomOpen} />
    </footer>
  )
}
