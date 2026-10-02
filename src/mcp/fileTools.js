// The MCP tools that change a remote text file: write_file and edit_file.
// Nothing is written until the user has seen the change and allowed it, and then only if the file
// is still what they were shown. The content never goes to the audit log.
const crypto = require('crypto')
const { combineSignals } = require('./signals.js')
const { shellQuote } = require('./shellQuote.js')
const { classifyCommand, needsApproval } = require('./commandPolicy.js')
const { resolveRemotePath } = require('./filePath.js')
const { applyEdit, describeChange, toUnifiedText, countLines } = require('./fileEdit.js')
const { classifyFileWrite, refuseSystemPath } = require('./filePolicy.js')
const { inspectTarget, writeIfUnchanged, RemoteFileError, MAX_FILE_BYTES } = require('./remoteFile.js')
const {
  LOCKED_MESSAGE, SESSION_CHANGED_MESSAGE, UNKNOWN_ERROR_MESSAGE, SESSIONS_UNREADABLE_MESSAGE, AUDIT_FAILED_MESSAGE,
  textResult, folderPath, exposedName, activityFields, activityState
} = require('./toolShared.js')

/** A change takes longer to read than a command, so its dialog stays longer */
const FILE_APPROVAL_TIMEOUT_MS = 180 * 1000
/** More lines than this cannot be reviewed in a dialog (and a diff of them is too costly) */
const MAX_LINES = 10000
const WRITE_LEVEL = 'danger'
const LIMIT_LABEL = `${MAX_FILE_BYTES / 1024}KB까지`
const CONTENT_REQUIRED_MESSAGE = '내용(content)이 필요합니다.'
const CONTENT_TOO_LARGE_MESSAGE = `내용이 너무 큽니다 (${LIMIT_LABEL}).`
const TOO_MANY_LINES_MESSAGE = `줄이 너무 많습니다 (${MAX_LINES}줄까지).`
const OLD_REQUIRED_MESSAGE = '바꿀 문자열(old_string)이 비어 있습니다.'
const NEW_REQUIRED_MESSAGE = '새 문자열(new_string)이 필요합니다.'
const SAME_STRINGS_MESSAGE = '바꿀 문자열과 새 문자열이 같습니다.'
const NO_FILE_MESSAGE = '파일이 없습니다. 새 파일은 write_file 로 만드세요.'
const NOT_FOUND_MESSAGE = '바꿀 문자열을 파일에서 찾지 못했습니다.'
const CRLF_HINT = ' 파일이 CRLF 줄바꿈을 쓰고 있습니다.'
const AMBIGUOUS_MESSAGE = (count) => `바꿀 문자열이 파일에 ${count}번 나옵니다. 한 곳만 가리키도록 더 길게 지정하거나 replace_all 을 쓰세요.`
const READ_GATED_MESSAGE = '현재 알림 수준에서는 이 파일을 읽을 때 확인이 필요해서 edit_file 을 쓸 수 없습니다. run_command 로 내용을 확인한 뒤 write_file 로 전체 내용을 지정하세요.'
const DENIAL_MESSAGES = {
  denied: '사용자가 파일 쓰기를 거부했습니다.',
  expired: '제한 시간 안에 승인되지 않아 쓰지 않았습니다.',
  cancelled: '요청이 취소되어 쓰지 않았습니다.'
}

const isTooLarge = (content) => Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES
const fileLine = (seen) => (seen.requestedPath === seen.path ? `파일: ${seen.path}` : `파일: ${seen.path} (요청 경로: ${seen.requestedPath})`)
const fingerprint = (content) => crypto.createHash('sha256').update(content, 'utf8').digest('hex')

