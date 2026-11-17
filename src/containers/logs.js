// Reads a container's log in short looks: `docker logs --timestamps --since <last seen> --tail N`.
// No `docker logs -f` is left running on the server: a follow keeps a channel of the connection
// busy for as long as the window is open and can stay behind after the window closed (it notices a
// closed channel only when it next writes). Each look here ends on its own and leaves nothing.
//
// Lines are joined without repeats by the timestamp docker puts before each line: a look asks from
// the last timestamp seen (docker includes that instant) and lines not after it are dropped.

const { isContainerName } = require('./parse.js')
const { runCommand } = require('./exec.js')

const FIRST_LINES = 500
const LOOK_LINES = 2000
const MAX_BYTES = 1024 * 1024
const LOOK_TIMEOUT_MS = 8000
/** RFC 3339 with up to nine fraction digits, as docker prints it */
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const STAMPED_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})) ?(.*)$/

const isStamp = (value) => typeof value === 'string' && STAMP.test(value)

/** stderr is joined in: docker hands a container's stderr back on stderr, and both are its log */
function logCommand({ name, since, tail }) {
  if (!isContainerName(name)) throw new Error('bad container name')
  if (since !== undefined && since !== null && !isStamp(since)) throw new Error('bad timestamp')
  const lines = Math.min(LOOK_LINES, Math.max(1, Math.floor(Number(tail)) || FIRST_LINES))
  return `sh -c "timeout 5 docker logs --timestamps --tail ${lines}${since ? ` --since ${since}` : ''} ${name} 2>&1"`
}

/** Fraction padded to nine digits so two stamps compare as text */
function sortable(stamp) {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(stamp)
  return match ? `${match[1]}.${(match[2] || '').padEnd(9, '0')}${match[3]}` : stamp
}

/**
 * @param {string} output  what the command printed
 * @param {{ after?: string | null, isCut?: boolean }} options
 *   `after`: the last stamp already shown; lines not after it are dropped.
 *   `isCut`: the output was cut at the size limit, so its last line may be half a line.
 * @returns {{ text: string, last: string | null, lines: number }}
 *   `text` without the stamps, `last` the newest stamp read (or `after` when nothing new came)
 */
function readLog(output, { after = null, isCut = false } = {}) {
  const rows = output.split('\n')
  // The piece after the final newline is empty for whole output, half a line for cut output
  if (isCut || rows[rows.length - 1] === '') rows.pop()
  const floor = after ? sortable(after) : null
  const kept = []
  let last = after
  let isKeeping = floor === null
  for (const row of rows) {
    const line = row.endsWith('\r') ? row.slice(0, -1) : row
    const match = STAMPED_LINE.exec(line)
    if (!match) {
      // A line docker did not stamp belongs to the stamped line before it
      if (isKeeping) kept.push(line)
      continue
    }
    isKeeping = floor === null || sortable(match[1]) > floor
    if (!isKeeping) continue
    kept.push(match[2])
    last = match[1]
  }
  return { text: kept.length > 0 ? kept.join('\n') + '\n' : '', last, lines: kept.length }
}

/**
 * @param {{ connectionOf: (sessionId: string) => object | null }} deps
 */
function createContainerLogs({ connectionOf }) {
  /**
   * One look. `since` null: the last lines of the log (the first look).
   * @returns {Promise<{ ok: true, text: string, last: string | null, lines: number } | { ok: false, error: string }>}
   */
  async function read(sessionId, name, { since = null } = {}) {
    const conn = connectionOf(sessionId)
    if (!conn) return { ok: false, error: '탭의 연결이 끊겼습니다.' }
    let command
    try {
      command = logCommand({ name, since, tail: since ? LOOK_LINES : FIRST_LINES })
    } catch {
      return { ok: false, error: '컨테이너 로그를 읽지 못했습니다.' }
    }
    const ran = await runCommand(conn, command, { maxBytes: MAX_BYTES, timeoutMs: LOOK_TIMEOUT_MS })
    if (!ran.ok) return { ok: false, error: ran.error }
    if (ran.exitCode !== 0 && !ran.truncated) {
      if (ran.exitCode === 124) return { ok: false, error: '도커가 5초 안에 응답하지 않았습니다.' }
      if (/no such container/i.test(ran.stdout)) return { ok: false, error: '컨테이너가 없어졌습니다.' }
      if (/permission denied/i.test(ran.stdout)) return { ok: false, error: '이 계정은 도커를 쓸 권한이 없습니다.' }
      return { ok: false, error: '컨테이너 로그를 읽지 못했습니다.' }
    }
    return { ok: true, ...readLog(ran.stdout, { after: since, isCut: ran.truncated }) }
  }

  return { read }
}

module.exports = { createContainerLogs, logCommand, readLog, isStamp, FIRST_LINES, LOOK_LINES }
