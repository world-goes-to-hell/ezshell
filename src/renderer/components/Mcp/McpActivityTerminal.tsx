import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import { RiStopCircleLine } from 'react-icons/ri'
import type { McpActivityItem } from '../../types'
import { ACTIVITY_STATE_LABELS, cleanTerminalText, formatClock, formatDuration, formatElapsed, hasRun, isActiveState } from '../../lib/mcpActivity'
import { RISK_LABELS, revealHiddenChars } from '../../lib/mcpLabels'
import { stopMcpRequest } from './stopMcpRequest'

/** Keep following new output only while the view is scrolled to (about) the bottom */
const FOLLOW_THRESHOLD_PX = 24
const WAITING_TEXT = '앱에서 확인을 기다리는 중입니다.'

function statusText(item: McpActivityItem, now: number): string {
  const label = ACTIVITY_STATE_LABELS[item.state] ?? item.state
  if (isActiveState(item.state)) return `${label} · ${formatElapsed(now - item.startedAt)}`
  return [
    label,
    item.exitCode != null ? `종료 코드 ${item.exitCode}` : null,
    item.finishedAt != null ? formatDuration(item.finishedAt - item.startedAt) : null,
    item.truncated ? '출력 일부만 표시' : null
  ].filter(Boolean).join(' · ')
}

/** One request: a prompt line, what the command printed, then how it ended. */
const TerminalEntry = memo(function TerminalEntry({ item, now }: { item: McpActivityItem; now: number }) {
  const active = isActiveState(item.state)
  const command = revealHiddenChars(item.command).text
  const parts = item.outputParts ?? []
  // A request that never reached the server has a reason instead of output
  const notice = !active && !hasRun(item) ? (item.output ?? item.error ?? null) : null
  const hasFailedExit = item.exitCode != null && item.exitCode !== 0

  return (
    <li className={`mcp-term-entry state-${item.state}`}>
      <div className="mcp-term-prompt">
        <span className="mcp-term-session">{item.sessionName}</span>
        {item.cwd && <span className="mcp-term-cwd">{cleanTerminalText(item.cwd)}</span>}
        <span className="mcp-term-sigil" aria-hidden="true">$</span>
        <code className="mcp-term-command">{command}</code>
        {item.level !== 'low' && <span className={`mcp-risk mcp-risk-${item.level}`}>{RISK_LABELS[item.level] ?? item.level}</span>}
        <time className="mcp-term-time">{formatClock(item.time)}</time>
      </div>
      {parts.length > 0 && (
        <pre className="mcp-term-output">
          {parts.map((part, index) => (
            <span key={index} className={part.stream === 'stderr' ? 'mcp-term-stderr' : undefined}>{cleanTerminalText(part.text)}</span>
          ))}
        </pre>
      )}
      {item.state === 'waiting' && <p className="mcp-term-notice">{WAITING_TEXT}</p>}
      {notice && <p className="mcp-term-notice mcp-term-notice-stopped">{notice}</p>}
      <div className="mcp-term-status">
        <span className={`mcp-term-state mcp-term-state-${item.state}${hasFailedExit ? ' has-failed-exit' : ''}`}>{statusText(item, now)}</span>
        {active && (
          <button type="button" className="mcp-term-stop" onClick={() => stopMcpRequest(item.id)} title="이 요청 중지">
            <RiStopCircleLine size={13} aria-hidden="true" />
            <span>중지</span>
          </button>
        )}
      </div>
    </li>
  )
})

/** Every MCP request as one continuous, read-only log: oldest at the top, newest at the bottom. */
export function McpActivityTerminal({ items, now }: { items: McpActivityItem[]; now: number }) {
  const scrollRef = useRef<HTMLOListElement>(null)
  const isFollowing = useRef(true)
  const oldestFirst = useMemo(() => [...items].reverse(), [items])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && isFollowing.current) element.scrollTop = element.scrollHeight
  }, [items])

  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    isFollowing.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX
  }

  return (
    <ol className="mcp-term" ref={scrollRef} onScroll={onScroll} aria-label="MCP 명령 기록" aria-live="off" tabIndex={0}>
      {oldestFirst.map(item => (
        // Finished entries get a constant `now`, so the one-second tick re-renders only the active ones
        <TerminalEntry key={item.id} item={item} now={isActiveState(item.state) ? now : 0} />
      ))}
    </ol>
  )
}
