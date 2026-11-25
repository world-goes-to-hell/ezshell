// Which log lines the file window colours: errors red, warnings yellow, debug dimmed.
// The first level word of a line decides ("INFO sent ERROR report" is not an error). A line without
// one is an error only when it looks like part of a crash (exception name, stack frame, traceback).
// Lowercase "error" words are not errors: "0 errors", "no error" are common normal lines.

const LEVEL_OF = {
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
export function markerLine(text) {
  return `${MARKER_EDGE} ${text} ${MARKER_EDGE}`
}

// Lines that belong to the crash report above them, whatever words they carry
// ("Caused by: ...: ERROR: relation does not exist" is not a new error)
const CONTINUATION_LINES = [
  /^\s+at\s/,
  /^\s*Caused by:/,
  /^\s+\.\.\. \d+ (?:more|common frames)/,
  /^\s+File "/,
  /^[\w.$]+(?:Exception|Error)(?::|\s*$)/
]

const PYTHON_FRAME = /^\s+File ".*", line \d+/

/**
 * A Python traceback prints the source line under each `File "...", line N` line. That line is plain
 * code (no level, no crash words) but belongs to the report: the lines after it continue the same one.
 */
export function isFrameSource(previousLine, line) {
  return PYTHON_FRAME.test(previousLine) && /^\s/.test(line)
}

export function classifyDetail(line) {
  if (line.startsWith(`${MARKER_EDGE} `) && line.endsWith(` ${MARKER_EDGE}`)) return { level: 'marker', explicit: true }
  if (CONTINUATION_LINES.some(pattern => pattern.test(line))) return { level: 'error', explicit: false }
  const token = LEVEL_TOKEN.exec(line)
  if (token) {
    const word = (token[1] ?? token[2] ?? token[3] ?? token[4]).toUpperCase()
    if (word in LEVEL_OF) return { level: LEVEL_OF[word], explicit: true }
  }
  return { level: CRASH_LINES.some(pattern => pattern.test(line)) ? 'error' : null, explicit: false }
}

export function classifyLine(line) {
  return classifyDetail(line).level
}

export function classifyProblemLine(line, previous, inside) {
  const { level, explicit } = classifyDetail(line)
  const problem = level === 'error' || level === 'warn'
  const source = isFrameSource(previous, line)
  return { level: problem ? level : null, start: problem && (explicit || !inside), inside: problem || source }
}
