// What each MCP tool does: find the session, judge the command, ask the user when
// needed, run it, and log the request before and after.
const crypto = require('crypto')
const { classifyCommand, needsApproval } = require('./commandPolicy.js')
const { quoteCdTarget } = require('./shellQuote.js')
const { combineSignals } = require('./signals.js')
const { createFileHandlers } = require('./fileTools.js')
const {
  LOCKED_MESSAGE, SESSION_CHANGED_MESSAGE, UNKNOWN_ERROR_MESSAGE, SESSIONS_UNREADABLE_MESSAGE, AUDIT_FAILED_MESSAGE, DENIAL_MESSAGES,
  textResult, folderPath, exposedName, activityFields, activityState
} = require('./toolShared.js')

const NOT_ALLOWED_MESSAGE = '허용되지 않은 세션입니다. list_sessions 로 사용할 수 있는 세션을 확인하세요.'
const NO_SESSIONS_MESSAGE = 'MCP 접근이 허용된 세션이 없습니다. 앱의 세션 편집 > 고급 설정에서 "MCP 접근 허용"을 켜세요.'
const EMPTY_COMMAND_MESSAGE = '명령이 비어 있습니다.'
const EMPTY_PATH_MESSAGE = '경로가 비어 있습니다.'
const FORMAT_FAILED_MESSAGE = (exitCode) => `명령은 실행되었지만 결과를 표시하지 못했습니다. (종료 코드: ${exitCode ?? '없음'})`
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

function createToolHandlers({ isUnlocked, getSessions, getFolders, getAlertLevel, approvals, gateway, audit, activity = NO_ACTIVITY, newRequestId = () => crypto.randomUUID() }) {
  function allowedSessions() {
    return getSessions().filter(session => session.mcpEnabled === true && !session.decryptionFailed && !session.needsMigration)
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
  async function askApproval({ session, command, verdict, signal }) {
    let cwd = gateway.getCwd(session.id)
    if (cwd === null) cwd = await gateway.resolveCwd(session, { signal })
    if (!isUnlocked() || signal.aborted) return null
    const outcome = await approvals.request({
      sessionName: session.name,
      folder: folderPath(getFolders(), session.folderId),
      cwd,
      command,
      level: verdict.level,
      reasons: verdict.reasons
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

  /** `ranIn(result)` tells where the request ran, for the activity view, when that was not known at the start. */
  async function guarded({ ref, command, signal, perform, format, ranIn }) {
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
    const base = { requestId: newRequestId(), sessionId: session.id, sessionName: session.name, command, level: verdict.level, reasons: verdict.reasons }
    // Only for the activity view; the audit log keeps the command and the verdict, nothing else.
    const startCwd = knownCwd(session.id)
    if (verdict.level === 'forbidden') {
      writeLog({ ...base, phase: 'end', outcome: 'blocked' })
      const blockedResult = textResult(`차단된 명령입니다 (${verdict.reasons.join(', ')}). 이 명령은 MCP 로 실행할 수 없습니다.`, true)
      track(() => activity.begin({ ...activityFields(base), cwd: startCwd, state: 'blocked', output: blockedResult.content[0].text }))
      return blockedResult
    }
    // "중지" in the activity panel aborts this controller; the caller's own signal still counts too.
    // Built before the start entry so nothing here can leave a start entry without an end entry.
    const stop = new AbortController()
    const requestSignal = combineSignals([signal, stop.signal])
    // A throw here is re-raised inside the try below, where it ends the request as failed.
    let askFirst = false
    let policyError
    try {
      askFirst = needsApproval(verdict.level, getAlertLevel())
    } catch (err) {
      policyError = { err }
    }
    if (!writeLog({ ...base, phase: 'start' })) return textResult(AUDIT_FAILED_MESSAGE, true)
    track(() => activity.begin({ ...activityFields(base), cwd: startCwd, state: askFirst ? 'waiting' : 'running' }, { cancel: () => stop.abort() }))
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
        const answer = await askApproval({ session, command, verdict, signal: requestSignal })
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
    const { session, command } = args || {}
    if (isBlank(command)) return Promise.resolve(textResult(EMPTY_COMMAND_MESSAGE, true))
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

  return { listSessions, runCommand, changeDirectory, writeFile: fileHandlers.writeFile, editFile: fileHandlers.editFile }
}

module.exports = { createToolHandlers, folderPath, exposedName }
