// The PC's agents as a phone uses them (remote access, step 3): the list, a chat view followed per
// device, sending a line, answering a numbered prompt and stopping a turn. Every action goes the way
// the PC's chat view goes (src/agentChat/ipc.js) and is checked again here: the shell is still open,
// the same agent still runs in it, and the device has that chat open. A phone never types into a
// shell: a line goes through chatSend only, and slash commands and Claude's `!` shell mode are refused.
// Design: docs/plan/2026-11-24-remote-access-tabs-and-agents.md
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.
const path = require('path')
const { cleanChatText, chatSendResult, CHAT_PROVIDERS, REASONS } = require('../agentChat/ipc.js')
const { createProjectId } = require('./projectId.js')

const SHELL_ID = /^local:\d+$/
/** An answer is not taken sooner than this after the device was sent the prompt (as on the PC) */
const ANSWER_ARM_MS = 800
const MAX_SIGNATURE = 20_000
const PROVIDER_NAMES = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' }
/** Chats one device may follow at once (all devices together: chats.js's MAX_REMOTE_CHATS) */
const MAX_CHATS_PER_DEVICE = 4
/**
 * Choices that grant more than this one request (Claude's "don't ask again", Codex's "always" or
 * "for this session"): a phone may not pick them. Read from the label main read off the screen.
 */
