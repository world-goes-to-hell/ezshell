import { memo } from 'react'
import type { McpDiffHunk } from '../../types'
import { DIFF_MARKS } from '../../lib/mcpDiff'
import { McpApprovalEnd } from './McpApprovalEnd'

interface McpDiffViewProps {
  hunks: McpDiffHunk[]
  id?: string
  /** Called the first time the end of the change is visible in the dialog. */
  onSeenEnd?: () => void
}

/**
 * The change a file tool wants to make, every changed line with a few lines around it.
 * Long lines wrap: nothing is hidden off to the side. Memoised, because the dialog around it
 * re-renders four times a second for its countdown.
 */
export const McpDiffView = memo(function McpDiffView({ hunks, id, onSeenEnd }: McpDiffViewProps) {
  return (
    <div className="mcp-diff" id={id} role="region" aria-label="변경 내용" tabIndex={0}>
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
      {onSeenEnd && <McpApprovalEnd onSeen={onSeenEnd} />}
    </div>
  )
})
