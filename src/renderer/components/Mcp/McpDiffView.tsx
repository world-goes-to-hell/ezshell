import { memo, useCallback, useEffect, useRef } from 'react'
import type { McpDiffHunk } from '../../types'
import { DIFF_MARKS } from '../../lib/mcpDiff'

/** How close to the bottom counts as having reached the end */
const END_THRESHOLD_PX = 8

interface McpDiffViewProps {
  hunks: McpDiffHunk[]
  id?: string
  /** Called once the end of the change has been on screen (at once when it fits without scrolling) */
  onSeenEnd?: () => void
}

/**
 * The change a file tool wants to make, every changed line with a few lines around it.
 * Long lines wrap: nothing is hidden off to the side. Memoised, because the dialog around it
 * re-renders four times a second for its countdown.
 */
export const McpDiffView = memo(function McpDiffView({ hunks, id, onSeenEnd }: McpDiffViewProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const checkEnd = useCallback(() => {
    const box = boxRef.current
    if (box && box.scrollHeight - box.scrollTop - box.clientHeight <= END_THRESHOLD_PX) onSeenEnd?.()
  }, [onSeenEnd])

  useEffect(() => {
    checkEnd()
  }, [checkEnd, hunks])

  return (
    <div className="mcp-diff" id={id} ref={boxRef} onScroll={checkEnd} role="region" aria-label="변경 내용" tabIndex={0}>
      {hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex} className="mcp-diff-hunk">
          <div className="mcp-diff-header">{hunk.header}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div key={lineIndex} className={`mcp-diff-line mcp-diff-${line.type}`}>
              <span className="mcp-diff-mark">{DIFF_MARKS[line.type]}</span>
              <span className="mcp-diff-text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
})
