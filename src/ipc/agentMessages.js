const net = require('net')
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('crypto')
const fs = require('fs')
const { homedir, tmpdir } = require('os')
const path = require('path')
const { validateRole } = require('./agentRole.js')
const { createAgentRoleStore, roleSessionKey } = require('./agentRoleStore.js')
const { HUMAN_BLOCK_LABELS, publicBlock, validEscalationReason } = require('./agentInspection.js')

const MAX_REQUEST = 64 * 1024
const MAX_MESSAGES = 500
const MAX_TEXT = 8000
const INBOX_WAIT_MS = 30000
const RECONNECT_LIFETIME_MS = 24 * 60 * 60 * 1000
const RECONNECT_AFTER_CLOSE_MS = 5 * 60 * 1000
const RECONNECT_TOKEN = /^[a-z0-9_-]{43}$/i
const reconnectDigest = token => createHash('sha256').update(token).digest()
const USER = 'user'
const { sanitizeUsage, sameUsage } = require('./agentUsage.js')
const { antigravityStatusFromInput, antigravityStatusSettings } = require('./antigravityStatusReport.js')
const { CLAUDE_HOOK_EVENTS, validateAgentHookEvent } = require('./agentHookEvent.js')
const { HOOK_COMMANDS } = require('../agentHookReport.js')
const { CODEX_HOOK_ARGS } = require('./codexHookLaunch.js')
const { PROMPT, REMIND_PROMPT } = require('./agentInboxPrompts.js')
const MAX_HOOK_EVENTS = 32
const STOP_CHECK_WAIT_MS = 1500
const CODEX_HOOK_MODE_FILE = 'codex-hook-mode'
const CODEX_HOOK_MODES = new Set(['pending', 'approved', 'disabled'])
const STATUS_SOURCES = new Set(['hook', 'screen'])
const CLAUDE_SETTINGS_FILE = 'agent-settings.json'
const CLAUDE_TOOL_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])
const CLAUDE_HOOKS = Object.fromEntries(CLAUDE_HOOK_EVENTS.map(event => [event, [{
  ...(CLAUDE_TOOL_HOOKS.has(event) ? { matcher: '*' } : {}),
  ...(event === 'Notification' ? { matcher: 'permission_prompt|elicitation_dialog|idle_prompt' } : {}),
  hooks: [{ type: 'command', command: HOOK_COMMANDS.claude, ...(event === 'Stop' ? { timeout: 5 } : { async: true }) }]
}]]))

function claudeSettings(enabled) {
  return JSON.stringify({
    statusLine: { type: 'command', command: 'ELECTRON_RUN_AS_NODE=1 "$EZSHELL_CLI_EXE" "$EZSHELL_AGENT_USAGE_SCRIPT"', padding: 0 },
    ...(enabled ? { hooks: CLAUDE_HOOKS } : {})
  })
}

