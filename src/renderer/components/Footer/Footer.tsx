import { useTerminalStore } from '../../stores/terminalStore'
import { RiWifiFill, RiWifiOffFill } from 'react-icons/ri'
import { VersionInfo } from '../Update/UpdateNotification'
import { ZoomStatus } from '../Zoom/ZoomStatus'
import { ZoomHud } from '../Zoom/ZoomHud'
import { McpActivityIndicator } from '../Mcp/McpActivityIndicator'

export function Footer() {
  const { terminals } = useTerminalStore()
  const activeConnections = terminals.size

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
      </div>
      <div className="footer-right">
        <McpActivityIndicator />
        <ZoomStatus />
        <VersionInfo />
      </div>
      <ZoomHud />
    </footer>
  )
}
