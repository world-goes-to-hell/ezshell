// The window names a shell and sends a draft. Main owns the transcript and clipboard image paths.
const { randomUUID } = require('node:crypto')
const path = require('node:path')
const { linkTarget } = require('./links.js')
const { readLinkPreview, resolveLocalPreviewPath } = require('./localPreview.js')
const { sameOrInside } = require('../localFiles/roots.js')
const { routeSubagent, subagentRelayText } = require('./subagentChat.js')
const { watchCommand, claudeQueueVisible } = require('./commandScreen.js')
const { customCommands } = require('./slashCommands.js')
const { createImageDrafts } = require('./imageDrafts.js')
const { cleanAnswer } = require('./askQuestions.js')
const { prepareHandoff } = require('./handoff.js')

const SHELL_ID = /^local:\d+$/
const MAX_TEXT = 16_000
const CHAT_PROVIDERS = new Set(['claude', 'codex', 'antigravity'])
const MCP_SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/
const staleMcpSummary = { ok: false, error: '이 에이전트의 최신 /mcp 결과를 다시 확인해 주세요.' }
const antigravityOnlyText = { ok: false, reason: 'unsupported', error: 'Antigravity 채팅에서는 일반 텍스트만 보낼 수 있습니다.' }
const antigravityTerminal = { ok: false, reason: 'unsupported', error: 'Antigravity의 확인 요청은 터미널에서 처리해 주세요.' }

/**
 * The text as it may be pasted into the agent's composer, or null. Control characters are refused:
 * an ESC could end the bracketed paste early and the rest would reach the terminal as keys.
 */
// Chat lines one Esc can bring back at once
const MAX_TAKE_BACK = 10

function cleanChatText(value) {
  if (typeof value !== 'string' || value.length > MAX_TEXT) return null
  const text = value.replace(/\r\n?/g, '\n')
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return null
  const trimmed = text.replace(/^\n+/, '').replace(/\s+$/, '')
  return trimmed || null
}

const REASONS = {
  'not-agent': '이 셸에서 돌고 있는 에이전트가 없습니다.',
  approval: '에이전트 화면에 선택 질문이 떠 있어 보내지 않았습니다. 질문 카드에서 고르거나 터미널에서 답한 뒤 다시 보내 주세요.',
  'no-composer': '에이전트의 입력칸을 찾지 못했습니다. 터미널 보기에서 확인해 주세요.',
  'composer-not-empty': '에이전트 입력칸에 쓰던 글이 있습니다. 터미널에서 지우거나 보낸 뒤 다시 시도해 주세요.',
  'draft-changed': '터미널 입력 상태가 바뀌었습니다. 보내기를 다시 눌러 주세요.',
  'not-cleared': '터미널 입력칸이 비워지지 않았습니다. 터미널에서 입력 내용을 확인해 주세요.',
  'not-drawn': '입력칸에 글이 그대로 들어가지 않아 보내지 않았습니다. 터미널 보기에서 확인해 주세요.',
  busy: '다른 입력을 넣는 중입니다. 잠시 뒤 다시 시도해 주세요.',
  changed: '화면의 질문이 바뀌었습니다. 새 질문을 보고 다시 골라 주세요.',
  stuck: '선택이 반영되지 않았습니다. 다시 골라 주세요.',
  'target-changed': 'CLI의 입력 대상이 바뀌었습니다. 터미널에서 현재 대화를 확인해 주세요.',
  'retry-not-idle': '에이전트가 입력을 기다릴 때 다시 보내 주세요.',
  'retry-queued': 'Claude에 대기 중인 메시지가 있습니다. 처리된 뒤 다시 시도해 주세요.',
  'retry-transcript': '대화 기록을 확인할 수 없어 다시 보내지 못했습니다.',
  'write-failed': '셸에 쓰지 못했습니다.'
}

function chatPrompt(kind, text, files) {
  if (!files.length) return { prompt: text, images: undefined }
  if (kind === 'codex') return { prompt: text, images: { files } }
  const paths = files.join('\n')
  // Keep the references first so a slash command in the draft stays ordinary text.
  return { prompt: text ? paths + '\n\n' + text : paths, images: { count: files.length, text } }
}

function chatSendResult(result) {
  return result.ok ? { ok: true } : { ok: false, reason: result.reason, error: REASONS[result.reason] ?? '보내지 못했습니다.',
    ...(result.forceToken ? { forceToken: result.forceToken } : {}) }
}

function mcpLoginCommands(output) {
  const rows = (output ?? '').trim().split('\n')
  const commands = new Map()
  if (!/^(?:🔌\uFE0F?\s*)?MCP Tools$/u.test(rows[0])) return commands
  for (const row of rows) {
    const server = /^•\s+([^:]+):\s+([^()]+)\s+\(([0-9]+) tools?\)$/u.exec(row.trim())
    if (!server) continue
    const [, printedName, status, tools] = server
    const name = printedName.trim()
    if (MCP_SERVER_NAME.test(name) && status.trim().toLowerCase() === 'authentication required'
      && Number.isSafeInteger(Number(tools))) commands.set(name, `/mcp login ${name}`)
  }
  return commands
}