function createFileHandlers({ isUnlocked, allowedSessions, findSession, getFolders, getAlertLevel, approvals, gateway, writeLog, track, activity, newRequestId }) {
  function knownCwd(sessionId) {
    try {
      return gateway.getCwd(sessionId) ?? null
    } catch {
      return null
    }
  }

  /**
   * Whether reading the file with `cat` would need the user's approval at the current alert level.
   * If so, nothing about its content may be told before the user has agreed: an answer such as
   * "not found" or "no change" would let the content be guessed piece by piece.
   * Fails closed when the alert level cannot be read.
   */
  function isReadGated(seen) {
    try {
      const alertLevel = getAlertLevel()
      return [...new Set([seen.path, seen.requestedPath])].some(target => needsApproval(classifyCommand(`cat ${shellQuote(target)}`).level, alertLevel))
    } catch {
      return true
    }
  }

  /**
   * The shared path of both tools. `makeContent(seen, { isGated })` turns the file as it is now into
   * the new content: { ok: true, content } or { ok: false, error }.
   */
  async function changeFile({ tool, ref, rawPath, signal, makeContent }) {
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

    const shownPath = typeof rawPath === 'string' ? rawPath : ''
    const base = { requestId: newRequestId(), sessionId: session.id, sessionName: session.name, command: `${tool} ${shownPath}`, level: WRITE_LEVEL, reasons: ['파일 쓰기'] }
    // "중지" in the activity panel aborts this controller; the caller's own signal still counts too.
    const stop = new AbortController()
    const requestSignal = combineSignals([signal, stop.signal])
    if (!writeLog({ ...base, phase: 'start' })) return textResult(AUDIT_FAILED_MESSAGE, true)
    track(() => activity.begin({ ...activityFields(base), cwd: knownCwd(session.id), state: 'running' }, { cancel: () => stop.abort() }))
    let finished = false
    // Audit fields known as the request goes on: the real path, and whether the user said yes
    let trail = {}
    // `view` goes to the activity view only, never to the audit log.
    const finish = (fields, output, view = {}) => {
      if (finished) return
      finished = true
      writeLog({ ...base, phase: 'end', ...trail, ...fields })
      const { outcome, ...details } = fields
      track(() => activity.update(base.requestId, { ...details, ...view, state: activityState(fields), output }))
    }
    const refuse = (message) => {
      const refused = textResult(`쓰지 못했습니다: ${message}`, true)
      finish({ outcome: 'failed', error: message }, refused.content[0].text)
      return refused
    }

    try {
      // 1. Look at the file as it is (over SFTP, no shell) and build the new content
      const seen = await gateway.useSftp(session, { signal: requestSignal }, async (sftp, where) => {
        const resolved = resolveRemotePath(rawPath, where)
        if (!resolved.ok) throw new RemoteFileError(resolved.error)
        return inspectTarget(sftp, resolved.path, { refusePath: refuseSystemPath })
      })
      trail = { target: seen.path }
      const isGated = isReadGated(seen)
      const made = makeContent(seen, { isGated })
      if (!made.ok) return refuse(made.error)
      if (isTooLarge(made.content)) return refuse(CONTENT_TOO_LARGE_MESSAGE)
      if (countLines(made.content) > MAX_LINES || (seen.exists && countLines(seen.content) > MAX_LINES)) return refuse(TOO_MANY_LINES_MESSAGE)
      const isUnchanged = seen.exists && made.content === seen.content
      const noChangeText = [`세션: ${exposedName(session)}`, fileLine(seen), '변경 없음: 파일 내용이 이미 같습니다.'].join('\n')
      // Saying "no change" confirms the content; for a read-gated file that waits for the user's answer
      if (isUnchanged && !isGated) {
        finish({ outcome: 'executed', exitCode: null }, noChangeText)
        return textResult(noChangeText)
      }

      // 2. Ask. Writing always needs the user's yes, whatever the alert level is.
      const change = describeChange(seen.content, made.content)
      const verdict = classifyFileWrite(seen)
      const interrupted = () => {
        if (isUnlocked() && !requestSignal.aborted) return null
        const stopped = textResult(isUnlocked() ? DENIAL_MESSAGES.cancelled : LOCKED_MESSAGE, true)
        finish({ outcome: 'cancelled' }, stopped.content[0].text)
        return stopped
      }
      const before = interrupted()
      if (before) return before
      track(() => activity.update(base.requestId, { state: 'waiting', reasons: verdict.reasons }))
      const outcome = await approvals.request({
        kind: 'file',
        sessionName: session.name,
        folder: folderPath(getFolders(), session.folderId),
        cwd: null,
        command: base.command,
        path: seen.path,
        requestedPath: seen.requestedPath,
        isNew: !seen.exists,
        noChange: isUnchanged,
        isWholeFile: change.isWholeFile === true,
        added: change.added,
        removed: change.removed,
        hunks: change.hunks,
        level: verdict.level,
        reasons: verdict.reasons
      }, { signal: requestSignal, timeoutMs: FILE_APPROVAL_TIMEOUT_MS })
      if (outcome !== 'approved') {
        const denied = textResult(DENIAL_MESSAGES[outcome] || DENIAL_MESSAGES.denied, true)
        finish({ outcome: DENIAL_MESSAGES[outcome] ? outcome : 'denied', reasons: verdict.reasons }, denied.content[0].text)
        return denied
      }
      trail = { ...trail, approved: true, contentSha256: fingerprint(made.content), reasons: verdict.reasons }
      track(() => activity.update(base.requestId, { state: 'running' }))

      // 3. The user said yes to what they saw: the app must still be unlocked, the request alive,
      //    the session still allowed, and (checked inside writeIfUnchanged) the file still the same.
      const after = interrupted()
      if (after) return after
      const fresh = allowedSessions().find(candidate => candidate.id === session.id)
      if (!fresh) {
        const changed = textResult(SESSION_CHANGED_MESSAGE, true)
        finish({ outcome: 'cancelled' }, changed.content[0].text)
        return changed
      }
      if (isUnchanged) {
        finish({ outcome: 'approved', exitCode: null }, noChangeText)
        return textResult(noChangeText)
      }
      const written = await gateway.useSftp(fresh, { signal: requestSignal }, (sftp, where) => writeIfUnchanged(sftp, seen, made.content, {
        signal: requestSignal,
        newFileMode: verdict.newFileMode,
        // From here on the write must run to its end; the gateway gives it the longer time limit
        onWriteStart: where && typeof where.beginWrite === 'function' ? where.beginWrite : undefined
      }))

      const text = [
        `세션: ${exposedName(fresh)}`,
        `${fileLine(seen)} (${written.created ? '새 파일' : '수정'})`,
        `변경: +${change.added}줄 -${change.removed}줄, 크기 ${written.bytes}바이트`
      ].join('\n')
      finish({ outcome: 'approved', exitCode: null }, text, { outputParts: [{ stream: 'stdout', text: toUnifiedText(change.hunks) }] })
      return textResult(text)
    } catch (err) {
      return refuse((err && err.userMessage) || UNKNOWN_ERROR_MESSAGE)
    }
  }

  function writeFile(args, { signal } = {}) {
    const { session, path, content } = args || {}
    if (typeof content !== 'string') return Promise.resolve(textResult(CONTENT_REQUIRED_MESSAGE, true))
    if (isTooLarge(content)) return Promise.resolve(textResult(CONTENT_TOO_LARGE_MESSAGE, true))
    return changeFile({ tool: 'write_file', ref: session, rawPath: path, signal, makeContent: () => ({ ok: true, content }) })
  }

  function editFile(args, { signal } = {}) {
    const { session, path, old_string: oldString, new_string: newString, replace_all: replaceAll } = args || {}
    if (typeof oldString !== 'string' || oldString === '') return Promise.resolve(textResult(OLD_REQUIRED_MESSAGE, true))
    if (typeof newString !== 'string') return Promise.resolve(textResult(NEW_REQUIRED_MESSAGE, true))
    if (oldString === newString) return Promise.resolve(textResult(SAME_STRINGS_MESSAGE, true))
    const makeContent = (seen, { isGated }) => {
      // Whether the text occurs, and how often, is content: it is not told for a read-gated file
      if (isGated) return { ok: false, error: READ_GATED_MESSAGE }
      if (!seen.exists) return { ok: false, error: NO_FILE_MESSAGE }
      const edit = applyEdit(seen.content, { oldString, newString, replaceAll: replaceAll === true, maxLength: MAX_FILE_BYTES })
      if (edit.ok) return edit
      if (edit.reason === 'ambiguous') return { ok: false, error: AMBIGUOUS_MESSAGE(edit.count) }
      if (edit.reason === 'too-large') return { ok: false, error: CONTENT_TOO_LARGE_MESSAGE }
      return { ok: false, error: NOT_FOUND_MESSAGE + (edit.crlf ? CRLF_HINT : '') }
    }
    return changeFile({ tool: 'edit_file', ref: session, rawPath: path, signal, makeContent })
  }

  return { writeFile, editFile }
}

module.exports = { createFileHandlers, FILE_APPROVAL_TIMEOUT_MS }
