import { useId, useState } from 'react'
import { RiArrowDownSLine, RiArrowUpSLine, RiStopCircleLine } from 'react-icons/ri'
import type { McpActivityItem } from '../../types'
import { ACTIVITY_STATE_LABELS, formatElapsed } from '../../lib/mcpActivity'
import { revealHiddenChars } from '../../lib/mcpLabels'
import { lastOutputLines } from '../../lib/mcpPinned'
import { McpTransferBar } from './McpTransferBar'
import { stopMcpRequest } from './stopMcpRequest'

const NO_OUTPUT_TEXT = '아직 출력이 없습니다.'
const WAITING_TEXT = '앱에서 확인을 기다리는 중입니다.'

/** One request in progress: its command on one line, and the last lines it printed. */
function PinnedCard({ item, now }: { item: McpActivityItem; now: number }) {
  const [isOpen, setIsOpen] = useState(true)
  const bodyId = useId()
  const command = revealHiddenChars(item.command).text
  const lines = lastOutputLines(item.outputParts)

  return (
    <li className={`mcp-pinned-card state-${item.state}`}>
      <div className="mcp-pinned-head">
        <span className="mcp-term-session">{item.sessionName}</span>
        <code className="mcp-pinned-command" title={command}>{command}</code>
        <span className="mcp-pinned-state">{ACTIVITY_STATE_LABELS[item.state]} · {formatElapsed(now - item.startedAt)}</span>
        <button type="button" className="mcp-term-stop" onClick={() => stopMcpRequest(item.id)} title="이 요청 중지">
          <RiStopCircleLine size={13} aria-hidden="true" />
          <span>중지</span>
        </button>
        <button
          type="button"
          className="mcp-pinned-toggle"
          onClick={() => setIsOpen(value => !value)}
          aria-expanded={isOpen}
          aria-controls={bodyId}
          aria-label={isOpen ? '출력 접기' : '출력 펼치기'}
          title={isOpen ? '접기' : '펼치기'}
        >
          {isOpen ? <RiArrowUpSLine size={16} /> : <RiArrowDownSLine size={16} />}
        </button>
      </div>
      {isOpen && (
        <div className="mcp-pinned-body" id={bodyId}>
          {item.transfer ? (
            <McpTransferBar transfer={item.transfer} state={item.state} now={now} />
          ) : item.state === 'waiting' ? (
            <p className="mcp-pinned-line mcp-pinned-empty">{WAITING_TEXT}</p>
          ) : lines.length === 0 ? (
            <p className="mcp-pinned-line mcp-pinned-empty">{NO_OUTPUT_TEXT}</p>
          ) : (
            lines.map((line, index) => <p key={index} className="mcp-pinned-line" title={line}>{line}</p>)
          )}
        </div>
      )}
    </li>
  )
}

/** Requests in progress, kept above the log so that later commands do not push them out of sight. */
export function McpPinnedRequests({ items, now }: { items: McpActivityItem[]; now: number }) {
  if (items.length === 0) return null
  return (
    <ul className="mcp-pinned" aria-label="진행 중인 요청">
      {items.map(item => <PinnedCard key={item.id} item={item} now={now} />)}
    </ul>
  )
}
