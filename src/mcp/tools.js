// What each MCP tool does: find the session, judge the command, ask the user when
// needed, run it, and log the request before and after.
const crypto = require('crypto')
const { classifyCommand, needsApproval } = require('./commandPolicy.js')
const { quoteCdTarget } = require('./shellQuote.js')
const { combineSignals } = require('./signals.js')
const { createFileHandlers } = require('./fileTools.js')
const { createJobHandlers } = require('./jobTools.js')
const { createJobStore } = require('./jobStore.js')
const {
  LOCKED_MESSAGE, SESSION_CHANGED_MESSAGE, UNKNOWN_ERROR_MESSAGE, SESSIONS_UNREADABLE_MESSAGE, AUDIT_FAILED_MESSAGE, DENIAL_MESSAGES,
  JOB_STATE_LABELS, DROPPED_JOB_NOTE, UNCONFIRMED_JOB_NOTE,
  textResult, folderPath, exposedName, isAllowedSession, activityFields, activityState
} = require('./toolShared.js')

const NOT_ALLOWED_MESSAGE = '허용되지 않은 세션입니다. list_sessions 로 사용할 수 있는 세션을 확인하세요.'
const NO_SESSIONS_MESSAGE = 'MCP 접근이 허용된 세션이 없습니다. 앱의 세션 편집 > 고급 설정에서 "MCP 접근 허용"을 켜세요.'
const EMPTY_COMMAND_MESSAGE = '명령이 비어 있습니다.'
const EMPTY_PATH_MESSAGE = '경로가 비어 있습니다.'
const FORMAT_FAILED_MESSAGE = (exitCode) => `명령은 실행되었지만 결과를 표시하지 못했습니다. (종료 코드: ${exitCode ?? '없음'})`
const DEFAULT_JOB_MINUTES = 10
const MAX_JOB_MINUTES = 60
const JOB_MINUTES_MESSAGE = `timeout_minutes 는 1 이상 ${MAX_JOB_MINUTES} 이하의 정수여야 합니다.`
const JOB_MINUTES_ALONE_MESSAGE = 'timeout_minutes 는 background: true 와 함께만 쓸 수 있습니다. 백그라운드가 아닌 명령의 제한 시간은 30초입니다.'
const JOB_LIMIT_HINT = 'list_jobs 로 확인하고, 끝나기를 기다리거나 stop_job 으로 중지하세요.'
const JOB_LIMIT_MESSAGES = {
  session: `이 세션에서 동시에 실행할 수 있는 백그라운드 작업 수를 넘었습니다. ${JOB_LIMIT_HINT}`,
  total: `동시에 실행할 수 있는 백그라운드 작업 수를 넘었습니다. ${JOB_LIMIT_HINT}`
}
const NO_ACTIVITY = { begin() {}, update() {}, appendOutput() {}, cancel() { return false } }

const DEFAULT_SSH_PORT = 22
const normalizeHost = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')
const portOf = (value) => Number(value) || DEFAULT_SSH_PORT

/**
 * Sessions that reach the same machine share a key: the target address, plus the jump host when one
 * is used (a private address behind another jump host can be another machine). The account is left
 * out on purpose. A session without a host never shares a key.
 */
function serverKey(session) {
  const host = normalizeHost(session.host)
  if (host === '') return JSON.stringify(['session', session.id])
  const target = [host, portOf(session.port)]
  const jump = session.useJumpHost ? [normalizeHost(session.jumpHost), portOf(session.jumpPort)] : []
  return JSON.stringify([...target, ...jump])
}

/**
 * A neutral label per server ("서버-1", ...), numbered in list order, so Claude can tell which sessions
 * are the same machine without seeing the address. Not a hash: a hashed IP address can be guessed back.
 */
function serverLabels(sessions) {
  const numbers = new Map()
  return sessions.map((session) => {
    const key = serverKey(session)
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1)
    return `서버-${numbers.get(key)}`
  })
}

