// Which log lines the file window colours: errors red, warnings yellow, debug dimmed.
// The first level word of a line decides ("INFO sent ERROR report" is not an error). A line without
// one is an error only when it looks like part of a crash (exception name, stack frame, traceback).
// Lowercase "error" words are not errors: "0 errors", "no error" are common normal lines.

export type LogLevel = 'error' | 'warn' | 'debug' | 'marker'

const LEVEL_OF: Record<string, LogLevel | null> = {
  ERROR: 'error', ERR: 'error', FATAL: 'error', CRITICAL: 'error', CRIT: 'error', SEVERE: 'error',
  EMERG: 'error', EMERGENCY: 'error', ALERT: 'error', PANIC: 'error',
  WARN: 'warn', WARNING: 'warn',
  DEBUG: 'debug', TRACE: 'debug',
  INFO: null, NOTICE: null
}

// Upper-case words, nginx/apache "[error]", logfmt "level=error", JSON "level":"error": the leftmost wins
const LEVEL_TOKEN = new RegExp([
  String.raw`\b(ERROR|ERR|FATAL|CRITICAL|CRIT|SEVERE|EMERG|EMERGENCY|ALERT|PANIC|WARN|WARNING|DEBUG|TRACE|INFO|NOTICE)\b`,
  String.raw`\[(error|crit|alert|emerg|warn|warning|debug|info|notice)\]`,
  String.raw`\blevel=["']?([A-Za-z]+)`,
  String.raw`"level"\s*:\s*"([A-Za-z]+)"`
].join('|'))

const CRASH_LINES = [
  // java.lang.NullPointerException: ..., TypeError: ...
  /\b[A-Z]\w*(?:Exception|Error)\b(?=:|\s*$)/,
  /^Traceback \(most recent call last\)/,
  /^\s+File ".*", line \d+/,
  // Java / Node stack frames and the "... 12 more" after them
  /^\s+at\s+\S.*(?:\)|:\d+)\s*$/,
  /^\s+\.\.\. \d+ more\s*$/,
  /^\s*Caused by:/,
  /^panic:/
]

const MARKER_EDGE = '────'

/** A line the window adds itself (not from the server): "파일이 새로 시작됨", "3MB 건너뜀" */
export function markerLine(text: string): string {
  return `${MARKER_EDGE} ${text} ${MARKER_EDGE}`
}

export function classifyLine(line: string): LogLevel | null {
  if (line.startsWith(`${MARKER_EDGE} `) && line.endsWith(` ${MARKER_EDGE}`)) return 'marker'
  const token = LEVEL_TOKEN.exec(line)
  if (token) {
    const word = (token[1] ?? token[2] ?? token[3] ?? token[4]).toUpperCase()
    if (word in LEVEL_OF) return LEVEL_OF[word]
  }
  return CRASH_LINES.some(pattern => pattern.test(line)) ? 'error' : null
}

export type JumpLevel = 'error' | 'warn'

/**
 * The next (1) or previous (-1) line of one of `levels`, starting after line `current` (1-based) and
 * going round the end of the text. `wrapped` says the search went past the end; null when no line
 * of those levels exists (or only the current one).
 */
export function findLevelLine(
  lineCount: number,
  textOf: (lineNumber: number) => string,
  current: number,
  direction: 1 | -1,
  levels: ReadonlySet<JumpLevel>
): { line: number; wrapped: boolean } | null {
  for (let step = 1; step < lineCount; step++) {
    const raw = current + direction * step
    const line = ((raw - 1) % lineCount + lineCount) % lineCount + 1
    const level = classifyLine(textOf(line))
    if (level !== null && levels.has(level as JumpLevel)) return { line, wrapped: raw < 1 || raw > lineCount }
  }
  return null
}
