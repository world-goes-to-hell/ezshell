// The window names a shell and sends a draft. Main owns the transcript and clipboard image paths.
const { randomUUID } = require('node:crypto')
const fs = require('fs')
const { linkTarget } = require('./links.js')

const SHELL_ID = /^local:\d+$/
const MAX_TEXT = 16_000

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
  'write-failed': '셸에 쓰지 못했습니다.'
}

/**
 * links: { openExternal(url), showItemInFolder(path), openLocalFile(path) → { ok } | { ok, error } }
 */
function registerAgentChatIpc({ ipcMain, fromMainWindow, isLocked, chats, shells, clipboard, links }) {
  const allowed = event => fromMainWindow(event) && !isLocked()
  const shellIdOf = value => (typeof value === 'string' && SHELL_ID.test(value) ? value : null)
  const locked = { ok: false, error: '먼저 잠금을 해제해 주세요.' }
  const images = new Map()
  const clipboardReads = new Map()

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
  ipcMain.on('agent-chat-close', (event, shellId) => {
    const id = shellIdOf(shellId)
    if (!fromMainWindow(event) || !id) return
    images.delete(id)
    clipboardReads.delete(id)
    chats.close(id)
  })
  ipcMain.handle('agent-chat-read-clipboard', async (event, shellId) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(shellId)
    const agent = id && shells()?.agentOf(id)
    if (!agent) return { ok: false, error: REASONS['not-agent'] }
    if (clipboardReads.has(id)) return { ok: false, error: '클립보드를 읽는 중입니다.' }
    const read = {}
    clipboardReads.set(id, read)
    const canUseClipboard = () => allowed(event) && clipboardReads.get(id) === read && shells()?.agentOf(id)?.kind === agent.kind
    try {
      const { text, image } = await clipboard.read()
      if (!canUseClipboard()) return { ok: false, error: '열려 있는 채팅에서 다시 붙여넣어 주세요.' }
      if (!image) return { ok: true, kind: 'text', text }
      const bitmap = await clipboard.decodeImage(image)
      if (!canUseClipboard()) return { ok: false, error: '열려 있는 채팅에서 다시 붙여넣어 주세요.' }
      const { width, height } = bitmap.getSize()
      const edge = Math.max(width, height)
      const preview = edge > 280 ? bitmap.resize(width >= height ? { width: 280 } : { height: 280 }).toPNG() : bitmap.toPNG()
      const attachmentId = randomUUID()
      images.set(id, { id: attachmentId, bitmap })
      return { ok: true, kind: 'image', id: attachmentId, preview }
    } catch (error) {
      return { ok: false, error: error.code ? '클립보드 이미지를 읽지 못했습니다.' : error.message }
    } finally {
      if (clipboardReads.get(id) === read) clipboardReads.delete(id)
    }
  })
  ipcMain.on('agent-chat-remove-image', (event, request) => {
    if (!allowed(event)) return
    const id = shellIdOf(request?.shellId)
    const image = images.get(id)
    if (image && image.id === request.imageId) images.delete(id)
  })
  ipcMain.handle('agent-chat-send', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    const text = cleanChatText(request?.text)
    if (!id) return { ok: false, error: '셸을 찾지 못했습니다.' }
    const image = images.get(id)
    const hasImage = Boolean(image && image.id === request.imageId)
    if (request.imageId !== undefined && !hasImage) return { ok: false, error: '클립보드 이미지를 다시 붙여넣어 주세요.' }
    if (!text && (!hasImage || typeof request.text !== 'string' || request.text.trim() || request.text.length > MAX_TEXT)) {
      return { ok: false, error: '보낼 수 없는 글입니다 (비어 있거나, 제어 문자가 있거나, 너무 깁니다).' }
    }
    const local = shells()
    if (!local?.agentOf(id)) return { ok: false, error: REASONS['not-agent'] }
    let prompt = text
    if (hasImage) {
      try {
        image.file ??= clipboard.storeImage(image.bitmap)
      } catch {
        return { ok: false, error: '첨부 이미지를 저장하지 못했습니다.' }
      }
      const attachment = '첨부 이미지를 열어 확인해 주세요.\n' + image.file
      // Put the reference before the draft so a slash command in the draft stays ordinary text.
      prompt = text ? attachment + '\n\n' + text : attachment
    }
    const result = await local.chatSend(id, prompt)
    if (!allowed(event)) return locked
    if (result.ok && hasImage && images.get(id) === image) images.delete(id)
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
  ipcMain.handle('agent-chat-interrupt', (event, shellId) => {
    const id = shellIdOf(shellId)
    return Boolean(allowed(event) && id && shells()?.interruptAgent(id))
  })

  // A link in an answer: a file or folder of this PC (ezShell's file window or the file manager), or a
  // web page (the browser). Only a link of that shell's conversation; a file is never run.
  ipcMain.handle('agent-chat-open-link', async (event, request) => {
    if (!allowed(event)) return locked
    const id = shellIdOf(request?.shellId)
    const how = request?.how
    const target = linkTarget(request?.href)
    if (!id || !target || !chats.knowsLink(id, target.key)) return { ok: false, error: '대화에 나온 링크만 열 수 있습니다.' }
    if (target.kind === 'url') {
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
    if (!allowed(event)) return locked
    if (how === 'explorer' && links?.showItemInFolder) {
      links.showItemInFolder(real)
      return { ok: true }
    }
    if (how === 'app' && links?.openLocalFile) {
      if (!stat.isFile()) return { ok: false, error: '폴더는 파일 탐색기에서 열어 주세요.' }
      return links.openLocalFile(real)
    }
    return { ok: false, error: '열 수 없는 링크입니다.' }
  })

  return {
    clearClipboard() {
      clipboardReads.clear()
      images.clear()
    }
  }
}

module.exports = { registerAgentChatIpc, cleanChatText }
