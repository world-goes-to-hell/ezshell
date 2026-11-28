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

// The session host keeps metadata as JSON. Only the reducer's bounded state goes with a kept shell.
function exportAgentHookState(state) {
  if (!state || state.phase === 'ended') return null
  const { closedTurns, dialogs, closedTools, ...fields } = state
  return {
    ...fields,
    closedTurns: [...closedTurns],
    dialogs: [...dialogs].slice(-CLOSED_LIMIT).map(([id, at]) => [id === ANONYMOUS_DIALOG ? null : id === NOTIFICATION_DIALOG ? '' : id, at]),
    closedTools: [...closedTools]
  }
}

function restoreAgentHookState(saved, kind, now) {
  if (saved?.kind !== kind || ![null, 'idle', 'working'].includes(saved.phase)) return null
  const time = value => Number.isSafeInteger(value) && value >= 0 && value <= now
  const id = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(value)
  const sessionId = typeof saved.sessionId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(saved.sessionId)
    ? saved.sessionId : null
  if (!time(saved.seenAt) || !time(saved.sessionAt) || !time(saved.turnAt)) return null
  const pairs = (value, key) => new Map(Array.isArray(value) ? value.slice(-CLOSED_LIMIT).flatMap(pair => {
    if (!Array.isArray(pair) || pair.length !== 2 || !time(pair[1])) return []
    const normalized = key(pair[0])
    return normalized === undefined ? [] : [[normalized, pair[1]]]
  }) : [])
  const named = value => id(value) ? value : undefined
  const knownTurn = saved.turn && time(saved.turn.startedAt) && (saved.turn.id === undefined || id(saved.turn.id))
  const lastStop = saved.lastStop
  return {
    kind, phase: saved.phase, sessionId, seenAt: saved.seenAt, sessionAt: saved.sessionAt, turnAt: saved.turnAt,
    turn: knownTurn ? { id: saved.turn.id, startedAt: saved.turn.startedAt } : null,
    closedTurns: pairs(saved.closedTurns, named),
    dialogs: pairs(saved.dialogs, value => value === null ? ANONYMOUS_DIALOG : value === '' ? NOTIFICATION_DIALOG : named(value)),
    closedTools: pairs(saved.closedTools, named),
    absentSince: null,
    lastStop: lastStop && time(lastStop.at) && time(lastStop.seenAt)
      ? { id: named(lastStop.id), at: lastStop.at, seenAt: lastStop.seenAt, corrected: lastStop.corrected === true } : null
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

// A kept CLI can finish while no unlocked app is listening to its hooks. Preserve the old turn's
// ordering boundary and give the live screen control until the next authenticated event.
function endAgentHookHandoff(state) {
  endTurn(state, state.turn?.id, Math.max(state.turnAt, state.seenAt))
  state.phase = null
  state.lastStop = null
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
  if (event === 'SessionEnd' && sleeping) return false
  state.seenAt = seenAt
  if (report.subagent) {
    if (state.phase !== 'ended' && at >= state.turnAt) applyDialogHook(state, report, screenBlocked)
    return false
  }

  if (event === 'SessionStart') {
    if (at < state.sessionAt || (sessionId && sessionId !== state.sessionId && at < state.turnAt)) return false
    state.sessionAt = at
    if (sessionId) state.sessionId = sessionId
    if (!state.turn) {
      state.phase = 'idle'
      state.lastStop = null
    }
    return true
  }
  if (sessionId && state.sessionId && sessionId !== state.sessionId) return false
  if (sessionId && !state.sessionId) {
    state.sessionId = sessionId
    state.sessionAt = at
  }
  if (at < state.sessionAt && !state.turn) return false
  if (state.phase === 'ended') return false
  if (event === 'SessionEnd') {
    if (at < state.turnAt) return false
    endTurn(state, promptId, at)
    state.phase = 'ended'
    state.lastStop = null
    return true
  }
  if ((promptId && at <= (state.closedTurns.get(promptId) ?? -Infinity)) || at < state.turnAt) return false

  if (event === 'UserPromptSubmit') {
    if (state.turn && (state.turn.id === promptId || (!promptId && state.turn.id))) return false
    closeDialogs(state, at)
    state.turn = { id: promptId, startedAt: at }
    state.turnAt = at
    state.phase = 'working'
    state.lastStop = null
    return true
  }
  if (state.turn?.id && promptId && state.turn.id !== promptId) {
    if (CLOSE_TURN.has(event)) remember(state.closedTurns, promptId, at)
    return false
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
    return true
  }
  applyDialogHook(state, report, screenBlocked)
  if (event === 'PreCompact') {
    state.phase = 'working'
    state.lastStop = null
  } else if ((event === 'PostCompact' || notification === 'idle_prompt') && !state.turn && !state.dialogs.size) {
    state.phase = 'idle'
  }
  return true
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

module.exports = { createAgentHookState, exportAgentHookState, restoreAgentHookState, hookStatus, applyAgentHook, reconcileAgentHook, endAgentHookHandoff }
