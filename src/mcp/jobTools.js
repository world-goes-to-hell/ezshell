// MCP tools for background jobs that are already running: read what a job printed, stop it, list them.
// Starting a job is run_command with `background` (tools.js), which judges and approves the command;
// the tools here only reach jobs of sessions that are still allowed.
const { LOCKED_MESSAGE, SESSIONS_UNREADABLE_MESSAGE, DROPPED_JOB_NOTE, UNCONFIRMED_JOB_NOTE, JOB_STATE_LABELS, textResult } = require('./toolShared.js')

const NOT_FOUND_MESSAGE = '작업을 찾을 수 없습니다. list_jobs 로 작업 목록을 확인하세요. (앱을 잠그면 작업이 모두 끝나고 목록이 지워집니다.)'
const NO_JOBS_MESSAGE = '백그라운드 작업이 없습니다.'
const STILL_RUNNING_NOTE = '[주의] 중지를 요청했지만 아직 끝나지 않았습니다. job_output 으로 상태를 확인하세요.'
const MORE_OUTPUT_NOTE = '[안내] 읽지 않은 출력이 더 있습니다. job_output 을 다시 호출하세요.'
const SKIPPED_NOTE = (count) => `[주의] 읽기 전에 보관 한도를 넘어 밀려난 출력 ${count}자는 건너뛰었습니다.`
const DEFAULT_WAIT_SECONDS = 10
const MAX_WAIT_SECONDS = 25
/** How long stop_job waits for the job to report that it ended */
const STOP_WAIT_MS = 3000

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}분 ${seconds % 60}초` : `${seconds}초`
}

function waitMsOf(value) {
  if (value === undefined || value === null) return DEFAULT_WAIT_SECONDS * 1000
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return DEFAULT_WAIT_SECONDS * 1000
  return Math.min(Math.max(seconds, 0), MAX_WAIT_SECONDS) * 1000
}

function createJobHandlers({ isUnlocked, allowedSessions, jobs, now = () => Date.now() }) {
  const elapsedOf = (job) => formatElapsed((job.finishedAt ?? now()) - job.startedAt)

  function statusLines(job) {
    const lines = [`작업: ${job.id}`, `세션: ${job.sessionName}`, `명령: ${job.command}`, `상태: ${JOB_STATE_LABELS[job.state] || job.state}`]
    if (job.state !== 'running') lines.push(`종료 코드: ${job.exitCode ?? '없음'}${job.signal ? ` (시그널 ${job.signal})` : ''}`)
    lines.push(`경과: ${elapsedOf(job)}`)
    if (job.state === 'failed') lines.push(DROPPED_JOB_NOTE)
    else if (job.unconfirmed) lines.push(UNCONFIRMED_JOB_NOTE)
    return lines
  }

  /** The ids of sessions Claude may use now, or an error result. */
  function allowedIds() {
    if (!isUnlocked()) return { denied: textResult(LOCKED_MESSAGE, true) }
    try {
      return { ids: new Set(allowedSessions().map(session => session.id)) }
    } catch {
      return { denied: textResult(SESSIONS_UNREADABLE_MESSAGE, true) }
    }
  }

  /**
   * The job, when Claude may still see it. A job whose session is no longer allowed is stopped and
   * answered like one that does not exist.
   */
  function findJob(id) {
    const access = allowedIds()
    if (access.denied) return access
    const job = typeof id === 'string' ? jobs.get(id) : null
    if (!job) return { denied: textResult(NOT_FOUND_MESSAGE, true) }
    if (!access.ids.has(job.sessionId)) {
      jobs.stop(job.id)
      return { denied: textResult(NOT_FOUND_MESSAGE, true) }
    }
    return { job }
  }

  async function jobOutput(args, { signal } = {}) {
    const { job: id, wait_seconds: waitSeconds } = args || {}
    const found = findJob(id)
    if (found.denied) return found.denied
    const read = await jobs.read(id, { waitMs: waitMsOf(waitSeconds), signal })
    // The app may have locked, or the session's access been taken away, while this was waiting
    const after = findJob(id)
    if (after.denied) return after.denied
    if (!read) return textResult(NOT_FOUND_MESSAGE, true)
    const lines = statusLines(read.job)
    if (read.skipped > 0) lines.push(SKIPPED_NOTE(read.skipped))
    if (read.more) lines.push(MORE_OUTPUT_NOTE)
    lines.push('--- 출력 ---', read.text || '(새 출력 없음)')
    return textResult(lines.join('\n'))
  }

  async function stopJob(args, { waitMs = STOP_WAIT_MS } = {}) {
    const { job: id } = args || {}
    const found = findJob(id)
    if (found.denied) return found.denied
    jobs.stop(id)
    await jobs.whenFinished(id, waitMs)
    const after = findJob(id)
    if (after.denied) return after.denied
    const lines = statusLines(after.job)
    if (after.job.state === 'running') lines.push(STILL_RUNNING_NOTE)
    return textResult(lines.join('\n'))
  }

  function listJobs() {
    const access = allowedIds()
    if (access.denied) return access.denied
    jobs.stopWhere(job => !access.ids.has(job.sessionId))
    const visible = jobs.list().filter(job => access.ids.has(job.sessionId))
    if (visible.length === 0) return textResult(NO_JOBS_MESSAGE)
    const list = visible.map(job => ({
      job: job.id,
      session: job.sessionName,
      command: job.command,
      cwd: job.cwd,
      state: JOB_STATE_LABELS[job.state] || job.state,
      exit_code: job.exitCode,
      elapsed: elapsedOf(job),
      unread_chars: job.unread
    }))
    return textResult(JSON.stringify(list, null, 2))
  }

  return { jobOutput, stopJob, listJobs }
}

module.exports = { createJobHandlers }
