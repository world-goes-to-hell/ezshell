// The window names a shell and sends a draft. Main owns the transcript and clipboard image paths.
const { randomUUID } = require('node:crypto')
const fs = require('fs')
const { linkTarget } = require('./links.js')
const { routeSubagent, subagentRelayText } = require('./subagentChat.js')
const { watchCommand } = require('./commandScreen.js')
const { customCommands } = require('./slashCommands.js')

const SHELL_ID = /^local:\d+$/
const MAX_TEXT = 16_000
const MAX_IMAGES = 8
const IMAGE_LIMIT = '이미지는 한 메시지에 최대 8장까지 첨부할 수 있습니다.'

/**
 * The text as it may be pasted into the agent's composer, or null. Control characters are refused:
 * an ESC could end the bracketed paste early and the rest would reach the terminal as keys.
 */
function cleanChatText(value) {
  if (typeof value !== 'string' || value.length > MAX_TEXT) return null
  const text = value.replace(/\r\n?/g, '\n')
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return null
  const trimmed = text.replace(/^\n+/, '').replace(/\s+$/, '')
  return trimmed || null
}

const REASONS = {
  'not-agent': '이 셸에서 돌고 있는 에이전트가 없습니다.',
  approval: '에이전트가 확인을 기다리고 있습니다. 터미널에서 답해 주세요.',
  'no-composer': '에이전트의 입력칸을 찾지 못했습니다. 터미널 보기에서 확인해 주세요.',
  'composer-not-empty': '에이전트 입력칸에 쓰던 글이 있습니다. 터미널에서 지우거나 보낸 뒤 다시 시도해 주세요.',
  'not-drawn': '입력칸에 글이 그대로 들어가지 않아 보내지 않았습니다. 터미널 보기에서 확인해 주세요.',
  busy: '다른 입력을 넣는 중입니다. 잠시 뒤 다시 시도해 주세요.',
  changed: '화면의 질문이 바뀌었습니다. 새 질문을 보고 다시 골라 주세요.',
  'target-changed': 'CLI의 입력 대상이 바뀌었습니다. 터미널에서 현재 대화를 확인해 주세요.',
  'write-failed': '셸에 쓰지 못했습니다.'
}
const SPEED_REASONS = {
  ...REASONS,
  working: 'Codex가 입력을 기다릴 때 전환할 수 있습니다.',
  'speed-unavailable': '현재 모델이나 Codex 설정에서 이 속도 모드를 사용할 수 없습니다.',
  'speed-unconfirmed': 'Codex의 속도 변경을 확인하지 못했습니다. 터미널에서 현재 설정을 확인해 주세요.'
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
 * links: { openExternal(url), openBrowserTab(url), showItemInFolder(path), openLocalFile(path) }
 * pins: answers pinned into windows of their own (pins.js); showShell(shellId): the main window
 * brings that shell's pane forward as a chat
 */
function registerAgentChatIpc({ ipcMain, fromMainWindow, isLocked, chats, shells, clipboard, selectImages, links, pins = null, showShell = null }) {
  const allowed = event => fromMainWindow(event) && !isLocked()
  const shellIdOf = value => (typeof value === 'string' && SHELL_ID.test(value) ? value : null)
  const locked = { ok: false, error: '먼저 잠금을 해제해 주세요.' }
  const images = new Map()
  const imageReads = new Map()
  // A slash command just sent from the chat: the agent's screen before it, read by agent-chat-command-watch
  const commandWatches = new Map()

  function removeImages(id, ids) {
    const attachments = images.get(id)
    if (!attachments) return
    for (const key of ids ?? attachments.keys()) {
      const image = attachments.get(key)
      if (!image) continue
      attachments.delete(key)
      if (!image.sending) clipboard.discardImage(image.file)
    }
    if (!attachments.size) images.delete(id)
  }

  async function readAttachments(event, shellId, read) {
    if (!allowed(event)) return locked
    const id = shellIdOf(shellId)
    const agent = id && shells()?.agentOf(id)
    if (!agent) return { ok: false, error: REASONS['not-agent'] }
    if (imageReads.has(id)) return { ok: false, error: '첨부할 이미지를 읽는 중입니다.' }
    const token = {}
    imageReads.set(id, token)
    const staged = []
    const canUse = () => allowed(event) && imageReads.get(id) === token && shells()?.agentOf(id)?.kind === agent.kind
    const noChat = '열려 있는 채팅에서 다시 첨부해 주세요.'
    const room = () => MAX_IMAGES - (images.get(id)?.size ?? 0) - staged.length
    const addImage = bitmap => {
      if (!canUse()) throw new Error(noChat)
      if (room() === 0) throw new Error(IMAGE_LIMIT)
      const { width, height } = bitmap.getSize()
      const edge = Math.max(width, height)
      const preview = edge > 280 ? bitmap.resize(width >= height ? { width: 280 } : { height: 280 }).toPNG() : bitmap.toPNG()
      staged.push({ id: randomUUID(), file: clipboard.storeImage(bitmap), preview })
    }
    try {
      const result = await read(addImage, room)
      if (!canUse()) throw new Error(noChat)
      if (result) return result
      const attachments = images.get(id) ?? new Map()
      const previews = staged.splice(0).map(({ id, file, preview }) => {
        attachments.set(id, { file })
        return { id, preview }
      })
      if (previews.length) images.set(id, attachments)
      return { ok: true, kind: 'images', images: previews }
    } catch (error) {
      return { ok: false, error: error.code ? '첨부 이미지를 처리하지 못했습니다.' : error.message }
    } finally {
      for (const { file } of staged) clipboard.discardImage(file)
      if (imageReads.get(id) === token) imageReads.delete(id)
    }
  }

  ipcMain.handle('agent-chat-open', (event, shellId) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(shellId)
    if (!id) return { ok: false, error: '셸을 찾지 못했습니다.' }
    if (!shells()?.agentOf(id)) return { ok: false, error: REASONS['not-agent'] }
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
    const result = await chats.questions(id)
    return allowed(event) ? result : locked
  })
  ipcMain.handle('agent-chat-question-context', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    if (!id || typeof request.scope !== 'string' || typeof request.id !== 'string' || request.id.length > 160) {
      return { ok: false, error: '질문을 찾지 못했습니다.' }
    }
    const result = await chats.questionContext(id, request.scope, request.id)
    return allowed(event) ? result : locked
  })
  ipcMain.handle('agent-chat-subagent-preview', async (event, shellId, agentId) => {
    const id = shellIdOf(shellId)
    if (!allowed(event) || !id || typeof agentId !== 'string' || agentId.length > 500) return []
    const activity = await chats.subagentPreview(id, agentId)
    return allowed(event) ? activity : []
  })
  async function subagentFor(event, shellId, agentId) {
    if (!allowed(event) || !shellIdOf(shellId) || typeof agentId !== 'string' || agentId.length > 500) return null
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
    const pending = id && commandWatches.get(id)
    if (!pending) return { ok: false, error: '확인할 명령이 없습니다.' }
    commandWatches.delete(id)
    const outcome = await watchCommand({ read: () => shells()?.chatScreen?.(id) ?? null, ...pending })
    return allowed(event) ? { ok: true, ...outcome } : locked
  })
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
    removeImages(id)
    imageReads.delete(id)
    chats.close(id)
  })
  ipcMain.handle('agent-chat-read-clipboard', (event, shellId) =>
    readAttachments(event, shellId, async (addImage, room) => {
      const { text, image } = await clipboard.read()
      if (!image) return { ok: true, kind: 'text', text }
      if (!room()) throw new Error(IMAGE_LIMIT)
      addImage(await clipboard.decodeImage(image))
    })
  )
  ipcMain.handle('agent-chat-pick-images', (event, shellId) =>
    readAttachments(event, shellId, async (addImage, room) => {
      if (!room()) throw new Error(IMAGE_LIMIT)
      const paths = await selectImages()
      if (paths.length > room()) throw new Error(IMAGE_LIMIT)
      for (const path of paths) addImage(await clipboard.decodeImageFile(path))
    })
  )
  ipcMain.on('agent-chat-remove-image', (event, request) => {
    if (allowed(event) && typeof request?.imageId === 'string') removeImages(shellIdOf(request.shellId), [request.imageId])
  })
  ipcMain.handle('agent-chat-send', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    const text = cleanChatText(request?.text)
    if (!id) return { ok: false, error: '셸을 찾지 못했습니다.' }
    const keys = request.imageIds ?? (request.imageId === undefined ? [] : [request.imageId])
    const attachments = images.get(id)
    const missingImage = { ok: false, error: '이미지를 다시 첨부해 주세요.' }
    if (!Array.isArray(keys) || keys.length > MAX_IMAGES || new Set(keys).size !== keys.length) return missingImage
    const selected = keys.map(key => attachments?.get(key))
    if (selected.some(image => !image)) return missingImage
    if (selected.some(image => image.sending)) return { ok: false, error: REASONS.busy }
    if (!text && (!selected.length || typeof request.text !== 'string' || request.text.trim() || request.text.length > MAX_TEXT)) {
      return { ok: false, error: '보낼 수 없는 글입니다 (비어 있거나, 제어 문자가 있거나, 너무 깁니다).' }
    }
    const local = shells()
    const agent = local?.agentOf(id)
    if (!agent) return { ok: false, error: REASONS['not-agent'] }
    let prompt = text
    let claudeImages
    if (selected.length) {
      const paths = selected.map(image => image.file).join('\n')
      // Keep the references first so a slash command in the draft stays ordinary text.
      prompt = text ? paths + '\n\n' + text : paths
      if (agent.kind === 'claude') {
        claudeImages = { count: selected.length, text: text ?? '' }
      }
    }
    // A slash command: what it does shows on the agent's screen (agentChat/commandScreen.js)
    const isCommand = !selected.length && /^\/[^\s/]+(?:\s|$)/.test(prompt)
    const before = isCommand ? local.chatScreen?.(id)?.lines ?? null : null
    if (isCommand) commandWatches.delete(id)
    for (const image of selected) image.sending = true
    let result
    try {
      result = await local.chatSend(id, prompt, claudeImages)
      if (result?.ok && isCommand) commandWatches.set(id, { before, kind: agent.kind, command: prompt })
    } finally {
      selected.forEach((image, index) => {
        image.sending = false
        const key = keys[index]
        if (result?.ok) {
          // The agent can read a successfully sent image after this chat is closed.
          attachments.delete(key)
        } else if (attachments.get(key) !== image) {
          clipboard.discardImage(image.file)
        }
      })
      if (attachments && !attachments.size && images.get(id) === attachments) images.delete(id)
    }
    if (!allowed(event)) return locked
    return result.ok ? { ok: true } : { ok: false, reason: result.reason, error: REASONS[result.reason] ?? '보내지 못했습니다.' }
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
    const result = await local.answerApproval(id, key, signature)
    return result.ok ? { ok: true } : { ok: false, reason: result.reason, error: REASONS[result.reason] ?? '답하지 못했습니다.' }
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
    return pickerResult(await local.pickerApply(id, what, label))
  })
  ipcMain.handle('agent-chat-toggle-speed', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    const speed = request?.speed
    if (speed !== 'fast' && speed !== 'ultrafast') return { ok: false, error: '고를 수 없는 속도입니다.' }
    const local = shells()
    if (!id || !local) return { ok: false, error: REASONS['not-agent'] }
    const result = await local.toggleCodexSpeed(id, speed)
    return result.ok ? result : { ...result, error: SPEED_REASONS[result.reason] ?? '속도 모드를 전환하지 못했습니다.' }
  })
  ipcMain.handle('agent-chat-interrupt', (event, shellId) => {
    const id = shellIdOf(shellId)
    return Boolean(allowed(event) && id && shells()?.interruptAgent(id))
  })

  // A link in an answer: a file or folder of this PC (ezShell's file window or the file manager), or a
  // web page (the browser). Only a link of that shell's conversation; a file is never run.
  ipcMain.handle('agent-chat-open-link', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    // A relative link is read against the agent's folder, as when the answer was read (chats.js)
    const target = id ? linkTarget(request?.href, process.platform, chats.cwdOf?.(id) ?? null) : null
    if (!id || !target || !chats.knowsLink(id, target.key)) return { ok: false, error: '대화에 나온 링크만 열 수 있습니다.' }
    return openTarget(target, request?.how, () => allowed(event))
  })

  // An answer pinned out into a window of its own (pins.js): the window asks only about itself
  const pinOf = event => (!isLocked() && pins ? pins.ofSender(event.sender) : null)
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
    if (pin) showShell?.(pin.shellId)
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
    let real
    let stat
    try {
      real = await fs.promises.realpath(target.path)
      stat = await fs.promises.stat(real)
    } catch {
      return { ok: false, error: '파일이나 폴더를 찾지 못했습니다.' }
    }
    if (!stillAllowed()) return locked
    if (how === 'explorer' && links?.showItemInFolder) {
      links.showItemInFolder(real)
      return { ok: true }
    }
    if (how === 'app' && links?.openLocalFile) {
      if (!stat.isFile()) return { ok: false, error: '폴더는 파일 탐색기에서 열어 주세요.' }
      // "README.md:187": the file opens at that line
      return links.openLocalFile(real, target.line ?? null)
    }
    return { ok: false, error: '열 수 없는 링크입니다.' }
  }

  return {
    clearClipboard() {
      imageReads.clear()
      for (const id of images.keys()) removeImages(id)
    }
  }
}

module.exports = { registerAgentChatIpc, cleanChatText }
