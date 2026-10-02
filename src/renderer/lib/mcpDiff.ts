import type { McpDiffHunk, McpDiffLine } from '../types'
import { revealHiddenChars } from './mcpLabels'

/** Shown for the carriage return of a CRLF line end, so a change of line ends is visible */
const CARRIAGE_RETURN_MARK = '␍'
const NO_FINAL_NEWLINE = '(파일 끝에 줄바꿈 없음)'

export const DIFF_MARKS: Record<McpDiffLine['type'], string> = { add: '+', remove: '-', context: ' ', note: '' }

function revealLine(line: McpDiffLine): { line: McpDiffLine; hasHidden: boolean } {
  if (line.type === 'note') return { line: { type: 'note', text: NO_FINAL_NEWLINE }, hasHidden: false }
  const endsWithReturn = line.text.endsWith('\r')
  const revealed = revealHiddenChars(endsWithReturn ? line.text.slice(0, -1) : line.text)
  return {
    line: { type: line.type, text: endsWithReturn ? revealed.text + CARRIAGE_RETURN_MARK : revealed.text },
    hasHidden: revealed.hasHidden
  }
}

/**
 * The change as it is shown for approval: invisible or deceptive characters become visible tokens,
 * so the user cannot approve text that reads differently from what it is. A CRLF line end is not
 * counted as hidden; it gets its own mark.
 */
export function revealDiff(hunks: McpDiffHunk[]): { hunks: McpDiffHunk[]; hasHidden: boolean } {
  let hasHidden = false
  const revealed = hunks.map(hunk => ({
    header: hunk.header,
    lines: hunk.lines.map((line) => {
      const result = revealLine(line)
      if (result.hasHidden) hasHidden = true
      return result.line
    })
  }))
  return { hunks: revealed, hasHidden }
}