function writeAgentFile(file, data) {
  const temporary = file + '.' + randomUUID()
  try {
    fs.writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function createAgentMessages({ notify, isLocked, onInboxChanged = () => {}, onInboxRead, bindLocalAgent, reportLocalAntigravity, onAgentHook,
  inspectLocalAgent, onEscalate,
  bridgeFile, roleFile, codexHookTrustFile, platform = process.platform, home = homedir(), now = Date.now }) {
  const instanceBridgeFile = bridgeFile ? `${bridgeFile}.${process.pid}` : null
  const agents = new Map()
  const roleStore = createAgentRoleStore(roleFile)
  const roleSessions = new Map()
  const roleConflicts = new Map()
  const pendingRoles = new Map()
  const tokens = new Map()
  const mcpReady = new Map()
  const escalated = new Map()
  const bridgeToken = randomUUID()
  const leases = new Map()
  const reconnects = new Map()
  // agent id → latest usage (agentUsage.js shape)
  const usages = new Map()
  // Private per-agent hook history. It is deliberately absent from the renderer snapshot.
  const hookEvents = new Map()
  const hookSessions = new Map()
  const codexRoleLaunches = new Map()
  const stopChecks = new Map()
  // Every local shell's token → its id, for the status line of a Claude typed into it (registerShell)
  const shellTokens = new Map()
  const messages = []
  const sockets = new Set()
  const inboxWaits = new Map()
  let serial = 0
  let revision = 0
  let roleEpoch = 0
  let runtime
  let server
  let directory
  let pipe
  let antigravityStatusForward
  let antigravityReportSequence = 0
  let hooksEnabled = true
  let codexHookMode = 'pending'
  if (codexHookTrustFile) {
    try {
      const saved = fs.readFileSync(codexHookTrustFile, 'utf8').trim()
      if (CODEX_HOOK_MODES.has(saved)) codexHookMode = saved
    } catch {}
  }

  const runtimeCodexMode = () => hooksEnabled ? codexHookMode : 'disabled'

  function updateHookFiles(enabled, mode) {
    const runtimeMode = enabled ? mode : 'disabled'
    const changes = []
    if (directory && enabled !== hooksEnabled) {
      changes.push([path.join(directory, CLAUDE_SETTINGS_FILE), claudeSettings(enabled), claudeSettings(hooksEnabled)])
    }
    if (directory && runtimeMode !== runtimeCodexMode()) {
      changes.push([path.join(directory, CODEX_HOOK_MODE_FILE), runtimeMode + '\n', runtimeCodexMode() + '\n'])
    }
    if (codexHookTrustFile && mode !== codexHookMode) {
      changes.push([codexHookTrustFile, mode + '\n', codexHookMode + '\n'])
    }
    const applied = []
    try {
      for (const [file, data, previous] of changes) {
        writeAgentFile(file, data)
        applied.push([file, previous])
      }
    } catch {
      for (const [file, previous] of applied.reverse()) {
        try { writeAgentFile(file, previous) } catch {}
      }
      return false
    }
    hooksEnabled = enabled
    codexHookMode = mode
    return true
  }

  function setCodexHookMode(mode) {
    if (!hooksEnabled || !CODEX_HOOK_MODES.has(mode)) return false
    if (mode === codexHookMode) return true
    if (!updateHookFiles(true, mode)) return false
    if (mode === 'disabled') notify('codex-hooks-declined')
    return true
  }

  function configureHooks(request) {
    const { enabled, resetCodexDecline } = request ?? {}
    if (typeof enabled !== 'boolean') return { success: false, codexMode: runtimeCodexMode() }
    const mode = enabled && resetCodexDecline === true && codexHookMode === 'disabled' ? 'pending' : codexHookMode
    const success = updateHookFiles(enabled, mode)
    if (success && !enabled) {
      for (const id of agents.keys()) forgetHookData(id)
    }
    return { success, codexMode: runtimeCodexMode() }
  }

  const publicMessage = ({ requestId, ...message }) => message
  const roleNames = id => {
    const binding = roleSessions.get(id)
    const saved = binding && (roleStore.get(binding.key) ?? binding.inherit)
    return { ...saved, ...pendingRoles.get(id) }
  }
  const activeRole = id => {
    const { user, agent } = roleNames(id)
    if (user) return { role: user, roleSource: 'user' }
    if (agent) return { role: agent, roleSource: 'agent' }
    return { role: null, roleSource: null }
  }

  function saveRoles(id, binding, patch) {
    roleStore.update(binding.key, { ...pendingRoles.get(id), ...patch }, binding.inherit)
    binding.saved = true
    binding.inherit = undefined
    pendingRoles.delete(id)
  }

  function setRole(id, input, source) {
    if (isLocked()) throw new Error('먼저 앱 잠금을 해제해 주세요.')
    const agent = agents.get(id)
    if (!agent || (source === 'agent' && !agent.active)) throw new Error('에이전트를 찾을 수 없습니다.')
    const role = validateRole(input, source)
    const binding = roleSessions.get(id)
    const previous = roleNames(id)[source]
    if (binding) {
      try {
        saveRoles(id, binding, { [source]: role })
      } catch {
        throw new Error('에이전트 역할을 저장할 수 없습니다.')
      }
    } else {
      if (previous === role) return { id, ...activeRole(id) }
      // An explicit clear must still apply if a saved role appears when the session resolves.
      pendingRoles.set(id, { ...pendingRoles.get(id), [source]: role })
    }
    if (binding || (previous ?? '') !== role) changed()
    return { id, ...activeRole(id) }
  }

  function bindRoleSession(id, sessionId, explicitResume = false) {
    const agent = agents.get(id)
    if (!agent?.active) return false
    const key = roleSessionKey(agent.kind, sessionId)
    if (!key) return false
    let binding = roleSessions.get(id)
    if (binding?.key === key && binding.saved) return false
    for (const [otherId, other] of roleSessions) {
      if (otherId === id || other.key !== key || !agents.get(otherId)?.active) continue
      const takesPriority = explicitResume && !other.explicitResume
      const conflict = `${otherId}:${key}`
      if (roleConflicts.get(id) !== conflict) {
        console.warn(`[agent roles] ${id} and ${otherId} reported the same ${agent.kind} conversation. Keeping ${takesPriority ? id : otherId}.`)
      }
      if (!takesPriority) {
        roleConflicts.set(id, conflict)
        return false
      }
      roleSessions.delete(otherId)
      roleConflicts.set(otherId, `${id}:${key}`)
    }
    roleConflicts.delete(id)
    const before = activeRole(id)
    if (binding?.key !== key) {
      const inherit = binding ? roleNames(id) : undefined
      if (binding) pendingRoles.delete(id)
      binding = { key, inherit, saved: false, explicitResume }
      roleSessions.set(id, binding)
    }
    // Keep the pending edits and retry on the next verified observation if the file cannot be written.
    try { saveRoles(id, binding) } catch {}
    const after = activeRole(id)
    return before.role !== after.role || before.roleSource !== after.roleSource
  }

  /** Identity from main's verified process or transcript discovery. Usage reports carry no authority. */
  function setVerifiedSession(id, sessionId) {
    if (bindRoleSession(id, sessionId)) changed()
  }

  /** A watcher proof may persist a fresh Codex's roles while its original authenticated hook agrees. */
  const freshRoleEpoch = () => isLocked() ? null : roleEpoch

  function setFreshCodexRoleSession(id, sessionId, startedAt, epoch) {
    if (epoch === null || epoch !== freshRoleEpoch()) return false
    const agent = agents.get(id)
    const launch = codexRoleLaunches.get(id)
    if (!agent?.active || agent.kind !== 'codex' || !agent.shellId || agent.sleeping || agent.resumeId ||
        !launch || launch.changedSession || launch.startedAt !== startedAt ||
        !sessionId || launch.hookId !== sessionId || hookSessions.get(id) !== sessionId) return false
    const key = roleSessionKey('codex', sessionId)
    if (!key) return false
    const before = roleSessions.get(id)?.key
    const roleChanged = bindRoleSession(id, sessionId)
    const binding = roleSessions.get(id)
    if (binding?.key !== key || binding.explicitResume) return false
    binding.freshCodex = true
    if (roleChanged || before !== key) changed()
    return binding.saved
  }

  function setHookSession(id, sessionId) {
    if (!agents.get(id)?.active || hookSessions.get(id) === sessionId) return
    hookSessions.set(id, sessionId)
    clearUsage(id)
    const launch = codexRoleLaunches.get(id)
    if (!launch) return
    launch.hookId ??= sessionId
    if (launch.hookId === sessionId) return
    launch.changedSession = true
    if (!roleSessions.get(id)?.freshCodex) return
    // This CLI opened another conversation. The last saved roles are still useful in this pane,
    // but edits now belong to its in-memory roles until the CLI is reopened.
    const { user, agent } = roleNames(id)
    pendingRoles.set(id, { user, agent })
    roleSessions.delete(id)
    changed()
  }

  function forgetHookData(id) {
    hookEvents.delete(id)
    hookSessions.delete(id)
    clearTimeout(stopChecks.get(id)?.timer)
    stopChecks.delete(id)
    escalated.delete(id)
  }

  function forgetAgent(id) {
    agents.delete(id)
    codexRoleLaunches.delete(id)
    forgetHookData(id)
    reconnects.delete(id)
    roleSessions.delete(id)
    roleConflicts.delete(id)
    pendingRoles.delete(id)
  }
  // `read`: handled (answered or acknowledged). `seenAt`: when the recipient took it from its inbox, the
  // "읽음" the sender and the messages panel see (check_sent). Receipts were removed on 2026-11-20.
  function readInbox(id, unread) {
    const taken = messages.filter(message => message.to === id && (!unread || !message.read))
    const now = Date.now()
    let seen = false
    for (const message of taken) {
      if (message.seenAt) continue
      message.seenAt = now
      seen = true
    }
    if (seen) {
      changed()
      const shellId = agents.get(id)?.shellId
      if (shellId) onInboxRead?.(shellId)
    }
    return taken.map(({ reviewRequest, ...message }) => publicMessage(message))
  }

  const PREVIEW_CHARS = 200
  const SENT_LIMIT = 20
  /** The sender's view of what it sent: unread / read (taken, no answer yet) / answered */
  function sentStatus(from, ids) {
    const mine = messages.filter(message => message.from === from && (!ids || ids.includes(message.id)))
    return mine.slice(ids ? 0 : -SENT_LIMIT).map(message => {
      const reply = messages.find(item => item.replyTo === message.id && item.from === message.to)
      const status = message.read || reply ? 'answered' : message.seenAt ? 'read' : 'unread'
      return {
        id: message.id,
        to: message.to,
        text: message.text.length > PREVIEW_CHARS ? message.text.slice(0, PREVIEW_CHARS) + '…' : message.text,
        sentAt: message.sentAt,
        status,
        readAt: message.seenAt ?? null,
        ...(status === 'answered' ? { answer: reply ? { kind: 'reply', id: reply.id } : { kind: 'acknowledged' } } : {})
      }
    })
  }
  // The relationship map keeps card positions by conversation: an opaque key, never the conversation id
  const layoutKeyOf = id => {
    const key = roleSessions.get(id)?.key
    return key ? createHash('sha256').update('agent-map-layout:' + key).digest('hex').slice(0, 16) : null
  }
  function snapshot() {
    const waiting = new Set(Array.from(inboxWaits.values(), wait => wait.agentId))
    return {
      revision,
      agents: Array.from(agents.values(), ({ statusSource, ...agent }) => ({
        ...agent,
        ...(statusSource && agent.active && !agent.sleeping ? { statusSource } : {}),
        ...activeRole(agent.id),
        layoutKey: layoutKeyOf(agent.id),
        waitingForReply: waiting.has(agent.id),
        mcpConnected: mcpReady.has(agent.id)
      })),
      messages: messages.map(publicMessage)
    }
  }
  function changed(delivery) {
    revision++
    notify('agent-messages-state', snapshot())
    if (delivery) notify('agent-message-delivered', delivery)
  }

  function deliver(from, request) {
    const { text, replyTo, requestId, replyStatus } = request
    // An agent started before the update still has send_receipt: taken as a reply it would close the
    // request without its result, so it is refused with what to do instead
    if (request.receipt === true) throw new Error('수신 확인은 없어졌습니다. 상대는 읽음 여부를 check_sent 로 봅니다. 결과는 reply_to_message 로 보내 주세요.')
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new Error('메시지를 1~8000자로 입력해 주세요.')
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId || requestId.length > 100)) throw new Error('요청 ID가 올바르지 않습니다.')
    if (replyStatus !== undefined && (replyTo === undefined || !['completed', 'deferred'].includes(replyStatus))) {
      throw new Error('답장 상태를 확인해 주세요.')
    }
    const original = replyTo === undefined ? null : messages.find(item => item.id === replyTo && item.to === from)
    if (replyTo !== undefined && !original) throw new Error('답장할 메시지를 찾을 수 없습니다.')
    const to = original ? original.from : request.to
    const existing = requestId && messages.find(item => item.from === from && item.requestId === requestId)
    if (existing) {
      if (existing.to !== to || existing.text !== text || existing.replyTo !== replyTo || existing.replyStatus !== replyStatus) {
        throw new Error('같은 요청 ID에 다른 내용이 있습니다.')
      }
      return { id: existing.id }
    }
    if (from === to || (to !== USER && !isConnected(to))) throw new Error('메시지를 받을 실행 중인 에이전트를 찾을 수 없습니다.')
    if (messages.length >= MAX_MESSAGES) throw new Error('이번 실행의 메시지 한도에 도달했습니다.')
    const message = { id: randomUUID(), from, to, text, replyTo, requestId, sentAt: Date.now(), read: false, seenAt: null }
    if (replyStatus) message.replyStatus = replyStatus
    if (from === USER && request.reviewRequest) message.reviewRequest = request.reviewRequest
    messages.push(message)
    if (original) original.read = true
    let deliveredToWaiter = false
    for (const [socket, wait] of inboxWaits) {
      if (wait.agentId !== to || socket.destroyed) continue
      finishWait(socket, { success: true, messages: readInbox(to, true) })
      deliveredToWaiter = true
    }
    changed({ id: message.id, from, to, toShell: agents.get(to)?.shellId })
    const recipient = agents.get(to)?.shellId
    if (recipient && !deliveredToWaiter) onInboxChanged(recipient)
    return { id: message.id }
  }

  function acknowledge(id, recipient) {
    const message = messages.find(item => item.id === id && item.to === recipient)
    if (!message) throw new Error('메시지를 찾을 수 없습니다.')
    if (!message.read) {
      message.read = true
      changed()
    }
    return { id }
  }

  function applyHook(agent, event, checkStop = false) {
    const accepted = onAgentHook?.(agent.shellId, agent.id, event, { checkStop })
    if (accepted && event.kind === 'codex' && !event.subagent && codexHookMode === 'pending') setCodexHookMode('approved')
    return accepted
  }

  function finishStopCheck(agent, pending, checkStop) {
    clearTimeout(pending.timer)
    stopChecks.delete(agent.id)
    if (isLocked() || !agents.get(agent.id)?.active) return null
    const block = applyHook(agent, pending.event, checkStop)?.block
    return block === PROMPT || block === REMIND_PROMPT ? block : null
  }

  function receiveHook(agent, request) {
    if (!hooksEnabled) return request.method === 'stop-check' ? { block: null } : { stored: false }
    const event = validateAgentHookEvent(request)
    if (!event || !agent?.active || !agent.shellId || agent.kind !== event.kind) return { stored: false }
    const pending = stopChecks.get(agent.id)
    if (request.method === 'stop-check') {
      if (event.event !== 'Stop') return { stored: false }
      const recorded = pending?.event
      if (!recorded || event.promptId !== recorded.promptId || event.startedAt !== recorded.startedAt || event.sessionId !== recorded.sessionId) {
        return { block: null }
      }
      return { block: finishStopCheck(agent, pending, true) }
    }
    const events = hookEvents.get(agent.id) ?? []
    events.push(event)
    if (events.length > MAX_HOOK_EVENTS) events.shift()
    hookEvents.set(agent.id, events)
    if (event.event === 'Stop' && pending) finishStopCheck(agent, pending, false)
    if (event.event === 'Stop' && request.checkStop === true) {
      const stop = { event, timer: setTimeout(() => finishStopCheck(agent, stop, false), STOP_CHECK_WAIT_MS) }
      stop.timer.unref?.()
      stopChecks.set(agent.id, stop)
    } else {
      applyHook(agent, event)
    }
    return { stored: true }
  }

  function respond(request, socket) {
    const hookReport = request?.method === 'agent-event' || request?.method === 'stop-check'
    // Reports from a CLI started in a plain local shell can use its shell token.
    if ((request?.method === 'usage' || hookReport) && typeof request.shellToken === 'string') {
      const shellId = shellTokens.get(request.shellToken)
      if (!shellId) throw new Error('ezShell 로컬 터미널에서 실행해 주세요.')
      if (isLocked()) throw new Error('먼저 앱 잠금을 해제해 주세요.')
      const kind = hookReport ? request.kind : 'claude'
      const agent = [...agents.values()].find(candidate => candidate.shellId === shellId && candidate.active && candidate.kind === kind)
      if (hookReport) return receiveHook(agent, request)
      return { stored: agent ? setUsage(agent.id, request.usage) : false }
    }
    const from = tokens.get(request?.token)
    if (!from) throw new Error('활성 ezShell 에이전트 세션에서 실행해 주세요.')
    if (isLocked()) throw new Error('먼저 앱 잠금을 해제해 주세요.')
    switch (request.method) {
      case 'list': return { agents: [...agents.values()].filter(agent => isConnected(agent.id)).map(({ id, kind, cwd }) => ({ id, kind, cwd, role: activeRole(id).role })), self: from }
      case 'inspect-agent': return inspectAgent(request.id).state
      case 'escalate': return escalate(request.id, request.reason)
      case 'set-role': return setRole(from, request.role, 'agent')
      case 'inbox': return { messages: readInbox(from, request.unread) }
      case 'wait-inbox': {
        const unread = readInbox(from, true)
        if (unread.length) return { messages: unread }
        waitForInbox(socket, from)
        return null
      }
      case 'ack': return acknowledge(request.id, from)
      case 'sent': {
        const ids = request.ids
        if (ids !== undefined && (!Array.isArray(ids) || ids.length > SENT_LIMIT || ids.some(value => typeof value !== 'string' || value.length > 100))) {
          throw new Error('메시지 ID 목록이 올바르지 않습니다.')
        }
        return { messages: sentStatus(from, ids) }
      }
      // From the status line command of a Claude ezShell launched: saved as this agent's usage only
      case 'usage': return { stored: setUsage(from, request.usage) }
      case 'agent-event':
      case 'stop-check': return receiveHook(agents.get(from), request)
      case 'send': return deliver(from, request)
      default: throw new Error('지원하지 않는 명령입니다.')
    }
  }

  // A sleeping agent (agentIdle.js: its CLI was closed to save memory, it comes back on its next message)
  // still takes messages: they wait in its inbox and wake it
  function isConnected(id) {
    const agent = agents.get(id)
    if (agent?.active === true && agent.sleeping) return true
    const lease = mcpReady.get(id)
    return agent?.active === true && lease != null && !lease.destroyed
  }

  function inspectAgent(id) {
    const agent = agents.get(id)
    const local = agent?.active && !agent.sleeping && agent.shellId ? inspectLocalAgent?.(agent.shellId, id) : null
    // Both MCP peers and verified local shells belong to this app instance. A startup trust screen
    // can block a registered local agent before its MCP lease connects.
    if (!agent || (agent.active && !isConnected(id) && !local)) throw new Error('에이전트를 찾을 수 없습니다.')
    const blocked = agent.active ? publicBlock(local?.blocked) : { kind: 'ended' }
    return {
      agent, ticket: local?.ticket,
      state: {
        id, status: local?.status ?? agent.status,
        statusSource: (local ? local.statusSource : agent.active ? agent.statusSource : null) ?? null,
        blocked, unread: unreadMessages(id).length, idleFor: local?.idleFor ?? null, exitCode: agent.exitCode ?? null
      }
    }
  }

  function escalate(id, reason) {
    if (!validEscalationReason(reason)) throw new Error('사유는 200자 이내 한 줄로 입력해 주세요.')
    const { state, agent, ticket } = inspectAgent(id)
    const kind = state.blocked?.kind
    if (!ticket || !Object.hasOwn(HUMAN_BLOCK_LABELS, kind)) throw new Error('사용자 응답을 기다리는 화면이 없습니다.')
    if (escalated.get(id) === ticket) return { notified: false }
    if (!onEscalate?.({ id, shellId: agent.shellId, kind })) throw new Error('앱 알림을 표시할 수 없습니다.')
    escalated.set(id, ticket)
    return { notified: true }
  }

  function stopWaiting(id) {
    for (const [socket, wait] of inboxWaits) {
      if (wait.agentId === id) finishWait(socket, inactiveError())
    }
  }

  function archiveExternal(id) {
    const agent = agents.get(id)
    if (!agent) return
    reconnects.delete(id)
    // Asleep: its CLI and MCP went away on purpose; it is kept (with its usage and session id) to be resumed
    if (agent.sleeping) {
      stopWaiting(id)
      return
    }
    clearUsage(id)
    forgetHookData(id)
    if (messages.some(message => message.from === id || message.to === id)) {
      agents.set(id, { ...agent, shellId: '', active: false, status: 'ended' })
    } else {
      forgetAgent(id)
    }
    stopWaiting(id)
  }

  function endExternal(id) {
    const socket = mcpReady.get(id)
    const lease = leases.get(socket)
    if (lease?.external) {
      tokens.delete(lease.token)
      mcpReady.delete(id)
      socket.destroy()
    }
    // Put to sleep on purpose: kept, under the same id, for the CLI resumed in its shell (archiveExternal)
    archiveExternal(id)
    changed()
  }

  /** The agent's CLI is being closed to save memory: it stays listed and takes messages (session id to resume) */
  function sleep(id, sessionId) {
    const agent = agents.get(id)
    if (!agent?.active) return false
    agents.set(id, { ...agent, sleeping: true, status: 'sleeping', ...(sessionId ? { resumeId: sessionId } : {}) })
    changed()
    return true
  }

  /** Not resuming after all (closing failed, the shell was closed, the user kept the terminal) */
  function cancelSleep(id, { ended }) {
    const agent = agents.get(id)
    if (!agent?.sleeping) return
    const { sleeping, ...rest } = agent
    agents.set(id, { ...rest, status: 'idle' })
    if (ended) archiveExternal(id)
    changed()
  }

  function setStatus(id, status, source) {
    const agent = agents.get(id)
    const statusSource = STATUS_SOURCES.has(source) ? source : undefined
    if (!agent?.active || agent.sleeping || (agent.status === status && agent.statusSource === statusSource)) return
    agents.set(id, { ...agent, status, statusSource })
    changed()
  }

  function attachExternal(kind, cwd, attach, startedAt, requireShell = false) {
    let id = `${kind}-${++serial}`
    const binding = attach?.({ agentId: id, setStatus: (status, source) => setStatus(id, status, source), onExit: endExternal })
    if (!binding && requireShell) return null
    id = binding?.agentId ?? id
    const before = agents.get(id)
    // Woken from sleep under the same id, with the session it was asked to resume
    const resumeId = before?.sleeping ? before.resumeId : binding?.resumeId
    const launch = binding?.codexProcessStartedAt
    if (!before && kind === 'codex' && !resumeId && Number.isSafeInteger(launch) && launch > 0 && binding.codexRoleCwd) {
      codexRoleLaunches.set(id, { startedAt: launch, cwd: binding.codexRoleCwd })
    }
    agents.set(id, {
      id, shellId: binding?.shellId ?? '', kind, cwd, active: true, status: binding?.status ?? 'unknown',
      ...(STATUS_SOURCES.has(binding?.statusSource) ? { statusSource: binding.statusSource } : {}),
      startedAt: before?.startedAt ?? startedAt, ...(resumeId ? { resumeId } : {})
    })
    return { id, binding }
  }

  /** A CLI discovered in a local shell can use chat before it has any message MCP connection. */
  function registerLocalClaude({ cwd, startedAt, sessionId }, attach) {
    const attached = attachExternal('claude', cwd, attach, startedAt, true)
    if (attached) {
      bindRoleSession(attached.id, sessionId)
      changed()
    }
  }

  function registerLocalAntigravity(cwd, attach, sessionId) {
    const attached = attachExternal('antigravity', cwd, attach, Date.now(), true)
    if (!attached) return false
    bindRoleSession(attached.id, sessionId)
    changed()
    return true
  }

  async function reportAntigravity(request, socket) {
    const shellId = shellTokens.get(request.token)
    const isCurrent = () => Boolean(shellId && shellTokens.get(request.token) === shellId && !isLocked() && !socket.destroyed)
    const status = antigravityStatusFromInput(request.value, platform)
    if (!isCurrent() || !status || !Number.isSafeInteger(request.pid) || request.pid <= 0) return { stored: false }
    const sequence = ++antigravityReportSequence
    return { stored: Boolean(await reportLocalAntigravity?.({ shellId, pid: request.pid, status, sequence, isCurrent })) }
  }

  function authenticReconnect(id, token) {
    const credential = reconnects.get(id)
    return credential && credential.expiresAt > now() && typeof token === 'string' &&
      RECONNECT_TOKEN.test(token) && timingSafeEqual(credential.digest, reconnectDigest(token))
  }

  async function watchMcp(request, socket) {
    const { kind } = request
    let token = request.token
    let id = tokens.get(token)
    const external = id === undefined
    let binding
    let authorized = false
    const localKind = kind === 'claude' || kind === 'codex'
    const registrationError = 'ezShell에 등록된 에이전트가 아닙니다.'
    if (!external && kind !== undefined && !localKind) throw new Error(registrationError)
    if (external) {
      const waking = request.wakeToken !== undefined
      const localClaude = request.shellToken !== undefined
      const shellToken = waking ? request.wakeToken : request.shellToken
      const shellId = shellTokens.get(shellToken)
      const validKind = localClaude ? !waking && kind === 'claude' : localKind || (!waking && kind === 'aside')
      if (!validKind || (waking || localClaude ? !shellId : !bridgeFile || token !== bridgeToken)
        || typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd) || request.cwd.length > 4096) {
        throw new Error(registrationError)
      }
      const attach = localKind && Number.isSafeInteger(request.pid) && request.pid > 0
        ? await bindLocalAgent?.({ pid: request.pid, kind, shellId, cwd: request.cwd })
        : undefined
      if (socket.destroyed) return
      if (shellId && (!attach || shellTokens.get(shellToken) !== shellId)) throw new Error('ezShell 로컬 터미널 연결을 확인할 수 없습니다.')
      let authorizedId
      const authorizeBinding = (existingId, resuming = false, sameLiveCli = false) => {
        if (existingId) {
          const agent = agents.get(existingId)
          const authenticatedWake = waking && resuming && agent?.sleeping && agent.shellId === shellId
          const replacedMcpProcess = request.reconnectToken === undefined && sameLiveCli && !mcpReady.has(existingId)
          if (!authenticatedWake && !replacedMcpProcess && !authenticReconnect(existingId, request.reconnectToken)) {
            throw new Error('기존 에이전트에 다시 연결하려면 재연결 자격 증명이 필요합니다.')
          }
          authorizedId = existingId
        } else if (waking) {
          throw new Error('깨우기 연결이 만료되었습니다.')
        }
        if (mcpReady.size >= 40 && !mcpReady.has(existingId)) throw new Error('실행 중인 메시지 MCP 연결이 너무 많습니다.')
      }
      // MCP connects a little after the CLI started (and wrote its session file).
      if (!attach) authorizeBinding()
      const checkedAttach = attach && (registration => {
        const result = attach({ ...registration, authorizeBinding })
        if ((authorizedId && result?.agentId !== authorizedId) ||
            (result?.agentId && result.agentId !== registration.agentId && result.agentId !== authorizedId)) {
          throw new Error('기존 에이전트에 다시 연결하려면 재연결 자격 증명이 필요합니다.')
        }
        if (!authorizedId) authorizeBinding()
        return result
      })
      const attached = attachExternal(kind, request.cwd, checkedAttach, Date.now() - 30_000, Boolean(shellId))
      if (!attached) throw new Error('ezShell 로컬 터미널 연결을 확인할 수 없습니다.')
      id = attached.id
      binding = attached.binding
      authorized = id === authorizedId
      token = randomUUID()
    }
    const previous = mcpReady.get(id)
    // A bridge-issued tool token expires with its lease. A reconnect uses the bridge again.
    if (!external && leases.get(previous)?.external) throw new Error(registrationError)
    if (!external) authorized = authenticReconnect(id, request.reconnectToken)
    if (previous && !previous.destroyed && !authorized) throw new Error('이 에이전트의 메시지 MCP가 이미 연결되어 있습니다.')
    const reconnectToken = randomBytes(32).toString('base64url')
    reconnects.set(id, { digest: reconnectDigest(reconnectToken), expiresAt: now() + RECONNECT_LIFETIME_MS })
    if (external) tokens.set(token, id)
    mcpReady.set(id, socket)
    leases.set(socket, { id, token, external, binding })
    socket.setTimeout(0)
    socket.write(JSON.stringify({ success: true, token, reconnectToken }) + '\n')
    if (external && previous) tokens.delete(leases.get(previous)?.token)
    previous?.destroy()
    changed()
    const shellId = agents.get(id)?.shellId
    if (shellId) onInboxChanged(shellId)
  }

  const answer = (socket, result) => socket.end(JSON.stringify(result) + '\n')
  const inactiveError = () => ({ success: false, error: '활성 ezShell 에이전트 세션에서 실행해 주세요.' })

  function removeWait(socket) {
    const wait = inboxWaits.get(socket)
    if (!wait) return false
    clearTimeout(wait.timer)
    inboxWaits.delete(socket)
    return true
  }

  function finishWait(socket, result) {
    removeWait(socket)
    if (!socket.destroyed) answer(socket, result)
  }

  function waitForInbox(socket, agentId) {
    socket.setTimeout(0)
    const timer = setTimeout(() => {
      finishWait(socket, isLocked() ? inactiveError() : { success: true, messages: [] })
      changed()
    }, INBOX_WAIT_MS)
    inboxWaits.set(socket, { timer, agentId })
    changed()
  }

  function connect(socket) {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      const lease = leases.get(socket)
      if (lease) {
        leases.delete(socket)
        if (lease.external) tokens.delete(lease.token)
        if (mcpReady.get(lease.id) === socket) {
          mcpReady.delete(lease.id)
          const credential = reconnects.get(lease.id)
          if (credential) credential.expiresAt = Math.min(credential.expiresAt, now() + RECONNECT_AFTER_CLOSE_MS)
          if (lease.external) {
            if (lease.binding?.detach()) stopWaiting(lease.id)
            else archiveExternal(lease.id)
          }
          changed()
        }
      }
      if (removeWait(socket)) changed()
    })
    socket.on('error', () => socket.destroy())
    socket.setTimeout(5000, () => socket.destroy())
    socket.setEncoding('utf8')
    let pending = ''
    socket.on('data', async chunk => {
      pending += chunk
      if (Buffer.byteLength(pending) > MAX_REQUEST) return socket.destroy()
      const end = pending.indexOf('\n')
      if (end < 0) return
      socket.removeAllListeners('data')
      try {
        const request = JSON.parse(pending.slice(0, end))
        if (request?.method === 'watch-mcp') {
          await watchMcp(request, socket)
          return
        }
        if (request?.method === 'antigravity-status') {
          const result = await reportAntigravity(request, socket)
          answer(socket, { success: true, ...result })
          return
        }
        const result = respond(request, socket)
        if (result) answer(socket, { success: true, ...result })
      } catch (error) {
        answer(socket, { success: false, error: error.message })
      }
    })
  }

  function stop() {
    escalated.clear()
    reconnects.clear()
    hookEvents.clear()
    hookSessions.clear()
    codexRoleLaunches.clear()
    for (const pending of stopChecks.values()) clearTimeout(pending.timer)
    stopChecks.clear()
    for (const socket of inboxWaits.keys()) removeWait(socket)
    for (const socket of sockets) socket.destroy()
    server?.close()
    server = undefined
    if (instanceBridgeFile) {
      try { fs.unlinkSync(instanceBridgeFile) } catch {}
    }
    if (directory) {
      try { fs.unlinkSync(path.join(directory, platform === 'win32' ? 'ezshell.cmd' : 'ezshell')) } catch {}
      try { fs.unlinkSync(path.join(directory, 'agent-mcp.json')) } catch {}
      try { fs.unlinkSync(path.join(directory, 'agent-wake-mcp.json')) } catch {}
      try { fs.unlinkSync(path.join(directory, 'agent-shell-mcp.json')) } catch {}
      try { fs.unlinkSync(path.join(directory, CLAUDE_SETTINGS_FILE)) } catch {}
      try { fs.unlinkSync(path.join(directory, 'antigravity-settings.json')) } catch {}
      try { fs.unlinkSync(path.join(directory, 'antigravity-status.cmd')) } catch {}
      try { fs.unlinkSync(path.join(directory, CODEX_HOOK_MODE_FILE)) } catch {}
      try { fs.unlinkSync(path.join(directory, 'messages.sock')) } catch {}
      try { fs.rmdirSync(directory) } catch {}
      directory = undefined
    }
  }

  async function start() {
    directory = fs.mkdtempSync(path.join(tmpdir(), 'ezshell-agent-'))
    writeAgentFile(path.join(directory, CODEX_HOOK_MODE_FILE), runtimeCodexMode() + '\n')
    pipe = platform === 'win32' ? '\\\\.\\pipe\\ezshell-' + randomUUID() : path.join(directory, 'messages.sock')
    const command = platform === 'win32'
      ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%EZSHELL_CLI_EXE%" "%EZSHELL_CLI_SCRIPT%" %*\r\n'
      : '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$EZSHELL_CLI_EXE" "$EZSHELL_CLI_SCRIPT" "$@"\n'
    fs.writeFileSync(path.join(directory, platform === 'win32' ? 'ezshell.cmd' : 'ezshell'), command, { mode: 0o700 })
    const claudeMcpEnvironments = {
      'agent-mcp.json': { EZSHELL_AGENT_TOKEN: '${EZSHELL_AGENT_TOKEN}' },
      'agent-wake-mcp.json': { EZSHELL_SHELL_TOKEN: '${EZSHELL_SHELL_TOKEN}', EZSHELL_AGENT_WAKE_KIND: 'claude' },
      'agent-shell-mcp.json': { EZSHELL_SHELL_TOKEN: '${EZSHELL_SHELL_TOKEN}', EZSHELL_AGENT_SHELL_KIND: 'claude' }
    }
    for (const [file, credentials] of Object.entries(claudeMcpEnvironments)) {
      fs.writeFileSync(path.join(directory, file), JSON.stringify({
        mcpServers: {
          'ezshell-cli-mcp': {
            command: '${EZSHELL_CLI_EXE}',
            args: ['${EZSHELL_AGENT_MCP_SCRIPT}'],
            env: { ELECTRON_RUN_AS_NODE: '1', EZSHELL_AGENT_PIPE: '${EZSHELL_AGENT_PIPE}', ...credentials }
          }
        }
      }), { mode: 0o600 })
    }
    // Added with --settings to the Claude ezShell launches, for that run only (the user's own status
    // line stays in their settings). Claude runs it in Git Bash on Windows and sh elsewhere.
    writeAgentFile(path.join(directory, CLAUDE_SETTINGS_FILE), claudeSettings(hooksEnabled))
    const antigravity = antigravityStatusSettings(home, platform)
    antigravityStatusForward = antigravity.forward
    fs.writeFileSync(path.join(directory, 'antigravity-settings.json'), JSON.stringify({ statusLine: antigravity.statusLine }), { mode: 0o600 })
    if (platform === 'win32') {
      fs.writeFileSync(path.join(directory, 'antigravity-status.cmd'),
        '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%EZSHELL_CLI_EXE%" "%EZSHELL_ANTIGRAVITY_STATUS_SCRIPT%"\r\n', { mode: 0o700 })
    }
    server = net.createServer(connect)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipe, () => { server.off('error', reject); resolve() })
    })
  }

  function ready() {
    runtime ??= start().catch(error => {
      stop()
      runtime = undefined
      throw error
    })
    return runtime
  }

  async function enableExternalBridge() {
    if (!bridgeFile) throw new Error('메시지 MCP 설정 경로가 없습니다.')
    await ready()
    const fields = [process.execPath, path.join(__dirname, 'agentMessageMcp.js'), pipe, bridgeToken]
    if (fields.some(field => /[\r\n]/.test(field))) throw new Error('메시지 MCP 파일 경로에 줄바꿈이 있습니다.')
    const record = fields.join('\n') + '\n'
    // A CLI launched inside ezShell uses its own app's bridge, even if another window starts later.
    for (const file of [instanceBridgeFile, bridgeFile]) {
      const temporary = file + '.' + randomUUID()
      try {
        fs.writeFileSync(temporary, record, { mode: 0o600, flag: 'wx' })
        fs.renameSync(temporary, file)
      } finally {
        try { fs.unlinkSync(temporary) } catch {}
      }
    }
  }

  /**
   * The app quits to install an update: CLIs elsewhere (other terminals) start this app's exe through
   * the shared bridge whenever they reconnect the message MCP. One running at that moment holds the
   * install folder and the installer fails ("Failed to uninstall old application files: 2"). A single
   * line makes both launchers stop before starting anything; the next start writes the bridge again
   * (main.js re-enables it when the file exists). Never creates the file: it marks a configured user.
   */
  function pauseExternalBridge() {
    if (!bridgeFile || !fs.existsSync(bridgeFile)) return
    const temporary = bridgeFile + '.' + randomUUID()
    try {
      fs.writeFileSync(temporary, 'paused for an update\n', { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, bridgeFile)
    } catch (error) {
      console.error('Failed to pause the agent message bridge:', error.code || error.name)
    } finally {
      try { fs.unlinkSync(temporary) } catch {}
    }
  }

  function register(kind, shellId, cwd, shellEnv, resumeId = null) {
    const id = `${kind}-${++serial}`
    const token = randomUUID()
    // startedAt: Codex usage is read from the session file it starts after this (codexUsageWatcher);
    // resumeId: a resumed session writes on in its old file, found by this id instead
    const startedAt = Date.now()
    agents.set(id, { id, shellId, kind, cwd, active: true, status: 'unknown', startedAt, ...(resumeId ? { resumeId } : {}) })
    if (kind === 'codex' && !resumeId) codexRoleLaunches.set(id, { startedAt, cwd })
    tokens.set(token, id)
    bindRoleSession(id, resumeId, true)
    changed()
    const key = Object.keys(shellEnv).find(name => platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH') ?? 'PATH'
    const env = {
      ...shellEnv,
      [key]: directory + (shellEnv[key] ? path.delimiter + shellEnv[key] : ''),
      EZSHELL_AGENT_ID: id,
      EZSHELL_AGENT_PIPE: pipe,
      EZSHELL_AGENT_TOKEN: token,
      EZSHELL_CLI_EXE: process.execPath,
      EZSHELL_CLI_SCRIPT: path.join(__dirname, 'agentMessageCli.js'),
      EZSHELL_AGENT_MCP_SCRIPT: path.join(__dirname, 'agentMessageMcp.js'),
      EZSHELL_AGENT_MCP_CONFIG: path.join(directory, 'agent-mcp.json'),
      // Claude only: its status line reports usage to the app instead of drawing rows (agentUsageReport.js)
      EZSHELL_AGENT_SETTINGS: path.join(directory, CLAUDE_SETTINGS_FILE),
      EZSHELL_AGENT_USAGE_SCRIPT: path.join(__dirname, 'agentUsageReport.js'),
      EZSHELL_AGENT_HOOK_SCRIPT: path.join(__dirname, '..', 'agentHookReport.js')
    }
    const stopReceiving = () => {
      tokens.delete(token)
      reconnects.delete(id)
      const lease = mcpReady.get(id)
      mcpReady.delete(id)
      lease?.destroy()
      for (const [socket, wait] of inboxWaits) {
        if (wait.agentId === id) finishWait(socket, inactiveError())
      }
    }
    return {
      env,
      setStatus: (status, source) => setStatus(id, status, source),
      finish(exitCode) {
        const agent = agents.get(id)
        if (!agent?.active) return
        stopReceiving()
        clearUsage(id)
        forgetHookData(id)
        const status = agent.status === 'error' || (exitCode && exitCode !== 130) ? 'error' : 'ended'
        agents.set(id, { ...agent, active: false, status, exitCode })
        changed()
      },
      close() {
        const agent = agents.get(id)
        if (!agent) return
        stopReceiving()
        clearUsage(id)
        forgetHookData(id)
        if (messages.some(message => message.from === id || message.to === id)) {
          if (!agent.active) return
          agents.set(id, { ...agent, active: false, status: 'ended' })
        } else forgetAgent(id)
        changed()
      }
    }
  }

  const connectedAgentOf = shellId => [...agents.values()].find(candidate => candidate.shellId === shellId && isConnected(candidate.id))
  const unreadMessages = id => messages.filter(message => message.to === id && !message.read && !message.seenAt)

  /** Messages for the agent in this shell that it has not read yet: the terminal wakes it for these */
  function unreadFor(shellId) {
    if (isLocked()) return []
    const agent = connectedAgentOf(shellId)
    return agent ? unreadMessages(agent.id).map(message => message.id) : []
  }

  /** Messages it has not answered or acknowledged yet, read or not: a request put off while busy stays here */
  function unhandledFor(shellId) {
    if (isLocked()) return []
    const agent = connectedAgentOf(shellId)
    return agent ? messages.filter(message => message.to === agent.id && !message.read).map(message => message.id) : []
  }

  /**
   * The latest usage of an agent (Claude's status line through the pipe, Codex's session file through
   * codexUsageWatcher). Only the window hears of it, and only when it changed.
   */
  function setUsage(agentId, value) {
    const agent = agents.get(agentId)
    if (!agent?.active || agent.kind === 'aside') return false
    const clean = sanitizeUsage(value, agent.kind)
    if (!clean) return false
    const sessionId = hookSessions.get(agentId)
    if (sessionId && clean.sessionId && clean.sessionId.toLowerCase() !== sessionId) return false
    if (sessionId) clean.sessionId = sessionId
    const previous = usages.get(agentId)
    // A long Codex turn can push its settings out of the transcript tail while usage keeps arriving.
    if (agent.kind === 'codex' && previous && previous.sessionId === clean.sessionId) {
      clean.model ??= previous.model
      if (clean.model === previous.model) clean.effort ??= previous.effort
    }
    if (sameUsage(previous, clean)) return true
    usages.set(agentId, clean)
    notify('agent-usage', { agentId, shellId: agent.shellId ?? null, usage: clean })
    return true
  }

  /**
   * A model / effort the shell's agent just switched to (agentPicker.js read the CLI's confirmation): the
   * usage line shows it now, before the agent's own next report
   */
  function applyPicked(shellId, applied) {
    const agent = [...agents.values()].find(candidate => candidate.shellId === shellId && candidate.active)
    const usage = agent && usages.get(agent.id)
    if (!usage) return false
    return setUsage(agent.id, { ...usage, ...applied })
  }

  function clearUsage(agentId) {
    if (!usages.delete(agentId)) return
    notify('agent-usage', { agentId, shellId: agents.get(agentId)?.shellId ?? null, usage: null })
  }

  /**
   * What every local shell gets in its environment (needs `ready()`): its own token, so the usage
   * status line of a Claude typed into it can report for that shell's agent, and the status line's
   * settings for the shell's `claude` wrapper (localShell.js).
   */
  function registerShell(shellId) {
    if (!directory || !pipe) return {}
    forgetShell(shellId)
    const token = randomUUID()
    shellTokens.set(token, shellId)
    return {
      EZSHELL_SHELL_TOKEN: token,
      EZSHELL_AGENT_PIPE: pipe,
      EZSHELL_CLI_EXE: process.execPath,
      EZSHELL_AGENT_MCP_SCRIPT: path.join(__dirname, 'agentMessageMcp.js'),
      EZSHELL_AGENT_WAKE_MCP_CONFIG: path.join(directory, 'agent-wake-mcp.json'),
      EZSHELL_AGENT_SHELL_MCP_CONFIG: path.join(directory, 'agent-shell-mcp.json'),
      EZSHELL_AGENT_SETTINGS: path.join(directory, CLAUDE_SETTINGS_FILE),
      EZSHELL_AGENT_USAGE_SCRIPT: path.join(__dirname, 'agentUsageReport.js'),
      EZSHELL_AGENT_HOOK_SCRIPT: path.join(__dirname, '..', 'agentHookReport.js'),
      EZSHELL_CODEX_HOOK_MODE_FILE: path.join(directory, CODEX_HOOK_MODE_FILE),
      EZSHELL_CODEX_HOOK_ARGS: JSON.stringify(CODEX_HOOK_ARGS),
      EZSHELL_CODEX_HOOK_NONCE: createHash('sha256').update('codex-hooks:' + token).digest('hex').slice(0, 24),
      EZSHELL_ANTIGRAVITY_SETTINGS: path.join(directory, 'antigravity-settings.json'),
      EZSHELL_ANTIGRAVITY_STATUS_SCRIPT: path.join(__dirname, 'antigravityStatusReport.js'),
      ...(platform === 'win32' ? { EZSHELL_ANTIGRAVITY_STATUS_COMMAND: `"${path.join(directory, 'antigravity-status.cmd')}"` } : {}),
      EZSHELL_ANTIGRAVITY_STATUS_FORWARD: antigravityStatusForward
    }
  }

  function forgetShell(shellId) {
    for (const [token, id] of shellTokens) if (id === shellId) shellTokens.delete(token)
  }

  /** For a window that starts (or reloads) after the reports came in */
  function usageSnapshot() {
    return [...usages].flatMap(([agentId, usage]) => {
      const agent = agents.get(agentId)
      return agent?.active ? [{ agentId, shellId: agent.shellId ?? null, usage }] : []
    })
  }

  return {
    ready, enableExternalBridge, pauseExternalBridge, register, stop, snapshot, unreadFor, unhandledFor,
    sendAsUser: request => deliver(USER, request),
    setUserRole: (id, role) => setRole(id, role, 'user'),
    hookEventsOf: id => (hookEvents.get(id) ?? []).map(event => ({ ...event })),
    hookSessionOf: id => hookSessions.get(id) ?? null,
    codexRoleContextOf: id => {
      const launch = codexRoleLaunches.get(id)
      return launch && !launch.changedSession ? { roleStartedAt: launch.startedAt, roleCwd: launch.cwd } : null
    },
    freshRoleEpoch,
    invalidateFreshRoleChecks: () => { roleEpoch++ },
    setFreshCodexRoleSession,
    messageSeenAt: (agentId, messageId) => messages.find(message => message.to === agentId && message.id === messageId)?.seenAt ?? null,
    hasConnectedAgent: id => isConnected(id) && !agents.get(id)?.sleeping,
    setHookSession,
    codexHookMode: runtimeCodexMode,
    hooksEnabled: () => hooksEnabled,
    configureHooks,
    setCodexHookMode,
    setUsage, setVerifiedSession, applyPicked, usageSnapshot, registerShell, registerLocalClaude, registerLocalAntigravity, forgetShell, sleep, cancelSleep
  }
}

module.exports = { createAgentMessages }
