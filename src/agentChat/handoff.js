// Handing an answer from the chat view to another agent (2026-11-25 user request): the answer and the
// user's comment go to that agent's inbox as a message from the user, the way the browser tab's
// review request goes (agentMessages.sendAsUser). Main builds the message; the window sends only the
// shell, the receiving agent, the comment and the answer's text.
// Design: docs/plan/2026-11-25-chat-reply-handoff.md

/** The inbox takes messages up to this (agentMessages.js MAX_TEXT) */
const MAX_MESSAGE = 8000
const MAX_COMMENT = 2000
const MAX_ANSWER = 64_000
const CUT_NOTE = '\n(이하 생략)'
const PROVIDER_NAMES = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' }

/** "codex-9" → "Codex 9", with the role after it when there is one: "Codex 9(리뷰어)" */
function agentLabel(agent) {
  if (!agent) return '에이전트'
  const base = PROVIDER_NAMES[agent.kind] ?? '에이전트'
  const prefix = `${agent.kind}-`
  const name = typeof agent.id === 'string' && agent.id.startsWith(prefix) ? `${base} ${agent.id.slice(prefix.length)}` : base
  const role = typeof agent.role === 'string' ? agent.role.trim() : ''
  return role ? `${name}(${role})` : name
}

/** Text as it may go into a message: line breaks and tabs kept, other control characters refused */
function cleanText(value, max) {
  if (typeof value !== 'string' || value.length > max) return null
  const text = value.replace(/\r\n?/g, '\n')
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return null
  return text.trim()
}

/**
 * The message the receiving agent gets. The comment is kept whole; the answer is cut at its end
 * so that the whole fits the inbox's limit.
 */
function handoffMessage({ from, comment, answer }) {
  const head = `[인계] ${agentLabel(from)}의 답변을 넘깁니다.`
  const parts = [head]
  if (comment) parts.push(comment)
  const prefix = `${parts.join('\n\n')}\n\n--- 넘겨받은 답변 ---\n`
  const room = MAX_MESSAGE - prefix.length
  const body = answer.length <= room ? answer : answer.slice(0, Math.max(0, room - CUT_NOTE.length)).trimEnd() + CUT_NOTE
  return prefix + body
}

/**
 * Checks a hand-off and builds its message. `agents` is agentMessages.snapshot().agents.
 * Returns { to, text, toLabel } or { error }.
 */
function prepareHandoff({ request, sourceAgentId, sourceKind = null, agents }) {
  const list = Array.isArray(agents) ? agents : []
  const to = typeof request?.to === 'string' ? request.to : ''
  const target = list.find((agent) => agent && agent.id === to && agent.active && (agent.mcpConnected || agent.sleeping))
  if (!target) return { error: '받을 에이전트가 연결되어 있지 않습니다. 목록을 다시 확인해 주세요.' }
  if (sourceAgentId && target.id === sourceAgentId) return { error: '같은 에이전트에게는 인계할 수 없습니다.' }
  const comment = cleanText(request?.comment ?? '', MAX_COMMENT)
  if (comment === null) return { error: `코멘트는 ${MAX_COMMENT.toLocaleString('ko-KR')}자까지, 제어 문자 없이 적어 주세요.` }
  const answer = cleanText(request?.answer, MAX_ANSWER)
  if (!answer) return { error: '넘길 답변이 비어 있거나 읽을 수 없습니다.' }
  // An agent without the message MCP has no record: its kind still names it
  const from = list.find((agent) => agent && agent.id === sourceAgentId) ?? (sourceKind ? { kind: sourceKind, id: sourceAgentId } : null)
  return { to: target.id, toLabel: agentLabel(target), text: handoffMessage({ from, comment, answer }) }
}

module.exports = { prepareHandoff, handoffMessage, agentLabel, MAX_MESSAGE, MAX_COMMENT }