function retryRequest(value) {
  if (!value || !Number.isFinite(value.acceptedAt) || value.acceptedAt <= 0 || value.acceptedAt > Date.now() + 1000
    || typeof value.transcriptId !== 'string' || !/^[a-f0-9]{64}$/.test(value.transcriptId)
    || !Array.isArray(value.ignoreIds) || value.ignoreIds.length > 256
    || value.ignoreIds.some(id => typeof id !== 'string' || id.length > 512)) return null
  return { acceptedAt: value.acceptedAt, transcriptId: value.transcriptId, ignoreIds: value.ignoreIds }
}

const SPEED_REASONS = {
  ...REASONS,
  working: 'Codex가 입력을 기다릴 때 전환할 수 있습니다.',
  'speed-unavailable': '현재 모델이나 Codex 설정에서 이 속도 모드를 사용할 수 없습니다.',
  'speed-unconfirmed': 'Codex의 속도 변경을 확인하지 못했습니다. 터미널에서 현재 설정을 확인해 주세요.'
}
// Claude's AskUserQuestion answered from the chat card (src/ipc/claudeQuestions.js): the window then hands
// the pane to the terminal, where the dialog is left as the keys reached it
const QUESTION_REASONS = {
  ...REASONS,
  changed: '화면의 질문이 카드와 달라 답하지 않았습니다. 터미널에서 답해 주세요.',
  stuck: '질문 화면이 예상대로 움직이지 않아 멈췄습니다. 터미널에서 이어서 답해 주세요.',
  mismatch: '확인 화면의 답이 고른 답과 달라 제출하지 않았습니다. 터미널에서 확인해 주세요.',
  answered: '이미 답한 질문입니다.'
}
// The usage line's model / effort picker (src/ipc/agentPicker.js)
const PICKER_REASONS = {
  ...REASONS,
  working: '에이전트가 작업 중입니다. 작업이 끝난 뒤 다시 해 주세요.',
  'no-picker': '에이전트의 선택 화면이 뜨지 않았습니다. 터미널 보기에서 확인해 주세요.',
  changed: '선택 화면이 바뀌어 고르지 않았습니다. 다시 열어 주세요.',
  stuck: '그 값으로 옮기지 못했습니다. 이 모델에서는 고를 수 없는 값일 수 있습니다.',
  missing: '에이전트가 더 이상 그 항목을 보여 주지 않습니다. 목록을 새로 불러왔습니다.'
}

/**
 * links: { openExternal(url), openBrowserTab(url), openWorkspaceBrowser(root, relative, permitted),
 *   showItemInFolder(path), openFolder(path), openLocalFile(path) }
 * pins: answers pinned into windows of their own (pins.js); showShell(shellId): the main window
 * brings that shell's pane forward as a chat
 */
