const COMMON_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PreCompact', 'PostCompact', 'Stop']
const CLAUDE_HOOK_EVENTS = Object.freeze([...COMMON_EVENTS, 'Notification', 'Elicitation', 'PostToolUseFailure', 'PermissionDenied', 'StopFailure'])
const CODEX_HOOK_EVENTS = Object.freeze([...COMMON_EVENTS, 'Interrupt'])
const EVENTS = {
  claude: new Set(CLAUDE_HOOK_EVENTS),
  codex: new Set(CODEX_HOOK_EVENTS)
}
const NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'idle_prompt'])
const START_SOURCES = new Set(['startup', 'resume', 'clear', 'compact', 'fork'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,99}$/i
// Tool names kept from the hook input: a question dialog, and the tools that write files (whose time tells
// src/ipc/agentFileOwners.js which agent changed a file). Only these names; never a tool's arguments.
const TOOLS = {
  claude: new Set(['AskUserQuestion', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']),
  codex: new Set(['apply_patch'])
}
const isUuid = value => typeof value === 'string' && UUID.test(value)
const isIdentifier = value => typeof value === 'string' && IDENTIFIER.test(value)
const SUBAGENT_DIALOG_EVENTS = new Set(['PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'])

/** Project an input onto the protocol fields. Main independently validates everything used for routing or recording. */
function validateAgentHookEvent(input) {
  if (typeof input?.kind !== 'string' || !Object.hasOwn(EVENTS, input.kind)) return null
  const { kind, event, startedAt, sessionId, promptId, toolUseId, tool, notification, source, stopHookActive, subagent } = input
  if (!EVENTS[kind].has(event) || !Number.isSafeInteger(startedAt) || startedAt <= 0) return null
  if (sessionId !== undefined && !isUuid(sessionId)) return null
  if (promptId !== undefined && !(kind === 'claude' ? isUuid(promptId) : isIdentifier(promptId))) return null
  if (toolUseId !== undefined && !isIdentifier(toolUseId)) return null
  if (tool !== undefined && (!TOOLS[kind].has(tool) || (tool !== 'AskUserQuestion' && event !== 'PreToolUse'))) return null
  if (event === 'Notification' ? !NOTIFICATIONS.has(notification) : notification !== undefined) return null
  if (source !== undefined && (event !== 'SessionStart' || !START_SOURCES.has(source))) return null
  if (stopHookActive !== undefined && (event !== 'Stop' || typeof stopHookActive !== 'boolean')) return null
  if (subagent !== undefined && (subagent !== true || !(SUBAGENT_DIALOG_EVENTS.has(event) ||
    (event === 'PreToolUse' && tool === 'AskUserQuestion') ||
    (event === 'Notification' && notification !== 'idle_prompt')))) return null

  return {
    kind, event, startedAt,
    ...(sessionId === undefined ? {} : { sessionId: sessionId.toLowerCase() }),
    ...(promptId === undefined ? {} : { promptId: kind === 'claude' ? promptId.toLowerCase() : promptId }),
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(tool === undefined ? {} : { tool }),
    ...(notification === undefined ? {} : { notification }),
    ...(source === undefined ? {} : { source }),
    ...(stopHookActive === undefined ? {} : { stopHookActive }),
    ...(subagent === true ? { subagent: true } : {})
  }
}

function eventFromHookFields(kind, fields, startedAt, subagent) {
  const event = fields.hook_event_name
  return validateAgentHookEvent({
    kind, event, startedAt, subagent,
    sessionId: fields.session_id,
    promptId: kind === 'codex' ? fields.turn_id : fields.prompt_id,
    toolUseId: fields.tool_use_id,
    tool: TOOLS[kind]?.has(fields.tool_name) && (fields.tool_name === 'AskUserQuestion' || event === 'PreToolUse') ? fields.tool_name : undefined,
    notification: event === 'Notification' ? fields.notification_type : undefined,
    source: event === 'SessionStart' && START_SOURCES.has(fields.source) ? fields.source : undefined,
    stopHookActive: event === 'Stop' && typeof fields.stop_hook_active === 'boolean' ? fields.stop_hook_active : undefined
  })
}

module.exports = { CLAUDE_HOOK_EVENTS, CODEX_HOOK_EVENTS, validateAgentHookEvent, eventFromHookFields }
