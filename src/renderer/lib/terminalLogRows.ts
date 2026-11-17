// Which rows on a terminal's screen are log lines to highlight (errors, warnings). The rule for a
// line is the file log view's (logLevels.ts); this module reads the lines off the terminal buffer:
// rows the terminal soft-wrapped are one line, and the line being typed and command lines are left
// alone (`grep ERROR app.log` is a command, not an error).

import { classifyLine } from './logLevels'

export type RowLevel = 'error' | 'warn'

/** The parts of xterm's IBuffer this module reads, so it can be tested without a terminal */
export interface RowSource {
  getLine: (y: number) => { isWrapped: boolean; translateToString: (trimRight?: boolean) => string } | undefined
}

/** Rows joined into one line at most: a longer line is read from the row it is cut at */
const MAX_WRAPPED_ROWS = 20
/** Characters of a line the patterns are run on */
const MAX_LINE_LENGTH = 2000

// "user@host:~$ ", "[root@dev ~]# ", "PS C:\Users\me> ", "~/src ❯ ". Narrower than the prompt rule
// of commandCapture on purpose: that one matches any "> " or "% ", which log lines are full of.
const COMMAND_LINE = /^(?:\[?[\w.-]+@[\w.-]+[^#$]{0,200}[#$] |PS [A-Za-z]:\\[^>]{0,200}> |\S{0,200} ?[❯➜] )/

export function isCommandLine(line: string): boolean {
  return COMMAND_LINE.test(line)
}

/**
 * The level of each highlighted row among the `rows` rows from buffer row `top`. `cursorRow` is the
 * buffer row of the cursor: its line is what the user is typing (or a line still being written).
 */
export function visibleRowLevels(buffer: RowSource, top: number, rows: number, cursorRow: number): Map<number, RowLevel> {
  const levels = new Map<number, RowLevel>()
  const bottom = top + rows - 1
  let row = top
  while (row <= bottom) {
    let first = row
    while (first > 0 && row - first < MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first--
    let last = row
    while (last - first < MAX_WRAPPED_ROWS && buffer.getLine(last + 1)?.isWrapped) last++

    if (cursorRow < first || cursorRow > last) {
      let text = ''
      for (let y = first; y <= last && text.length < MAX_LINE_LENGTH; y++) {
        text += buffer.getLine(y)?.translateToString(y === last) ?? ''
      }
      text = text.slice(0, MAX_LINE_LENGTH)
      const level = text.trim() === '' ? null : classifyLine(text)
      if ((level === 'error' || level === 'warn') && !isCommandLine(text)) {
        for (let y = Math.max(first, top); y <= Math.min(last, bottom); y++) levels.set(y, level)
      }
    }
    row = last + 1
  }
  return levels
}
