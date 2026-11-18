// What adding a followed log's new text does to the log view: which old lines to drop to stay under
// the size limit. Pure, on CodeMirror's Text (no view needed). Errors and warnings are counted by
// the problem list in the editor state (lib/logProblems), which follows these changes.
import { Text, type ChangeSpec } from '@codemirror/state'

export interface AppendPlan {
  changes: ChangeSpec[]
  addedLines: number
  /** Older lines are dropped to stay under the limit */
  trimmed: boolean
  /** Start of the last line before adding (the new text may finish it), as a position after the change */
  resumedAt: number
}

export interface AppendLimits {
  /** Past this many characters the oldest whole lines go... */
  maxChars: number
  /** ...down to about this many */
  keepChars: number
}

/** Add `text` at the end, dropping the oldest whole lines past the limit. */
export function planAppend(doc: Text, text: string, { maxChars, keepChars }: AppendLimits): AppendPlan {
  const total = doc.length + text.length
  const excess = total > maxChars ? total - keepChars : 0
  const cut = excess > 0 ? Math.min(doc.length, doc.lineAt(Math.min(excess, doc.length)).to + 1) : 0
  const lastLine = doc.line(doc.lines)
  return {
    changes: [{ from: 0, to: cut, insert: '' }, { from: doc.length, insert: text }],
    // The first piece continues the last line; every line break after it starts a line
    addedLines: Text.of(text.split('\n')).lines - 1,
    trimmed: cut > 0,
    resumedAt: Math.max(0, lastLine.from - cut)
  }
}