function formatRunResult(session, result) {
  const lines = [
    `세션: ${exposedName(session)}`,
    `위치: ${result.cwd}`,
    `종료 코드: ${result.exitCode ?? '없음'}${result.signal ? ` (시그널 ${result.signal})` : ''}`
  ]
  if (result.timedOut) lines.push('[주의] 실행 시간 제한을 넘어 중단을 요청했습니다. 명령이 서버에서 아직 실행 중일 수 있습니다. 출력은 중단 시점까지입니다.')
  if (result.cancelled) lines.push('[주의] 요청이 취소되어 중단을 요청했습니다. 명령이 서버에서 아직 실행 중일 수 있습니다.')
  if (result.truncated) lines.push('[주의] 출력이 너무 길어 일부만 표시합니다.')
  lines.push('--- stdout ---', result.stdout || '(없음)')
  if (result.stderr) lines.push('--- stderr ---', result.stderr)
  return lines.join('\n')
}

/** How a background job ended: its state in the job store, and what the audit log and the activity view record. */
function describeJobEnd(id, result, approved) {
  const ran = { outcome: approved ? 'approved' : 'executed', exitCode: result.exitCode ?? null, timedOut: false, cancelled: false, truncated: false }
  const ending = () => {
    if (result.cancelled) return { state: 'stopped', fields: { ...ran, cancelled: true } }
    if (result.timedOut) return { state: 'timeout', fields: { ...ran, timedOut: true } }
    if (result.overflow) return { state: 'overflow', fields: { ...ran, cancelled: true, truncated: true } }
    if (result.dropped) return { state: 'failed', fields: { outcome: 'failed', error: DROPPED_JOB_NOTE, exitCode: null } }
    return { state: 'done', fields: ran }
  }
  const { state, fields } = ending()
  const lines = [`백그라운드 작업 ${id}: ${JOB_STATE_LABELS[state]} (종료 코드: ${result.exitCode ?? '없음'}${result.signal ? `, 시그널 ${result.signal}` : ''})`]
  if (state === 'failed') lines.push(DROPPED_JOB_NOTE)
  else if (result.unconfirmed) lines.push(UNCONFIRMED_JOB_NOTE)
  return { state, fields, text: lines.join('\n') }
}