const STANDING_GRANT = /don['’]?t ask again|do not ask again|always|for (?:this|the rest of the) session|for the session|remember|다시 묻지|묻지 않|항상|계속 허용|이 세션|세션 동안|기억/i
const isStandingGrant = option => STANDING_GRANT.test(String(option?.label ?? ''))

const ERRORS = {
  off: '휴대폰에서 에이전트 쓰기가 꺼져 있습니다. PC 의 설정 > 원격 접속에서 켜 주세요.',
  locked: 'PC 의 ezShell 이 잠겨 있습니다.',
  noShell: '에이전트를 찾지 못했습니다. 목록을 새로 고쳐 주세요.',
  notOpen: '채팅을 먼저 열어 주세요.',
  changed: '이 셸의 에이전트가 바뀌었습니다. 목록에서 다시 열어 주세요.',
  command: '휴대폰에서는 슬래시 명령(/…)과 ! 로 시작하는 글을 보낼 수 없습니다. PC 에서 보내 주세요.',
  text: '보낼 수 없는 글입니다 (비어 있거나, 제어 문자가 있거나, 너무 깁니다).',
  antigravityTerminal: 'Antigravity의 확인 요청은 PC 의 터미널에서 처리해 주세요.',
  antigravityBusy: 'Antigravity가 입력을 기다릴 때 보내 주세요.',
  notAsked: '이미 끝난 질문입니다.',
  tooSoon: '질문을 확인한 뒤 다시 눌러 주세요.',
  badAnswer: '답할 수 없는 선택입니다.',
  standing: '"다시 묻지 않음"·"항상 허용" 같은 선택은 PC 에서 골라 주세요.',
  tooMany: `한 휴대폰에서는 채팅을 ${MAX_CHATS_PER_DEVICE}개까지 열 수 있습니다. 다른 채팅을 닫고 열어 주세요.`
}

/** "codex-9" → "Codex 9"; without an id (no message MCP yet) the provider's name alone */
function agentName(kind, agentId) {
  const base = PROVIDER_NAMES[kind] ?? String(kind)
  const prefix = `${kind}-`
  return typeof agentId === 'string' && agentId.startsWith(prefix) ? `${base} ${agentId.slice(prefix.length)}` : base
}

/** Only the last folder name goes to the phone, never the path */
function folderNameOf(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null
  const name = path.win32.basename(cwd.replace(/[\\/]+$/, '')) || path.posix.basename(cwd)
  return name ? name.slice(0, 120) : null
}

function projectForFolder(cwd, projects) {
  if (typeof cwd !== 'string' || !cwd) return null
  let match = null
  let depth = 0
  for (const project of projects) {
    for (const worktree of project.worktrees) {
      const relative = path.relative(worktree, cwd)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
      const length = path.resolve(worktree).length
      if (length <= depth) continue
      depth = length
      match = project
    }
  }
  if (match) return match
  const name = folderNameOf(cwd)
  return name ? { key: cwd, name } : null
}

/** A line the phone may send: as the PC would take it, and no command of any kind */
function phoneText(value) {
  const text = cleanChatText(value)
  if (!text) return { error: ERRORS.text }
  const start = text.trimStart()
  if (start.startsWith('/') || start.startsWith('!')) return { error: ERRORS.command }
  return { text }
}

function phoneApproval(approval) {
  if (!Array.isArray(approval?.options)) return approval
  const options = approval.options.map(option => isStandingGrant(option) ? { ...option, phoneBlocked: true } : option)
  return { ...approval, options }
}

/**
 * @param {object} deps
 * @param {() => object | null} deps.shells the local shells (src/localShell.js), or null before they exist
 * @param {object} deps.chats the chat follower (src/agentChat/chats.js)
 * @param {() => object[]} deps.agents agentMessages.snapshot().agents (roles, folders)
 * @param {() => object[]} [deps.projects] the registered projects and their worktrees on the PC
 * @param {() => boolean} deps.isLocked
 * @param {() => boolean} deps.isEnabled `휴대폰에서 에이전트 쓰기` is on
 */
function createAgentBridge({ shells, chats, agents = () => [], projects = () => [], projectId = createProjectId(), isLocked = () => false, isEnabled = () => false, now = Date.now }) {
  /** `${viewer}\u0000${shellId}` → { agentId, kind, asked: { signature, at } | null } */
  const opened = new Map()
  const keyOf = (viewer, shellId) => `${viewer}\u0000${shellId}`

  const refusal = () => (isLocked() ? ERRORS.locked : !isEnabled() ? ERRORS.off : null)

  /** The shell id if it names an open local shell with a chat agent in it */
  function liveShell(shellId) {
    if (typeof shellId !== 'string' || !SHELL_ID.test(shellId)) return null
    const local = shells()
    if (!local || !local.list().some((entry) => entry.id === shellId && !entry.exited)) return null
    const agent = local.agentOf(shellId)
    return agent && CHAT_PROVIDERS.has(agent.kind) ? { local, agent, agentId: local.chatAgentId?.(shellId) ?? null } : null
  }

  /**
   * Whether the shell still runs the agent the chat was opened with. Once a conversation is
   * identified, a missing or different session id is no longer that conversation.
   */
  function isSameAgent(entry, live) {
    if (!live || live.agent.kind !== entry.kind || live.agentId !== entry.agentId) return false
    const sessionId = live.agent.sessionId ?? null
    return !entry.sessionId || entry.sessionId === sessionId
  }

  /** The device's open chat on that shell, still with the agent it was opened with */
  function current(viewer, shellId) {
    const blocked = refusal()
    if (blocked) return { error: blocked }
    const entry = opened.get(keyOf(viewer, shellId))
    if (!entry || !chats.isOpen(shellId, viewer)) return { error: ERRORS.notOpen }
    const live = liveShell(shellId)
    if (!live) return { error: ERRORS.noShell }
    if (!isSameAgent(entry, live)) return { error: ERRORS.changed }
    if (!entry.sessionId) entry.sessionId = live.agent.sessionId ?? null
    return { ...live, entry }
  }

  return {
    get enabled() { return isEnabled() && !isLocked() },
    ERRORS,

    /** The agents running in the PC's local shells, in the shells' order */
    list() {
      if (refusal()) return []
      const local = shells()
      if (!local) return []
      const known = new Map((agents() ?? []).filter((agent) => agent && agent.active).map((agent) => [agent.id, agent]))
      const projectList = projects()
      const rows = []
      for (const entry of local.list()) {
        if (!entry || entry.exited || !SHELL_ID.test(entry.id)) continue
        const running = local.agentOf(entry.id)
        if (!running || !CHAT_PROVIDERS.has(running.kind)) continue
        const agentId = local.chatAgentId?.(entry.id) ?? null
        const record = agentId ? known.get(agentId) : null
        const status = typeof running.status === 'string' ? running.status : 'unknown'
        const cwd = running.cwd ?? record?.cwd ?? entry.cwd
        const project = projectForFolder(entry.cwd ?? cwd, projectList)
        rows.push({
          shellId: entry.id,
          agentId,
          kind: running.kind,
          name: agentName(running.kind, agentId),
          role: typeof record?.role === 'string' && record.role ? record.role : null,
          status,
          folderName: folderNameOf(cwd),
          project: project ? { id: projectId(project.key), name: project.name } : null,
          waitingApproval: status === 'blocked' || Boolean(local.approvalOf?.(entry.id))
        })
      }
      return rows
    },

    /**
     * Starts following the shell's chat for this device; its frames come through onFrame. When the
     * agent changes (it ended and another started, or a new conversation began), the chat closes
     * and onClosed(error) says why: another agent's conversation never reaches the chat.
     */
    open(viewer, shellId, onFrame, onClosed = () => {}) {
      const blocked = refusal()
      if (blocked) return { ok: false, error: blocked }
      const live = liveShell(shellId)
      if (!live) return { ok: false, error: ERRORS.noShell }
      const key = keyOf(viewer, shellId)
      const mine = [...opened.keys()].filter((other) => other !== key && other.startsWith(`${viewer}\u0000`)).length
      if (mine >= MAX_CHATS_PER_DEVICE) return { ok: false, error: ERRORS.tooMany }
      const entry = { agentId: live.agentId, kind: live.agent.kind, sessionId: live.agent.sessionId ?? null, asked: null }
      opened.set(key, entry)
      const result = chats.open(shellId, {
        viewer,
        onFrame: (frame) => {
          if (opened.get(key) !== entry) return
          const unavailable = refusal()
          const running = liveShell(shellId)
          if (unavailable || !isSameAgent(entry, running)) {
            opened.delete(key)
            chats.close(shellId, viewer)
            onClosed(unavailable || ERRORS.changed)
            return
          }
          // The conversation became known after opening: later frames must stay in it
          if (!entry.sessionId) entry.sessionId = running.agent.sessionId ?? null
          // The prompt this device was shown, and when: an answer must name it and wait a moment
          if (Object.prototype.hasOwnProperty.call(frame, 'approval')) {
            entry.asked = frame.approval?.signature ? { signature: frame.approval.signature, at: now() } : null
            onFrame({ ...frame, approval: phoneApproval(frame.approval) })
            return
          }
          onFrame(frame)
        }
      })
      if (!result.ok) opened.delete(key)
      return result
    },

    /** The part before what the device has; settles after its frame was sent */
    async older(viewer, shellId) {
      const live = current(viewer, shellId)
      if (live.error) return { ok: false, error: live.error }
      await chats.older(shellId, viewer)
      return { ok: true }
    },

    close(viewer, shellId) {
      opened.delete(keyOf(viewer, shellId))
      chats.close(shellId, viewer)
    },

    /** The device went away (or the app locked): all its chats stop */
    closeViewer(viewer) {
      for (const key of [...opened.keys()]) if (key.startsWith(`${viewer}\u0000`)) opened.delete(key)
      chats.closeViewer(viewer)
    },

    /** What the log names: the agent, never the text */
    describe(shellId) {
      const local = shells()
      const agentId = typeof shellId === 'string' && local ? local.chatAgentId?.(shellId) ?? null : null
      return agentId ?? (typeof shellId === 'string' && SHELL_ID.test(shellId) ? shellId : 'unknown')
    },

    /** A line into the agent's composer, the way the PC's chat sends it (no images, no retry, no force) */
    async send(viewer, shellId, value) {
      const live = current(viewer, shellId)
      if (live.error) return { ok: false, error: live.error }
      const checked = phoneText(value)
      if (checked.error) return { ok: false, error: checked.error }
      const { local, agent, entry } = live
      const stillSame = () => !refusal() && chats.isOpen(shellId, viewer) && opened.get(keyOf(viewer, shellId)) === entry
        && isSameAgent(entry, liveShell(shellId))
      if (agent.kind === 'antigravity') {
        if (agent.status === 'blocked' || local.approvalOf?.(shellId)) return { ok: false, reason: 'unsupported', error: ERRORS.antigravityTerminal }
        if (agent.status !== 'idle') return { ok: false, reason: 'busy', error: ERRORS.antigravityBusy }
        const sessionId = agent.sessionId ?? null
        const isSameIdleEditor = () => {
          const active = local.agentOf(shellId)
          return stillSame() && active?.status === 'idle' && (active.sessionId ?? null) === sessionId && !local.approvalOf?.(shellId)
        }
        const result = await local.chatSend(shellId, checked.text, undefined, undefined, undefined, { canSend: isSameIdleEditor })
        return refusal() ? { ok: false, error: refusal() } : chatSendResult(result)
      }
      const result = await local.chatSend(shellId, checked.text, undefined, undefined, stillSame)
      return refusal() ? { ok: false, error: refusal() } : chatSendResult(result)
    },

    /** A choice of the numbered prompt the device was shown (main checks the screen still shows it) */
    async answer(viewer, shellId, key, signature) {
      const live = current(viewer, shellId)
      if (live.error) return { ok: false, error: live.error }
      if (typeof key !== 'string' || !/^[1-9]$/.test(key) || typeof signature !== 'string' || !signature || signature.length > MAX_SIGNATURE) {
        return { ok: false, error: ERRORS.badAnswer }
      }
      if (live.agent.kind === 'antigravity') return { ok: false, error: ERRORS.antigravityTerminal }
      const asked = live.entry.asked
      if (!asked || asked.signature !== signature) return { ok: false, error: ERRORS.notAsked }
      if (now() - asked.at < ANSWER_ARM_MS) return { ok: false, error: ERRORS.tooSoon }
      // The choice's name as main read it off the screen (never the phone's): a standing grant is the PC's to give
      const prompt = live.local.approvalOf?.(shellId)
      if (!prompt || prompt.signature !== signature) return { ok: false, error: ERRORS.notAsked }
      const option = (prompt.options ?? []).find((choice) => String(choice?.key) === key)
      if (!option) return { ok: false, error: ERRORS.badAnswer }
      if (isStandingGrant(option)) return { ok: false, error: ERRORS.standing }
      const result = await live.local.answerApproval(shellId, key, signature)
      if (refusal()) return { ok: false, error: refusal() }
      return result.ok ? { ok: true } : { ok: false, reason: result.reason, error: REASONS[result.reason] ?? '답하지 못했습니다.' }
    },

    /** Esc: stops the agent's turn, as the PC's 중지 */
    interrupt(viewer, shellId) {
      const live = current(viewer, shellId)
      if (live.error) return { ok: false, error: live.error }
      // As on the PC (agent-chat-interrupt): Antigravity is stopped in its terminal
      if (live.agent.kind === 'antigravity') return { ok: false, error: ERRORS.antigravityTerminal }
      return live.local.interruptAgent(shellId) ? { ok: true } : { ok: false, error: '중지하지 못했습니다.' }
    }
  }
}

module.exports = { createAgentBridge, agentName, folderNameOf, phoneText, ANSWER_ARM_MS, STANDING_GRANT, MAX_CHATS_PER_DEVICE }
