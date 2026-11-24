const CLOSED_LIMIT = 64
const INTERRUPT_TITLE_MS = 1000
const IDLE_TITLE_MS = 3000
const STOP_SPINNER_MS = 2000
const MISSING_DIALOG_MS = 5000
const CLOSE_TURN = new Set(['Stop', 'StopFailure', 'Interrupt'])
const CLOSE_DIALOG = new Set(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'])
const CONTINUE_TURN = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest'])
const ANONYMOUS_DIALOG = Symbol('dialog without a tool id')
const NOTIFICATION_DIALOG = Symbol('permission notification')

function remember(map, id, at) {
  if (!id) return
  if (at < (map.get(id) ?? -Infinity)) return
  map.delete(id)
  map.set(id, at)
  if (map.size > CLOSED_LIMIT) map.delete(map.keys().next().value)
}

function createAgentHookState(kind) {
  return {
    kind, phase: null, sessionId: null, sessionAt: 0, seenAt: 0, turnAt: 0, turn: null,
    closedTurns: new Map(), dialogs: new Map(), closedTools: new Map(), absentSince: null, lastStop: null
  }
}

function hookStatus(state) {
  if (!state) return null
  return state.dialogs.size ? 'blocked' : state.phase
}

function closeDialogs(state, at) {
  for (const id of state.dialogs.keys()) if (typeof id === 'string') remember(state.closedTools, id, at)
  state.dialogs.clear()
  state.absentSince = null
}

function endTurn(state, promptId, at) {
  remember(state.closedTurns, promptId ?? state.turn?.id, at)
  state.turnAt = Math.max(state.turnAt, at)
  state.turn = null
  state.phase = 'idle'
  closeDialogs(state, at)
}

function correctTurn(state, at) {
  const id = state.turn?.id
  endTurn(state, id, at)
  state.lastStop = { id, at, seenAt: at, corrected: true }
}

function reopenTurn(state, { id, at }) {
  state.closedTurns.delete(id)
  state.turn = { id, startedAt: at }
  state.phase = 'working'
  state.lastStop = null
}

function openDialog(state, key, at) {
  if (state.closedTools.has(key) || state.dialogs.has(key)) return
  state.dialogs.set(key, at)
  state.absentSince = null
}

function applyDialogHook(state, report, screenBlocked) {
  const { event, startedAt: at, toolUseId, tool, notification, subagent } = report
  if (CLOSE_DIALOG.has(event)) {
    if (!toolUseId) return
    const openedAt = state.dialogs.get(toolUseId)
    if (openedAt !== undefined && at < openedAt) return
    remember(state.closedTools, toolUseId, at)
    if (state.dialogs.delete(toolUseId) && !subagent) state.phase = 'working'
  } else if (event === 'PermissionRequest' || (event === 'PreToolUse' && tool === 'AskUserQuestion') ||
      event === 'Elicitation' || notification === 'elicitation_dialog' ||
      (notification === 'permission_prompt' && screenBlocked && !state.dialogs.size)) {
    openDialog(state, toolUseId ?? (notification === 'permission_prompt' ? NOTIFICATION_DIALOG : ANONYMOUS_DIALOG), at)
  }
}

function applyAgentHook(state, report, seenAt, { sleeping = false, stopBlocked = false, screenBlocked = false } = {}) {
  const { event, promptId, sessionId, startedAt: at, notification } = report
  if (event === 'SessionEnd' && sleeping) return
  state.seenAt = seenAt
  if (report.subagent) {
    if (state.phase !== 'ended' && at >= state.turnAt) applyDialogHook(state, report, screenBlocked)
    return
  }

  if (event === 'SessionStart') {
    if (at < state.sessionAt || (sessionId && sessionId !== state.sessionId && at < state.turnAt)) return
    state.sessionAt = at
    if (sessionId) state.sessionId = sessionId
    if (!state.turn) {
      state.phase = 'idle'
      state.lastStop = null
    }
    return
  }
  if (sessionId && state.sessionId && sessionId !== state.sessionId) return
  if (sessionId && !state.sessionId) {
    state.sessionId = sessionId
    state.sessionAt = at
  }
  if (at < state.sessionAt && !state.turn) return
  if (state.phase === 'ended') return
  if (event === 'SessionEnd') {
    if (at < state.turnAt) return
    endTurn(state, promptId, at)
    state.phase = 'ended'
    state.lastStop = null
    return
  }
  if ((promptId && at <= (state.closedTurns.get(promptId) ?? -Infinity)) || at < state.turnAt) return

  if (event === 'UserPromptSubmit') {
    if (state.turn && (state.turn.id === promptId || (!promptId && state.turn.id))) return
    closeDialogs(state, at)
    state.turn = { id: promptId, startedAt: at }
    state.turnAt = at
    state.phase = 'working'
    state.lastStop = null
    return
  }
  if (state.turn?.id && promptId && state.turn.id !== promptId) {
    if (CLOSE_TURN.has(event)) remember(state.closedTurns, promptId, at)
    return
  }
  const stop = state.lastStop
  if (stop?.corrected && promptId && promptId === stop.id && at > stop.at && CONTINUE_TURN.has(event)) {
    reopenTurn(state, stop)
  }
  if (CLOSE_TURN.has(event)) {
    if (event === 'Stop' && stopBlocked) {
      state.turn ??= { id: promptId, startedAt: at }
      state.turnAt = Math.max(state.turnAt, at)
      state.phase = 'working'
      state.lastStop = null
    } else {
      const id = promptId ?? state.turn?.id
      endTurn(state, id, at)
      state.lastStop = event === 'Stop' ? { id, at, seenAt } : null
    }
    return
  }
  applyDialogHook(state, report, screenBlocked)
  if (event === 'PreCompact') {
    state.phase = 'working'
    state.lastStop = null
  } else if ((event === 'PostCompact' || notification === 'idle_prompt') && !state.turn && !state.dialogs.size) {
    state.phase = 'idle'
  }
}

/** Apply screen/title fallbacks and return the next time they need a check, if any. */
function reconcileAgentHook(state, { now, title, screenBlocked, interruptedAt }) {
  const status = hookStatus(state)
  const claude = state.kind === 'claude'
  const afterUserInterrupt = claude && title?.status === 'idle' &&
    title.since >= interruptedAt && title.since - interruptedAt <= INTERRUPT_TITLE_MS
  if (status === 'blocked') {
    if (screenBlocked) {
      state.absentSince = null
      return null
    }
    if (afterUserInterrupt && [...state.dialogs.values()].every(openedAt => openedAt <= interruptedAt)) {
      correctTurn(state, now)
      return null
    }
    state.absentSince ??= now
    const deadline = state.absentSince + MISSING_DIALOG_MS
    if (now < deadline) return deadline
    closeDialogs(state, now)
    state.phase = null
    return null
  }
  if (!claude || screenBlocked || !title) return null
  if (status === 'working' && title.status === 'idle') {
    const deadline = Math.max(title.since, state.seenAt) + IDLE_TITLE_MS
    const interruptedTurn = afterUserInterrupt && state.turn?.startedAt <= interruptedAt
    if (!interruptedTurn && now < deadline) return deadline
    correctTurn(state, now)
  } else if (status === 'idle' && state.lastStop && title.status === 'working') {
    const deadline = Math.max(title.since, state.lastStop.seenAt) + STOP_SPINNER_MS
    if (now < deadline) return deadline
    if (title.at <= state.lastStop.seenAt) return null
    reopenTurn(state, state.lastStop)
  }
  return null
}

module.exports = { createAgentHookState, hookStatus, applyAgentHook, reconcileAgentHook }
