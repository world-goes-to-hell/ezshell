// What each MCP tool does: find the session, judge the command, ask the user when
// needed, run it, and log the request before and after.
const crypto = require('crypto')
const { classifyCommand, needsApproval } = require('./commandPolicy.js')
const { quoteCdTarget } = require('./shellQuote.js')
const { combineSignals } = require('./signals.js')

const LOCKED_MESSAGE = '앱이 잠겨 있습니다. 앱에서 잠금을 해제하세요.'
const NOT_ALLOWED_MESSAGE = '허용되지 않은 세션입니다. list_sessions 로 사용할 수 있는 세션을 확인하세요.'
const NO_SESSIONS_MESSAGE = 'MCP 접근이 허용된 세션이 없습니다. 앱의 세션 편집 > 고급 설정에서 "MCP 접근 허용"을 켜세요.'
const SESSION_CHANGED_MESSAGE = '세션 설정이 바뀌어 실행하지 않았습니다.'
const UNKNOWN_ERROR_MESSAGE = '알 수 없는 오류가 발생했습니다.'
const EMPTY_COMMAND_MESSAGE = '명령이 비어 있습니다.'
const EMPTY_PATH_MESSAGE = '경로가 비어 있습니다.'
const FORMAT_FAILED_MESSAGE = (exitCode) => `명령은 실행되었지만 결과를 표시하지 못했습니다. (종료 코드: ${exitCode ?? '없음'})`
const SESSIONS_UNREADABLE_MESSAGE = '세션 정보를 읽지 못했습니다.'
const DENIAL_MESSAGES = {
  denied: '사용자가 실행을 거부했습니다.',
  expired: '제한 시간 안에 승인되지 않아 실행하지 않았습니다.',
  cancelled: '요청이 취소되어 실행하지 않았습니다.'
}

const NO_ACTIVITY = { begin() {}, update() {}, cancel() { return false } }

const textResult = (text, isError = false) => (isError
  ? { content: [{ type: 'text', text }], isError: true }
  : { content: [{ type: 'text', text }] })

function folderPath(folders, folderId) {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const names = []
  const visited = new Set()
  let current = folderId ? byId.get(folderId) : undefined
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    names.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return names.join(' / ')
}

/**
 * The name Claude sees. A session saved without a name is called "user@host", and names often
 * contain the address; those are replaced so the host and account never reach Claude.
 */
function exposedName(session) {
  const name = typeof session.name === 'string' ? session.name : ''
  const host = typeof session.host === 'string' ? session.host.trim() : ''
  const hidden = name.trim() === '' || name === `${session.username}@${session.host}` || (host !== '' && name.includes(host))
  return hidden ? `세션-${String(session.id).slice(0, 8)}` : name
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

function activityFields(base) {
  return { id: base.requestId, time: new Date().toISOString(), sessionId: base.sessionId, sessionName: base.sessionName, command: base.command, level: base.level, reasons: base.reasons }
}

function activityState(fields) {
  if (fields.outcome === 'executed' || fields.outcome === 'approved') {
    if (fields.cancelled) return 'cancelled'
    return fields.timedOut ? 'timeout' : 'done'
  }
  return fields.outcome
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

  async function guarded({ ref, command, signal, perform, format }) {
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
    if (verdict.level === 'forbidden') {
      writeLog({ ...base, phase: 'end', outcome: 'blocked' })
      const blockedResult = textResult(`차단된 명령입니다 (${verdict.reasons.join(', ')}). 이 명령은 MCP 로 실행할 수 없습니다.`, true)
      track(() => activity.begin({ ...activityFields(base), state: 'blocked', output: blockedResult.content[0].text }))
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
    if (!writeLog({ ...base, phase: 'start' })) return textResult('감사 로그를 기록할 수 없어 실행하지 않았습니다.', true)
    track(() => activity.begin({ ...activityFields(base), state: askFirst ? 'waiting' : 'running' }, { cancel: () => stop.abort() }))
    let finished = false
    const finish = (fields, output) => {
      if (finished) return
      finished = true
      writeLog({ ...base, phase: 'end', ...fields })
      const { outcome, ...details } = fields
      track(() => activity.update(base.requestId, { ...details, state: activityState(fields), output }))
    }

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

      const result = await perform(fresh, requestSignal, expectedCwd)
      let text
      try {
        text = format(fresh, result)
      } catch {
        text = FORMAT_FAILED_MESSAGE(result.exitCode)
      }
      finish({ outcome: approved ? 'approved' : 'executed', exitCode: result.exitCode ?? null, timedOut: result.timedOut === true, cancelled: result.cancelled === true, truncated: result.truncated === true }, text)
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
      const list = sessions.map(session => ({
        id: session.id,
        name: exposedName(session),
        folder: folderPath(folders, session.folderId),
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
      perform: (target, cancel, expectedCwd) => gateway.run(target, command, { signal: cancel, expectedCwd }),
      format: formatRunResult
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

  return { listSessions, runCommand, changeDirectory }
}

module.exports = { createToolHandlers, folderPath, exposedName }
