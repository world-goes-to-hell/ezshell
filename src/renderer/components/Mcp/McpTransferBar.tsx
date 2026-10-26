import { RiDownloadCloud2Line, RiUploadCloud2Line } from 'react-icons/ri'
import type { McpActivityState, McpTransferProgress } from '../../types'
import { describeTransfer } from '../../lib/mcpTransfer'

interface McpTransferBarProps {
  transfer: McpTransferProgress
  state: McpActivityState
  now: number
}

/** How far an upload_file / download_file request got: direction, amount, percent, speed, time left. */
export function McpTransferBar({ transfer, state, now }: McpTransferBarProps) {
  const view = describeTransfer(transfer, state, now)
  const details = view.status === 'done'
    ? [view.amount]
    : [view.amount, `${view.percent}%`, view.speed, view.remaining && `남은 시간 ${view.remaining}`].filter(Boolean)
  const Icon = transfer.direction === 'download' ? RiDownloadCloud2Line : RiUploadCloud2Line

  return (
    <div className={`mcp-transfer is-${view.status}`}>
      <div className="mcp-transfer-head">
        <span className="mcp-transfer-label">
          <Icon size={14} aria-hidden="true" />
          {view.label}
        </span>
        <span className="mcp-transfer-details">{details.join(' · ')}</span>
      </div>
      <div
        className="mcp-transfer-track"
        role="progressbar"
        aria-label={view.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.percent}
      >
        <div className="mcp-transfer-fill" style={{ transform: `scaleX(${view.percent / 100})` }} />
      </div>
    </div>
  )
}