function createToolHandlers({ isUnlocked, getSessions, getFolders, getAlertLevel, approvals, gateway, audit, activity = NO_ACTIVITY, jobs = createJobStore(), newRequestId = () => crypto.randomUUID() }) {
  function allowedSessions() {
    return getSessions().filter(isAllowedSession)
  }

  function findSession(sessions, ref) {
    if (typeof ref !== 'string' || ref.trim() === '') return { error: NOT_ALLOWED_MESSAGE }
    const byId = sessions.find(session => session.id === ref)
    const byName = sessions.filter(session => (session.name === ref || exposedName(session) === ref) && session !== byId)
    if (byId && byName.length === 0) return { session: byId }
    if (byId) return { error: `이름이 같은 세션이 ${byName.length + 1}개 있습니다. list_sessions 의 id 를 사용하세요.` }
    if (byName.length === 1) return { session: byName[0] }
    if (byName.length > 1) return { error: `이름이 같은 세션이 ${byName.length}개 있습니다. list_sessions 의 id 를 사용하세요.` }
    return { error: NOT_ALLOWED_MESSAGE }
  }

  function writeLog(entry) {
    try {
      audit.append(entry)
      return true
    } catch {
      return false
    }
  }

  // The live panel is a convenience; it must never change how a request is handled.
  function track(call) {
    try {
      call()
    } catch {
      // ignored on purpose
    }
  }

  /**
   * Show the user what would run and where. An unknown directory is resolved first (connect + home),
   * so the dialog never shows a guess. Resolves with null when the app locked or the request was
   * cancelled before the dialog could open.
   */
  async function askApproval({ session, command, verdict, signal, job }) {
    let cwd = gateway.getCwd(session.id)
    if (cwd === null) cwd = await gateway.resolveCwd(session, { signal })
    if (!isUnlocked() || signal.aborted) return null
    const outcome = await approvals.request({
      sessionName: session.name,
      folder: folderPath(getFolders(), session.folderId),
      cwd,
      command,
      level: verdict.level,
      reasons: verdict.reasons,
      ...(job ? { background: { limitMinutes: job.limitMinutes } } : {})
    }, { signal })
    return { outcome, cwd }
  }

  /** The directory the activity view shows for a request; null until the gateway has learned it. */
  function knownCwd(sessionId) {
    try {
      return gateway.getCwd(sessionId) ?? null
    } catch {
      return null
    }
  }

  /**
   * Start the command as a background job and answer with its id. The request's audit and activity
   * entries stay open until the job ends. Once the job runs, only the user (activity view), stop_job,
   * its limits or a lock stop it: the request that started it has ended by then.
   */
  async function startBackground({ session, command, job, expectedCwd, requestSignal, stop, onOutput, base, approved, finish }) {
    const limitMs = job.limitMinutes * 60 * 1000
    const created = jobs.create({ sessionId: session.id, sessionName: exposedName(session), command, limitMs })
    if (created.error) {
      const full = textResult(JOB_LIMIT_MESSAGES[created.error], true)
      finish({ outcome: 'failed', error: full.content[0].text }, full.content[0].text)
      return full
    }
    const { id } = created
    let handle
    try {
      handle = await gateway.startJob(session, command, {
        signal: requestSignal,
        expectedCwd,
        limitMs,
        onOutput: (stream, text) => { onOutput(stream, text); jobs.append(id, text) }
      })
    } catch (err) {
      jobs.discard(id)
      throw err
    }
    handle.done.then((result) => {
      const end = describeJobEnd(id, result, approved)
      jobs.finish(id, { state: end.state, exitCode: result.exitCode, signal: result.signal, unconfirmed: result.unconfirmed === true })
      finish(end.fields, end.text)
    })
    if (!jobs.attach(id, { cwd: handle.cwd, stop: handle.stop })) {
      // The app locked (or MCP was turned off) while the channel was opening
      handle.stop()
      const gone = textResult(isUnlocked() ? DENIAL_MESSAGES.cancelled : LOCKED_MESSAGE, true)
      finish({ outcome: 'cancelled' }, gone.content[0].text)
      return gone
    }
    if (stop.signal.aborted) handle.stop()
    else stop.signal.addEventListener('abort', () => handle.stop(), { once: true })
    const startedText = [
      `세션: ${exposedName(session)}`,
      `위치: ${handle.cwd}`,
      `작업 ID: ${id}`,
      `제한 시간: ${job.limitMinutes}분`,
      '백그라운드에서 실행 중입니다. job_output 으로 출력과 종료 상태를 확인하고, 중지하려면 stop_job 을 쓰세요.'
    ].join('\n')
    track(() => activity.update(base.requestId, { cwd: handle.cwd, jobId: id, output: startedText }))
    return textResult(startedText)
  }

  /**
   * `ranIn(result)` tells where the request ran, for the activity view, when that was not known at the start.
   * With `job` ({ limitMinutes }) the command is started as a background job instead of being run to its end.
   */
  async function guarded({ ref, command, signal, perform, format, ranIn, job }) {
    if (!isUnlocked()) return textResult(LOCKED_MESSAGE, true)
    let sessions
    try {
      sessions = allowedSessions()
    } catch {
      return textResult(SESSIONS_UNREADABLE_MESSAGE, true)
    }
    const found = findSession(sessions, ref)
    if (found.error) return textResult(found.error, true)
    const { session } = found

    const verdict = classifyCommand(command)
    const base = {
      requestId: newRequestId(), sessionId: session.id, sessionName: session.name, command, level: verdict.level, reasons: verdict.reasons,
      ...(job ? { background: true, limitMinutes: job.limitMinutes } : {})
    }
    // Only for the activity view; the audit log keeps the command and the verdict, nothing else.
    const startCwd = knownCwd(session.id)
    if (verdict.level === 'forbidden') {
      writeLog({ ...base, phase: 'end', outcome: 'blocked' })
      const blockedResult = textResult(`차단된 명령입니다 (${verdict.reasons.join(', ')}). 이 명령은 MCP 로 실행할 수 없습니다.`, true)
      track(() => activity.begin({ ...activityFields(base), cwd: startCwd, state: 'blocked', output: blockedResult.content[0].text }))
      return blockedResult
    }
    if (job) {
      // Checked again when the job is registered; here it saves the user a dialog for a job that cannot start
      const full = jobs.canStart(session.id)
      if (full) return textResult(JOB_LIMIT_MESSAGES[full], true)
    }
    // "중지" in the activity panel aborts this controller; the caller's own signal still counts too.
    // Built before the start entry so nothing here can leave a start entry without an end entry.
    const stop = new AbortController()
    const requestSignal = combineSignals([signal, stop.signal])
    // A throw here is re-raised inside the try below, where it ends the request as failed.
    let askFirst = false
    let policyError
    try {
      // A background job is always asked about, whatever the alert level: the 30 second limit that
      // keeps an unasked "low" command small does not apply to it.
      askFirst = job ? true : needsApproval(verdict.level, getAlertLevel())
    } catch (err) {
      policyError = { err }
    }
    if (!writeLog({ ...base, phase: 'start' })) return textResult(AUDIT_FAILED_MESSAGE, true)
    track(() => activity.begin({ ...activityFields(base), cwd: startCwd, state: askFirst ? 'waiting' : 'running', ...(job ? { background: true } : {}) }, { cancel: () => stop.abort() }))
    let finished = false
    // `view` goes to the activity view only, never to the audit log.
    const finish = (fields, output, view = {}) => {
      if (finished) return
      finished = true
      writeLog({ ...base, phase: 'end', ...fields })
      const { outcome, ...details } = fields
      track(() => activity.update(base.requestId, { ...details, ...view, state: activityState(fields), output }))
    }
    const onOutput = (stream, text) => track(() => activity.appendOutput(base.requestId, stream, text))

    try {
      if (policyError) throw policyError.err
      // Ends the request when the app locked or the request was cancelled in the meantime
      const interrupted = () => {
        if (isUnlocked() && !requestSignal.aborted) return null
        const stopped = textResult(isUnlocked() ? DENIAL_MESSAGES.cancelled : LOCKED_MESSAGE, true)
        finish({ outcome: 'cancelled' }, stopped.content[0].text)
        return stopped
      }
      let approved = false
      // The directory shown in the dialog; the gateway refuses to run anywhere else.
      let expectedCwd
      if (askFirst) {
        const answer = await askApproval({ session, command, verdict, signal: requestSignal, job })
        if (answer === null) return interrupted()
        if (answer.outcome !== 'approved') {
          const denied = textResult(DENIAL_MESSAGES[answer.outcome] || DENIAL_MESSAGES.denied, true)
          finish({ outcome: answer.outcome }, denied.content[0].text)
          return denied
        }
        approved = true
        expectedCwd = answer.cwd
        track(() => activity.update(base.requestId, { state: 'running' }))
      }

      const stopped = interrupted()
      if (stopped) return stopped

      // The user approved what they saw; make sure the session is still allowed and use its current settings.
      const fresh = allowedSessions().find(candidate => candidate.id === session.id)
      if (!fresh) {
        const changed = textResult(SESSION_CHANGED_MESSAGE, true)
        finish({ outcome: 'cancelled' }, changed.content[0].text)
        return changed
      }

      if (job) return await startBackground({ session: fresh, command, job, expectedCwd, requestSignal, stop, onOutput, base, approved, finish })

      const result = await perform(fresh, requestSignal, expectedCwd, onOutput)
      let text
      try {
        text = format(fresh, result)
      } catch {
        text = FORMAT_FAILED_MESSAGE(result.exitCode)
      }
      const view = startCwd === null && ranIn ? { cwd: ranIn(result) ?? null } : {}
      finish({ outcome: approved ? 'approved' : 'executed', exitCode: result.exitCode ?? null, timedOut: result.timedOut === true, cancelled: result.cancelled === true, truncated: result.truncated === true }, text, view)
      return textResult(text)
    } catch (err) {
      const message = (err && err.userMessage) || UNKNOWN_ERROR_MESSAGE
      const failed = textResult(`실행하지 못했습니다: ${message}`, true)
      finish({ outcome: 'failed', error: message }, failed.content[0].text)
      return failed
    }
  }

  function listSessions() {
    if (!isUnlocked()) return textResult(LOCKED_MESSAGE, true)
    try {
      const sessions = allowedSessions()
      if (sessions.length === 0) return textResult(NO_SESSIONS_MESSAGE)
      const folders = getFolders()
      const servers = serverLabels(sessions)
      const list = sessions.map((session, index) => ({
        id: session.id,
        name: exposedName(session),
        folder: folderPath(folders, session.folderId),
        server: servers[index],
        cwd: gateway.getCwd(session.id)
      }))
      return textResult(JSON.stringify(list, null, 2))
    } catch {
      return textResult(SESSIONS_UNREADABLE_MESSAGE, true)
    }
  }

  const isBlank = (value) => typeof value !== 'string' || value.trim() === ''

  function runCommand(args, { signal } = {}) {
    const { session, command, background, timeout_minutes: minutes } = args || {}
    if (isBlank(command)) return Promise.resolve(textResult(EMPTY_COMMAND_MESSAGE, true))
    if (background === true) {
      const limitMinutes = minutes === undefined ? DEFAULT_JOB_MINUTES : minutes
      if (!Number.isInteger(limitMinutes) || limitMinutes < 1 || limitMinutes > MAX_JOB_MINUTES) return Promise.resolve(textResult(JOB_MINUTES_MESSAGE, true))
      return guarded({ ref: session, command, signal, job: { limitMinutes } })
    }
    if (minutes !== undefined) return Promise.resolve(textResult(JOB_MINUTES_ALONE_MESSAGE, true))
    return guarded({
      ref: session,
      command,
      signal,
      perform: (target, cancel, expectedCwd, onOutput) => gateway.run(target, command, { signal: cancel, expectedCwd, onOutput }),
      format: formatRunResult,
      ranIn: (result) => result.cwd
    })
  }

  function changeDirectory(args, { signal } = {}) {
    const { session, path } = args || {}
    if (isBlank(path)) return Promise.resolve(textResult(EMPTY_PATH_MESSAGE, true))
    return guarded({
      ref: session,
      command: `cd ${quoteCdTarget(path)}`,
      signal,
      perform: (target, cancel, expectedCwd) => gateway.changeDirectory(target, path, { signal: cancel, expectedCwd }),
      format: (target, result) => `세션: ${exposedName(target)}
작업 디렉터리: ${result.cwd}`
    })
  }

  const fileHandlers = createFileHandlers({ isUnlocked, allowedSessions, findSession, getFolders, getAlertLevel, approvals, gateway, writeLog, track, activity, newRequestId })

  const jobHandlers = createJobHandlers({ isUnlocked, allowedSessions, jobs })

  return {
    listSessions, runCommand, changeDirectory,
    writeFile: fileHandlers.writeFile, editFile: fileHandlers.editFile,
    jobOutput: jobHandlers.jobOutput, stopJob: jobHandlers.stopJob, listJobs: jobHandlers.listJobs
  }
}

module.exports = { createToolHandlers, folderPath, exposedName }
