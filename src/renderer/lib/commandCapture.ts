/**
 * Reads the command a user just ran from what the terminal shows, rather than from keystrokes:
 * tab completion, shell history recall (↑) and line editing all change the line on screen,
 * so the rendered line is the closest thing to what the shell will execute.
 */

/** The parts of xterm's IBuffer this module reads, so it can be tested without a terminal. */
export interface BufferLike {
  baseY: number
  cursorY: number
  getLine: (y: number) => { isWrapped: boolean; translateToString: (trimRight?: boolean) => string } | undefined
}

export interface HistoryKeySource {
  savedSessionId: string | null
  host: string
  port?: number
  username: string
}

const DEFAULT_SSH_PORT = 22

// Everything up to the first prompt marker followed by a space: "user@host:~$ ", "[root@dev ~]# ",
// "PS C:\> ", "~/src ❯ ". Lines without one (password prompts, yes/no answers, output) are not commands.
const PROMPT_PATTERN = /^.*?[#$%>❯] /
// Continuation prompts made of only '>' and '-': the shell's PS2 ("> ") inside a heredoc or an
// unfinished loop, MySQL's "    -> ", Python's ">>> ". What follows is not a shell command,
// and a heredoc body can hold secrets.
const CONTINUATION_PROMPT = /^[\s>-]+$/

// Readline: Ctrl+E moves to the end of the line, Ctrl+U deletes everything before the cursor
const CLEAR_INPUT_LINE = '\x05\x15'

/** The command typed after the prompt, or null when the line should not be recorded. */
export function extractCommand(line: string): string | null {
  const match = PROMPT_PATTERN.exec(line)
  if (!match || CONTINUATION_PROMPT.test(match[0].trimEnd())) return null
  const command = line.slice(match[0].length).trimEnd()
  // A leading space means "keep this out of history", as with bash's HISTCONTROL=ignorespace
  if (command.length === 0 || command.startsWith(' ')) return null
  return command
}

/** The logical line under the cursor, joining rows that the terminal soft-wrapped. */
export function readInputLine(buffer: BufferLike): string {
  const cursorRow = buffer.baseY + buffer.cursorY
  let first = cursorRow
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  let last = cursorRow
  while (buffer.getLine(last + 1)?.isWrapped) last++

  const rows: string[] = []
  for (let y = first; y <= last; y++) {
    // Keep trailing spaces on wrapped rows: they are part of the command at the wrap point
    rows.push(buffer.getLine(y)?.translateToString(y === last) ?? '')
  }
  return rows.join('')
}

/** Keystrokes that replace the current input with the command, leaving it for the user to run. */
export function buildInsertSequence(command: string): string {
  return `${CLEAR_INPUT_LINE}${command}`
}

/**
 * Ctrl+Shift+H opens the history popup. Matched on the physical key because with the Korean
 * input mode on, event.key is a jamo ('ㅗ') instead of 'H'.
 */
export function isHistoryShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === 'KeyH'
}

/** History is kept per saved connection; unsaved quick connects are grouped by user@host:port. */
export function getHistoryKey(info: HistoryKeySource | null): string | null {
  if (!info) return null
  if (info.savedSessionId) return info.savedSessionId
  return `quick:${info.username}@${info.host}:${info.port ?? DEFAULT_SSH_PORT}`
}
