// Pieces the command tools (tools.js) and the file tools (fileTools.js) both use:
// result shape, the name Claude sees, and how a request appears in the activity view.
const LOCKED_MESSAGE = '앱이 잠겨 있습니다. 앱에서 잠금을 해제하세요.'
const SESSION_CHANGED_MESSAGE = '세션 설정이 바뀌어 실행하지 않았습니다.'
const UNKNOWN_ERROR_MESSAGE = '알 수 없는 오류가 발생했습니다.'
const SESSIONS_UNREADABLE_MESSAGE = '세션 정보를 읽지 못했습니다.'
const AUDIT_FAILED_MESSAGE = '감사 로그를 기록할 수 없어 실행하지 않았습니다.'
const DENIAL_MESSAGES = {
  denied: '사용자가 실행을 거부했습니다.',
  expired: '제한 시간 안에 승인되지 않아 실행하지 않았습니다.',
  cancelled: '요청이 취소되어 실행하지 않았습니다.'
}

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

module.exports = {
  LOCKED_MESSAGE, SESSION_CHANGED_MESSAGE, UNKNOWN_ERROR_MESSAGE, SESSIONS_UNREADABLE_MESSAGE, AUDIT_FAILED_MESSAGE, DENIAL_MESSAGES,
  textResult, folderPath, exposedName, activityFields, activityState
}
