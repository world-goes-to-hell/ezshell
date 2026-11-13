import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import { RiStopCircleLine } from 'react-icons/ri'
import type { McpActivityItem } from '../../types'
import { ACTIVITY_STATE_LABELS, cleanTerminalText, formatClock, formatDuration, formatElapsed, hasRun, isActiveState } from '../../lib/mcpActivity'
import { RISK_LABELS, revealHiddenChars } from '../../lib/mcpLabels'
import { formatShellCommand } from '../../lib/shellFormat'
import { ShellCommandText } from './ShellCommandText'
import { stopMcpRequest } from './stopMcpRequest'
import { pinnedRequests } from '../../lib/mcpPinned'
import { McpPinnedRequests } from './McpPinnedRequests'
import { McpTransferBar } from './McpTransferBar'
import { useMcpActivityStore } from '../../stores/mcpActivityStore'
import { hasWideCharacters, splitWideRuns } from '../../lib/terminalCells'

/** Keep following new output only while the view is scrolled to (about) the bottom */
const FOLLOW_THRESHOLD_PX = 24
const WAITING_TEXT = '앱에서 확인을 기다리는 중입니다.'
const TRIMMED_TEXT = '출력이 길어 앞부분은 표시하지 않습니다.'

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

/** Above this much text the wide characters are not sized one run at a time (it would make too many elements) */
const MAX_ALIGNED_CHARS = 200_000

// Width of one character cell, by font: measured on screen. The CSS "ch" unit is not it: it is taken
// from the first font of the list that has a "0", which need not be the font the text is drawn in,
// and a difference of a tenth of a pixel adds up to whole columns over a line of Korean text.
const cellWidths = new Map<string, number>()
const PROBE_CHARS = 200

function cellWidthOf(element: HTMLElement): number | null {
  const style = getComputedStyle(element)
  const key = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.letterSpacing}`
  const known = cellWidths.get(key)
  if (known) return known
  const probe = document.createElement('span')
  probe.textContent = '0'.repeat(PROBE_CHARS)
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none'
  element.appendChild(probe)
  const width = probe.getBoundingClientRect().width / PROBE_CHARS
  probe.remove()
  // Not laid out yet (a hidden panel): asked again next time
  if (!(width > 0)) return null
  cellWidths.set(key, width)
  return width
}

/**
 * Output as a terminal shows it: a Korean or Chinese character takes exactly two cells, so the
 * columns a program padded (psql, docker ps) line up whatever width the font draws it in.
 */
const AlignedText = memo(function AlignedText({ text }: { text: string }) {
  const runs = useMemo(() => (text.length <= MAX_ALIGNED_CHARS && hasWideCharacters(text) ? splitWideRuns(text) : null), [text])
  if (!runs) return <>{text}</>
  return (
    <>
      {runs.map((run, index) => (run.isWide
        ? <span key={index} className="mcp-term-wide" style={{ width: `calc(var(--mcp-cell, 1ch) * ${run.cells})` }}>{run.text}</span>
        : run.text))}
    </>
  )
})

/** One request: a prompt line, what the command printed, then how it ended. */
export const TerminalEntry = memo(function TerminalEntry({ item, now }: { item: McpActivityItem; now: number }) {
  const active = isActiveState(item.state)
  // One-liners joined with ; && | are laid out one command per line (display only, see lib/shellFormat)
  const commandLines = useMemo(() => formatShellCommand(revealHiddenChars(item.command).text), [item.command])
  const parts = item.outputParts ?? []
  const isOutputWrapped = useMcpActivityStore(state => state.isOutputWrapped)
  const outputRef = useRef<HTMLPreElement>(null)
  const hasOutput = parts.length > 0
  // The cell width the wide runs are sized with, for the font this output is drawn in
  useLayoutEffect(() => {
    const output = outputRef.current
    if (!output || isOutputWrapped) return
    const cell = cellWidthOf(output)
    if (cell) output.style.setProperty('--mcp-cell', `${cell}px`)
  }, [hasOutput, isOutputWrapped])
  // A request that never reached the server has a reason instead of output
  const notice = !active && !hasRun(item) ? (item.output ?? item.error ?? null) : null
  const hasFailedExit = item.exitCode != null && item.exitCode !== 0

  return (
    <li className={`mcp-term-entry state-${item.state}`}>
      {/* Flows like a terminal line: the tags float at the top right, and a long command wraps under
          them across the whole width instead of in a column between the directory and the tags */}
      <div className="mcp-term-prompt">
        <span className="mcp-term-tags">
          {item.level !== 'low' && <span className={`mcp-risk mcp-risk-${item.level}`}>{RISK_LABELS[item.level] ?? item.level}</span>}
          {item.background && <span className="mcp-job-tag">백그라운드</span>}
          <time className="mcp-term-time">{formatClock(item.time)}</time>
        </span>
        <span className="mcp-term-session">{item.sessionName}</span>
        {item.cwd && <span className="mcp-term-cwd">{cleanTerminalText(item.cwd)}</span>}
        <span className="mcp-term-sigil" aria-hidden="true">$</span>
        <code className="mcp-term-command sh-code">
          <ShellCommandText lines={commandLines} />
        </code>
      </div>
      {item.outputTrimmed && <p className="mcp-term-notice">{TRIMMED_TEXT}</p>}
      {parts.length > 0 && (
        // Lines stay whole and the block scrolls sideways, unless wrapping was switched on
        <pre ref={outputRef} className={`mcp-term-output${isOutputWrapped ? ' is-wrapped' : ''}`} tabIndex={isOutputWrapped ? undefined : 0}>
          {parts.map((part, index) => (
            <span key={index} className={part.stream === 'stderr' ? 'mcp-term-stderr' : undefined}>
              {isOutputWrapped ? cleanTerminalText(part.text) : <AlignedText text={cleanTerminalText(part.text)} />}
            </span>
          ))}
        </pre>
      )}
      {item.transfer && <McpTransferBar transfer={item.transfer} state={item.state} now={now} />}
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

/** Keeps a scrolling log at its bottom as `content` changes, until the user scrolls up to read. */
export function useFollowBottom<T extends HTMLElement>(content: unknown) {
  const scrollRef = useRef<T>(null)
  const isFollowing = useRef(true)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && isFollowing.current) element.scrollTop = element.scrollHeight
  }, [content])

  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    isFollowing.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX
  }

  return { scrollRef, onScroll }
}

/** Every MCP request as one continuous, read-only log: oldest at the top, newest at the bottom. */
export function McpActivityTerminal({ items, now }: { items: McpActivityItem[]; now: number }) {
  const pinned = pinnedRequests(items, now)
  // The pinned cards take room from the log, which must stay at its bottom when they appear
  const followed = useMemo(() => [items, pinned.length], [items, pinned.length])
  const { scrollRef, onScroll } = useFollowBottom<HTMLOListElement>(followed)
  const oldestFirst = useMemo(() => [...items].reverse(), [items])

  return (
    <>
      <McpPinnedRequests items={pinned} now={now} />
      <ol className="mcp-term" ref={scrollRef} onScroll={onScroll} aria-label="MCP 명령 기록" aria-live="off" tabIndex={0}>
        {oldestFirst.map(item => (
          // Finished entries get a constant `now`, so the one-second tick re-renders only the active ones
          <TerminalEntry key={item.id} item={item} now={isActiveState(item.state) ? now : 0} />
        ))}
      </ol>
    </>
  )
}