function registerAgentChatIpc({ ipcMain, fromMainWindow, isLocked, chats, shells, clipboard, selectImages, links, pins = null, showShell = null, notifyCapture = () => {}, handoff = null }) {
  const allowed = event => fromMainWindow(event) && !isLocked()
  const fromChatWindow = event => allowed(event) && Boolean(event.senderFrame && event.senderFrame === event.sender?.mainFrame)
  const shellIdOf = value => (typeof value === 'string' && SHELL_ID.test(value) ? value : null)
  const locked = { ok: false, error: '먼저 잠금을 해제해 주세요.' }
  const imageDrafts = createImageDrafts(clipboard)
  const pendingLinkPreviews = new Map()
  // A slash command just sent from the chat: the agent's screen before it, read by agent-chat-command-watch
  const commandWatches = new Map()
  const mcpSummaries = new Map()
  const retrying = new Set()

  async function retrySend(event, id, local, agent, retry, text, hasImage, send) {
    if (retrying.has(id)) return chatSendResult({ ok: false, reason: 'busy' })
    const agentId = local.chatAgentId?.(id)
    let reason
    const canRetry = () => {
      const active = local.agentOf(id)
      if (!allowed(event)) reason = 'locked'
      else if (!active || active.kind !== agent.kind || local.chatAgentId?.(id) !== agentId) reason = 'target-changed'
      else if (active.status !== 'idle') reason = 'retry-not-idle'
      else if (active.kind === 'claude' && claudeQueueVisible(local.chatScreen?.(id))) reason = 'retry-queued'
      else if (!chats.hasTranscript?.(id, retry.transcriptId)) reason = 'retry-transcript'
      else reason = undefined
      return !reason
    }
    const refused = () => reason === 'locked' ? locked : chatSendResult({ ok: false, reason })
    if (!canRetry()) return refused()
    retrying.add(id)
    try {
      const recorded = await chats.findRecordedSend?.(id, { ...retry, text, hasImage })
      if (!allowed(event)) return locked
      if (recorded && chats.hasTranscript?.(id, retry.transcriptId)) {
        return { ok: false, reason: 'already-recorded', error: '이 메시지는 이미 대화 기록에 있습니다.', recorded }
      }
      if (!canRetry()) return refused()
      if (recorded === undefined) return chatSendResult({ ok: false, reason: 'retry-transcript' })
      const result = await send(canRetry)
      if (!allowed(event)) return locked
      return !result.ok && reason ? refused() : chatSendResult(result)
    } finally {
      retrying.delete(id)
    }
  }

  async function readAttachments(event, shellId, source) {
    if (!allowed(event)) return locked
    const id = shellIdOf(shellId)
    const agent = id && shells()?.agentOf(id)
    if (!agent) return { ok: false, error: REASONS['not-agent'] }
    const canUse = () => allowed(event) && shells()?.agentOf(id)?.kind === agent.kind
    const noChat = '열려 있는 채팅에서 다시 첨부해 주세요.'
    if (agent.kind === 'antigravity') {
      if (source !== 'clipboard') return antigravityOnlyText
      try {
        const text = await clipboard.readText()
        return canUse() ? { ok: true, kind: 'text', text } : locked
      } catch (error) {
        return { ok: false, error: error.message }
      }
    }
    return source === 'clipboard'
      ? imageDrafts.paste(id, canUse, noChat, { includeImageWithText: true })
      : imageDrafts.pick(id, canUse, noChat, selectImages)
  }

  ipcMain.handle('agent-chat-open', (event, shellId) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(shellId)
    if (!id) return { ok: false, error: '셸을 찾지 못했습니다.' }
    if (!CHAT_PROVIDERS.has(shells()?.agentOf(id)?.kind)) return { ok: false, error: REASONS['not-agent'] }
    return chats.open(id)
  })
  ipcMain.handle('agent-chat-older', async (event, shellId) => {
    const id = shellIdOf(shellId)
    if (allowed(event) && id) await chats.older(id)
  })
  ipcMain.handle('agent-chat-questions', async (event, shellId) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(shellId)
    if (!id) return { ok: false, error: '셸을 찾지 못했습니다.' }
    if (shells()?.agentOf?.(id)?.kind === 'antigravity') return antigravityTerminal
    const result = await chats.questions(id)
    return allowed(event) ? result : locked
  })
  ipcMain.handle('agent-chat-question-context', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    if (!id || typeof request.scope !== 'string' || typeof request.id !== 'string' || request.id.length > 160) {
      return { ok: false, error: '질문을 찾지 못했습니다.' }
    }
    if (shells()?.agentOf?.(id)?.kind === 'antigravity') return antigravityTerminal
    const result = await chats.questionContext(id, request.scope, request.id)
    return allowed(event) ? result : locked
  })
  ipcMain.handle('agent-chat-subagent-preview', async (event, shellId, agentId) => {
    const id = shellIdOf(shellId)
    if (!allowed(event) || !id || typeof agentId !== 'string' || agentId.length > 500 || shells()?.agentOf(id)?.kind === 'antigravity') return []
    const activity = await chats.subagentPreview(id, agentId)
    return allowed(event) ? activity : []
  })
  async function subagentFor(event, shellId, agentId) {
    if (!allowed(event) || !shellIdOf(shellId) || typeof agentId !== 'string' || agentId.length > 500) return null
    if (shells()?.agentOf(shellId)?.kind === 'antigravity') return null
    const record = await chats.subagentConversation(shellId, agentId)
    if (!record || !allowed(event)) return null
    const local = shells()
    const route = record.live && local?.agentOf(shellId)?.kind === record.kind
      ? routeSubagent(record.kind, record.child, record.identity, local.chatInputTarget(shellId))
      : { mode: 'read-only' }
    if (route.mode === 'direct') local.rememberSubagentInput?.(shellId, route.target)
    return { local, route, messages: record.messages, scope: record.scope }
  }
  ipcMain.handle('agent-chat-subagent-conversation', async (event, shellId, agentId) => {
    const found = await subagentFor(event, shellId, agentId)
    return found ? { mode: found.route.mode, messages: found.messages, scope: found.scope } : null
  })
  ipcMain.handle('agent-chat-subagent-send', async (event, request) => {
    if (!allowed(event)) return locked
    const { shellId, agentId, mode, scope } = request ?? {}
    const text = cleanChatText(request?.text)
    if (!text) return { ok: false, error: '보낼 수 없는 글입니다.' }
    const found = await subagentFor(event, shellId, agentId)
    const route = found?.route
    if (!route || typeof scope !== 'string' || scope !== found.scope || route.mode !== mode || (mode !== 'direct' && mode !== 'relay')) {
      return { ok: false, error: REASONS['target-changed'] }
    }
    if (mode === 'direct' && text.trimStart().startsWith('/')) return { ok: false, error: '서브에이전트에게 보낼 메시지를 입력해 주세요.' }
    const result = await found.local.chatSend(shellId, mode === 'relay' ? subagentRelayText(route, text) : text,
      undefined, route.target, () => allowed(event) && chats.hasSubagentScope(shellId, scope))
    return result.ok ? { ok: true } : { ok: false, error: REASONS[result.reason] ?? '보내지 못했습니다.' }
  })
  // After a slash command was sent: did it run (and what Codex printed), ask a question, or open a screen
  ipcMain.handle('agent-chat-command-watch', async (event, shellId) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(shellId)
    if (id && shells()?.agentOf(id)?.kind === 'antigravity') return antigravityOnlyText
    const pending = id && commandWatches.get(id)
    if (!pending) return { ok: false, error: '확인할 명령이 없습니다.' }
    if (pending.mcpSummary && !fromChatWindow(event)) return locked
    commandWatches.delete(id)
    const agentId = shells()?.chatAgentId?.(id)
    const outcome = await watchCommand({ read: () => shells()?.chatScreen?.(id) ?? null, ...pending })
    if (!allowed(event)) return locked
    const { echoVerified, ...result } = outcome
    if (result.state === 'screen' && agentId) shells()?.noteChatCommandScreen?.(id, agentId)
    const summary = pending.mcpSummary
    if (result.output && summary && fromChatWindow(event) && mcpSummaries.get(id) === summary
      && shells()?.chatAgentId?.(id) === summary.agentId) {
      summary.commands = mcpLoginCommands(echoVerified ? result.output : null)
      return { ok: true, ...result, mcpSummary: { id: summary.id, canLogin: echoVerified } }
    }
    return { ok: true, ...result }
  })
  async function sendMcpAction(event, request, verbose) {
    if (!fromChatWindow(event)) return locked
    const id = shellIdOf(request?.shellId)
    const name = request?.server
    if (!id || (!verbose && (typeof name !== 'string' || !MCP_SERVER_NAME.test(name)))) return staleMcpSummary
    const local = shells()
    const summary = mcpSummaries.get(id)
    if (!local || !summary?.commands || summary.id !== request.summaryId) return staleMcpSummary
    const command = verbose ? '/mcp verbose' : summary.commands.get(name)
    if (!command) return staleMcpSummary
    const sameAgent = () => mcpSummaries.get(id) === summary && local.chatAgentId?.(id) === summary.agentId
      && local.agentOf(id)?.kind === 'codex'
    if (!sameAgent()) return staleMcpSummary
    const ready = () => local.agentOf(id)?.status === 'idle' && !local.approvalOf?.(id)
    if (!ready()) return chatSendResult({ ok: false, reason: 'busy' })
    const before = local.chatScreen?.(id) ?? null
    commandWatches.delete(id)
    const result = await local.chatSend(id, command, undefined, undefined, undefined,
      { canSend: () => fromChatWindow(event) && sameAgent() && ready() })
    if (!fromChatWindow(event)) return locked
    if (result?.ok && sameAgent()) commandWatches.set(id, { before, kind: 'codex', command })
    return chatSendResult(result)
  }
  ipcMain.handle('agent-chat-mcp-login', (event, request) => sendMcpAction(event, request, false))
  ipcMain.handle('agent-chat-mcp-verbose', (event, request) => sendMcpAction(event, request, true))
  // While the pane shows the terminal for a screen a command opened: is the composer back
  ipcMain.handle('agent-chat-screen-state', (event, shellId) => {
    const id = shellIdOf(shellId)
    if (!allowed(event) || !id) return null
    const screen = shells()?.chatScreen?.(id)
    return screen ? { composer: screen.composer, approval: screen.approval } : null
  })
  // The slash commands of the agent's own folders (names and descriptions), for the composer's list
  ipcMain.handle('agent-chat-slash-commands', async (event, shellId) => {
    const id = shellIdOf(shellId)
    const agent = allowed(event) && id ? shells()?.agentOf(id) : null
    if (!agent || (agent.kind !== 'claude' && agent.kind !== 'codex')) return []
    const commands = await customCommands({ kind: agent.kind, cwd: chats.cwdOf(id) }).catch(() => [])
    return allowed(event) ? commands : []
  })
  ipcMain.handle('agent-chat-copy', async (event, shellId) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(shellId)
    if (!id) return { ok: false, error: '셸을 찾지 못했습니다.' }
    const result = await chats.transcriptForCopy(id)
    return allowed(event) ? result : locked
  })
  ipcMain.on('agent-chat-close', (event, shellId) => {
    const id = shellIdOf(shellId)
    if (!fromMainWindow(event) || !id) return
    imageDrafts.clear(id)
    chats.close(id)
  })
  ipcMain.handle('agent-chat-read-clipboard', (event, shellId) => readAttachments(event, shellId, 'clipboard'))
  ipcMain.handle('agent-chat-pick-images', (event, shellId) => readAttachments(event, shellId, 'files'))
  ipcMain.handle('agent-chat-preview-image', async (event, request) => {
    if (!fromChatWindow(event)) return locked
    const scope = shellIdOf(request?.shellId)
    const imageId = request?.imageId
    const unavailable = { ok: false, error: '원본 이미지를 불러올 수 없습니다.' }
    if (!scope || typeof imageId !== 'string' || imageId.length !== 36) return unavailable
    const file = imageDrafts.previewFile(scope, imageId)
    if (!file) return unavailable
    try {
      const data = await clipboard.readStoredImage(file)
      if (!fromChatWindow(event)) return locked
      return imageDrafts.previewFile(scope, imageId) === file ? { ok: true, data } : unavailable
    } catch {
      return unavailable
    }
  })
  ipcMain.on('agent-chat-remove-image', (event, request) => {
    if (allowed(event) && typeof request?.imageId === 'string') imageDrafts.remove(shellIdOf(request.shellId), [request.imageId])
  })
  ipcMain.handle('agent-chat-send', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    const text = cleanChatText(request?.text)
    if (!id) return { ok: false, error: '셸을 찾지 못했습니다.' }
    const keys = request.imageIds ?? (request.imageId === undefined ? [] : [request.imageId])
    const local = shells()
    const agent = local?.agentOf(id)
    if (!agent || !CHAT_PROVIDERS.has(agent.kind)) return { ok: false, error: REASONS['not-agent'] }
    const forceToken = request.forceToken
    if (forceToken !== undefined && (agent.kind !== 'claude' || request.retry || typeof forceToken !== 'string' || forceToken.length !== 36)) {
      return chatSendResult({ ok: false, reason: 'draft-changed' })
    }
    if (agent.kind === 'antigravity') {
      if (!Array.isArray(keys) || keys.length || request.imageId !== undefined || request.retry || /^\/[^\s/]+(?:\s|$)/.test(text?.trimStart() ?? '')) return antigravityOnlyText
      if (!text) return { ok: false, error: '보낼 수 없는 글입니다 (비어 있거나, 제어 문자가 있거나, 너무 깁니다).' }
      if (agent.status === 'blocked' || local.approvalOf?.(id)) return antigravityTerminal
      if (agent.status !== 'idle') return { ok: false, reason: 'busy', error: 'Antigravity가 입력을 기다릴 때 보내 주세요.' }
      const agentId = local.chatAgentId?.(id)
      const isSameIdleEditor = () => {
        const active = local.agentOf(id)
        return allowed(event) && active?.kind === 'antigravity' && active.status === 'idle'
          && (active.sessionId ?? null) === (agent.sessionId ?? null) && local.chatAgentId?.(id) === agentId && !local.approvalOf?.(id)
      }
      const result = await local.chatSend(id, text, undefined, undefined, undefined, { canSend: isSameIdleEditor })
      return allowed(event) ? chatSendResult(result) : locked
    }
    const retry = retryRequest(request.retry)
    if (request.retry && (!retry || !text)) return { ok: false, error: '다시 보낼 메시지의 정보를 확인할 수 없습니다.' }
    const selected = imageDrafts.select(id, keys, { retry: Boolean(retry), retainFor: text ? 'retry' : 'preview' })
    if (!selected.ok) return selected
    const { files } = selected
    if (!text && (!files.length || typeof request.text !== 'string' || request.text.trim() || request.text.length > MAX_TEXT)) {
      return { ok: false, error: '보낼 수 없는 글입니다 (비어 있거나, 제어 문자가 있거나, 너무 깁니다).' }
    }
    const { prompt, images } = chatPrompt(agent.kind, text ?? '', files)
    // A slash command: what it does shows on the agent's screen (agentChat/commandScreen.js)
    const isCommand = !files.length && /^\/[^\s/]+(?:\s|$)/.test(prompt)
    if (retry) {
      if (isCommand) return { ok: false, error: '슬래시 명령은 다시 보내기에서 사용할 수 없습니다.' }
      return retrySend(event, id, local, agent, retry, text, Boolean(files.length), canSend =>
        selected.send(() => local.chatSend(id, prompt, images, undefined, undefined, { canSend })))
    }
    const before = isCommand ? local.chatScreen?.(id) ?? null : null
    let mcpSummary
    if (agent.kind === 'codex' && isCommand && prompt === '/mcp') {
      for (const [shell, previous] of mcpSummaries) {
        if (local.chatAgentId?.(shell) !== previous.agentId) mcpSummaries.delete(shell)
      }
      mcpSummaries.delete(id)
      const agentId = local.chatAgentId?.(id)
      if (agentId && fromChatWindow(event)) {
        mcpSummary = { agentId, id: randomUUID(), commands: null }
        mcpSummaries.set(id, mcpSummary)
      }
    }
    if (isCommand) commandWatches.delete(id)
    const result = await selected.send(() => agent.kind === 'claude'
      ? local.chatSend(id, prompt, images, undefined, undefined, { offerForce: true, forceToken, canSend: () => allowed(event) })
      : local.chatSend(id, prompt, images))
    if (result?.ok && isCommand) commandWatches.set(id, { before, kind: agent.kind, command: prompt, mcpSummary })
    if (!allowed(event)) return locked
    return chatSendResult(result)
  })
  // A choice of the prompt the view showed: main checks the screen still shows that very prompt
  ipcMain.handle('agent-chat-answer', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    const key = typeof request?.key === 'string' && /^[1-9]$/.test(request.key) ? request.key : null
    const signature = typeof request?.signature === 'string' && request.signature.length <= 20_000 ? request.signature : null
    if (!id || !key || !signature) return { ok: false, error: '답할 수 없는 선택입니다.' }
    const local = shells()
    if (!local) return { ok: false, error: REASONS['not-agent'] }
    if (local.agentOf(id)?.kind === 'antigravity') return antigravityTerminal
    const result = await local.answerApproval(id, key, signature)
    return result.ok ? { ok: true } : { ok: false, reason: result.reason, error: REASONS[result.reason] ?? '답하지 못했습니다.' }
  })
  // The window names the question (its tool item id) and the choices by number; the questions and their
  // labels come from main's own transcript, never from the window
  ipcMain.handle('agent-chat-answer-questions', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    const itemId = typeof request?.itemId === 'string' && /^tool:[\w-]{1,200}$/.test(request.itemId) ? request.itemId : null
    if (!id || !itemId || !Array.isArray(request?.answers)) return { ok: false, error: '답할 수 없는 선택입니다.' }
    if (shells()?.agentOf?.(id)?.kind === 'antigravity') return antigravityTerminal
    const pending = chats.pendingQuestion(id, itemId)
    if (!pending) return { ok: false, reason: 'answered', error: QUESTION_REASONS.answered }
    const { questions } = pending
    if (request.answers.length !== questions.length) return { ok: false, error: '답할 수 없는 선택입니다.' }
    const answers = questions.map((question, index) => cleanAnswer(question, request.answers[index]))
    if (answers.some(answer => !answer)) return { ok: false, error: '답할 수 없는 선택입니다.' }
    const local = shells()
    if (!local?.answerQuestions) return { ok: false, error: REASONS['not-agent'] }
    const result = await local.answerQuestions(id, questions, answers)
    if (!allowed(event)) return locked
    return result.ok ? { ok: true } : { ok: false, reason: result.reason, error: QUESTION_REASONS[result.reason] ?? '답하지 못했습니다.' }
  })
  // The model / effort under a local terminal: the window shows a remembered list and names a choice by its
  // label; main opens the CLI's own picker, finds that label and presses the keys (each only while that
  // picker shows). The list itself is read again on the menu's refresh.
  const pickerResult = result => (result.ok ? result : { ok: false, reason: result.reason, error: PICKER_REASONS[result.reason] ?? '바꾸지 못했습니다.', ...(result.options ? { options: result.options } : {}) })
  const pickerWhat = value => (value === 'model' || value === 'effort' ? value : null)
  ipcMain.handle('agent-picker-list', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    const what = pickerWhat(request?.what)
    if (!id || !what) return { ok: false, error: '바꿀 수 없는 항목입니다.' }
    const local = shells()
    if (!local) return { ok: false, error: REASONS['not-agent'] }
    if (local.agentOf(id)?.kind === 'antigravity') return antigravityOnlyText
    return pickerResult(await local.pickerList(id, what))
  })
  ipcMain.handle('agent-picker-apply', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    const what = pickerWhat(request?.what)
    const label = typeof request?.label === 'string' && request.label.trim() && request.label.length <= 100 ? request.label : null
    if (!id || !what || !label) return { ok: false, error: '고를 수 없는 항목입니다.' }
    const local = shells()
    if (!local) return { ok: false, error: REASONS['not-agent'] }
    if (local.agentOf(id)?.kind === 'antigravity') return antigravityOnlyText
    return pickerResult(await local.pickerApply(id, what, label))
  })
  ipcMain.handle('agent-chat-toggle-speed', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    const speed = request?.speed
    if (speed !== 'fast' && speed !== 'ultrafast') return { ok: false, error: '고를 수 없는 속도입니다.' }
    const local = shells()
    if (!id || !local) return { ok: false, error: REASONS['not-agent'] }
    if (local.agentOf(id)?.kind === 'antigravity') return antigravityOnlyText
    const result = await local.toggleCodexSpeed(id, speed)
    return result.ok ? result : { ...result, error: SPEED_REASONS[result.reason] ?? '속도 모드를 전환하지 못했습니다.' }
  })
  ipcMain.handle('agent-chat-interrupt', (event, shellId) => {
    const id = shellIdOf(shellId)
    const local = shells()
    return Boolean(allowed(event) && id && local?.agentOf(id)?.kind !== 'antigravity' && local?.interruptAgent(id))
  })
  // After Esc: the chat lines returned to the CLI's composer (cleared only when it holds
  // exactly them). The window already has the text; nothing is read off the screen for it.
  ipcMain.handle('agent-chat-take-back', async (event, request) => {
    if (!allowed(event)) return { ok: false, reason: 'locked' }
    const id = shellIdOf(request?.shellId)
    const raw = request?.texts
    if (!id || !Array.isArray(raw) || !raw.length || raw.length > MAX_TAKE_BACK) return { ok: false, reason: 'invalid' }
    const texts = raw.map(cleanChatText)
    if (texts.some(text => !text) || texts.join('\n').length > MAX_TEXT) return { ok: false, reason: 'invalid' }
    const local = shells()
    if (!local?.chatTakeBack) return { ok: false, reason: 'not-agent' }
    if (local.agentOf(id)?.kind === 'antigravity') return antigravityOnlyText
    return local.chatTakeBack(id, texts)
  })

  // A link in an answer: a file or folder of this PC (ezShell's file window or the file manager), or a
  // web page (the browser). Only a link of that shell's conversation; a file is never run.
  ipcMain.handle('agent-chat-preview-link', async (event, request) => {
    if (!fromChatWindow(event)) return locked
    const id = shellIdOf(request?.shellId)
    const target = id ? linkTarget(request?.link, process.platform, chats.cwdOf?.(id) ?? null) : null
    if (!id || target?.kind !== 'path' || !chats.knowsLink(id, target.key)) {
      return { ok: false, error: '대화에 나온 로컬 파일이나 폴더만 미리 볼 수 있습니다.' }
    }
    const authorized = chats.linkAuthority(id, target.key)
    const requestId = Symbol()
    pendingLinkPreviews.set(id, requestId)
    const current = () => fromChatWindow(event) && pendingLinkPreviews.get(id) === requestId && authorized()
    const stale = () => fromChatWindow(event) ? { ok: false, error: '대화의 링크가 바뀌었습니다.' } : locked
    try {
      const preview = await readLinkPreview(target, current)
      return current() ? { ok: true, preview } : stale()
    } catch {
      return current() ? { ok: false, error: '파일이나 폴더를 미리 볼 수 없습니다.' } : stale()
    } finally {
      if (pendingLinkPreviews.get(id) === requestId) pendingLinkPreviews.delete(id)
    }
  })

  ipcMain.handle('agent-chat-open-link', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    // A relative link is read against the agent's folder, as when the answer was read (chats.js)
    const cwd = id ? chats.cwdOf?.(id) ?? null : null
    const target = id ? linkTarget(request?.href, process.platform, cwd) : null
    if (!id || !target || !chats.knowsLink(id, target.key)) return { ok: false, error: '대화에 나온 링크만 열 수 있습니다.' }
    if (request.how === 'browser-tab' && target.kind === 'path') {
      if (!fromChatWindow(event) || !links?.openWorkspaceBrowser) return { ok: false, error: '브라우저에서 파일을 열 수 없습니다.' }
      const authorized = chats.linkAuthority(id, target.key)
      const root = cwd && sameOrInside(cwd, target.path) ? cwd : path.dirname(target.path)
      const relative = path.relative(root, target.path).split(path.sep).join('/')
      const result = await links.openWorkspaceBrowser(root, relative, () => fromChatWindow(event) && authorized())
      return result.success ? { ok: true } : { ok: false, error: result.error }
    }
    return openTarget(target, request?.how, () => allowed(event))
  })

  // An answer pinned out into a window of its own (pins.js): the window asks only about itself
  const pinOf = event => (!isLocked() && pins ? pins.ofSender(event.sender) : null)
  // An answer handed to another agent: into its inbox as a message from the user (handoff.js).
  // handoff: { agents() (agentMessages snapshot), send({ to, text }) (agentMessages.sendAsUser) }
  ipcMain.handle('agent-chat-handoff', (event, request) => {
    if (!fromChatWindow(event)) return locked
    if (!handoff) return { ok: false, error: '이 앱 버전에서는 쓸 수 없습니다.' }
    const id = shellIdOf(request?.shellId)
    const local = shells()
    const agent = id && local?.agentOf(id)
    if (!agent) return { ok: false, error: REASONS['not-agent'] }
    const prepared = prepareHandoff({ request, sourceAgentId: local.chatAgentId?.(id) ?? null, sourceKind: agent.kind, agents: handoff.agents() })
    if (prepared.error) return { ok: false, error: prepared.error }
    try {
      handoff.send({ to: prepared.to, text: prepared.text })
    } catch (error) {
      return { ok: false, error: String(error?.message || '인계하지 못했습니다.').slice(0, 200) }
    }
    return { ok: true, to: prepared.to, toLabel: prepared.toLabel }
  })
  ipcMain.handle('agent-chat-pin', (event, request) => {
    if (!allowed(event)) return locked
    if (!pins) return { ok: false, error: '이 앱 버전에서는 쓸 수 없습니다.' }
    return pins.pin(request)
  })
  ipcMain.handle('pinned-reply-get', (event) => {
    const pin = pinOf(event)
    return pin ? { ok: true, pin: pins.view(pin) } : { ok: false, error: '띄운 답변을 찾지 못했습니다.' }
  })
  ipcMain.handle('pinned-reply-open-link', async (event, request) => {
    const pin = pinOf(event)
    if (!pin) return locked
    const target = pins.linkFor(pin, request?.href)
    if (!target) return { ok: false, error: '대화에 나온 링크만 열 수 있습니다.' }
    return openTarget(target, request?.how, () => pinOf(event) === pin)
  })
  ipcMain.on('pinned-reply-fold', (event, folded) => {
    const pin = pinOf(event)
    if (pin && typeof folded === 'boolean') pins.fold(pin, folded)
  })
  // "원래 대화로 가기": the main window brings that shell's pane forward, as a chat
  ipcMain.on('pinned-reply-go', (event) => {
    const pin = pinOf(event)
    if (!pin) return
    // The owned window stays above the main window, even after the chat takes focus.
    if (pin.win.isMaximized()) pin.win.unmaximize()
    showShell?.(pin.shellId)
  })

  async function openTarget(target, how, stillAllowed) {
    if (target.kind === 'url') {
      if (how === 'browser-tab' && links?.openBrowserTab) {
        const result = links.openBrowserTab(target.url)
        return result.success ? { ok: true } : { ok: false, error: result.error }
      }
      if (how !== 'browser' || !links?.openExternal) return { ok: false, error: '열 수 없는 링크입니다.' }
      await links.openExternal(target.url)
      return { ok: true }
    }
    let entry
    try {
      entry = await resolveLocalPreviewPath(target.path)
    } catch {
      return { ok: false, error: '파일이나 폴더를 찾지 못했습니다.' }
    }
    if (!stillAllowed()) return locked
    const { path: real, stat } = entry
    if (!stat.isFile() && !stat.isDirectory()) return { ok: false, error: '파일이나 폴더만 열 수 있습니다.' }
    if (how === 'explorer' && links?.showItemInFolder) {
      links.showItemInFolder(real)
      return { ok: true }
    }
    if (how === 'workspace') {
      // The chat shows the folder in the workspace panel's tree; main only says where it is
      return stat.isDirectory() ? { ok: true, folder: real } : { ok: false, error: '폴더가 아닙니다.' }
    }
    if (how === 'app' && stat.isDirectory()) {
      // A folder (`docs/plan/`) opens in the file manager: ezShell has no window for a folder (2026-11-23 user report)
      if (!links?.openFolder) return { ok: false, error: '폴더는 파일 탐색기에서 열어 주세요.' }
      try {
        await links.openFolder(real)
      } catch {
        return { ok: false, error: '폴더를 열지 못했습니다.' }
      }
      return { ok: true }
    }
    if (how === 'app' && links?.openLocalFile) {
      // "README.md:187": the file opens at that line
      return links.openLocalFile(real, target.line ?? null)
    }
    return { ok: false, error: '열 수 없는 링크입니다.' }
  }

  return {
    clearClipboard() {
      imageDrafts.clearAll()
      mcpSummaries.clear()
    },
    async sendCapture(target, comment, getAttachments, stillOpen) {
      const local = shells()
      if (target.kind === 'antigravity' || local?.agentOf(target.shellId)?.kind === 'antigravity') return antigravityOnlyText
      const sameConversation = () => !isLocked() && stillOpen() && local?.chatAgentId(target.shellId) === target.id
      if (!sameConversation()) return { ok: false, error: '선택한 에이전트가 종료되었거나 바뀌었습니다.' }
      const trimmed = comment.trim()
      const text = trimmed ? cleanChatText(comment) : '첨부한 화면을 확인해 주세요.'
      if (!text) return { ok: false, error: '코멘트에 사용할 수 없는 문자가 있거나 너무 깁니다.' }
      // Every capture of the run, in order, in one message (docs/plan/2026-11-24-capture-multiple-shots.md)
      const attachments = getAttachments()
      const { prompt, images } = chatPrompt(target.kind, text, attachments.map(item => item.file))
      const shellId = target.shellId
      const id = `outgoing:${randomUUID()}`
      const queued = local.agentOf(shellId)?.status === 'working'
      const imageIds = imageDrafts.rememberCaptures(shellId, attachments)
      // Publish before Enter so even a transcript read on the next tick can match the previews.
      notifyCapture({ shellId, id, text, previews: attachments.map(item => item.preview), imageIds, queued, time: Date.now() })
      let result
      try {
        result = await local.chatSend(shellId, prompt, images, undefined, sameConversation)
        return chatSendResult(result)
      } finally {
        if (!result?.ok) {
          imageDrafts.forgetSent(imageIds)
          if (!isLocked()) notifyCapture({ shellId, id, discard: true })
        }
      }
    }
  }
}

// The phone's chat (src/remoteAccess/agentBridge.js) uses the same checks and wording
module.exports = { registerAgentChatIpc, cleanChatText, chatSendResult, CHAT_PROVIDERS, REASONS }
