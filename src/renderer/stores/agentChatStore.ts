import { create } from 'zustand'
import type { AgentChatApproval, AgentChatBackgroundShells, AgentChatCapture, AgentChatFrame, AgentChatItem, AgentChatMcpSummary, AgentChatProvider, AgentChatState, AgentChatSubagent, CodexSpeedState, LocalAgentStatus } from '../types'
import { MAX_CHAT_ITEMS, echoItemIds, echoOutputId, nextHeld, reconcileChatEchoes, sentImageKey, type ChatEcho, type SentChatImages } from '../lib/agentChatItems'
import { isSlashCommand } from '../lib/slashCommands'
import { toast } from './toastStore'

// Which local shells are shown as a chat (components/AgentChat) and what each chat shows. Keyed by the
// shell id, not the pane: a shell that moves (panes swapped, moved to a tab, merged, the window
// reloaded) keeps its view. Any number of shells can be chats at once.

export interface AgentChat {
  scope: string | null
  transcriptId: string | null
  state: AgentChatState | 'opening'
  kind: AgentChatProvider | null
  status: LocalAgentStatus | null
  title: string | null
  items: AgentChatItem[]
  subagents: AgentChatSubagent[]
  echoes: ChatEcho[]
  sentImages: ReadonlyMap<string, SentChatImages>
  /** Transcript ids of messages sent while the agent was busy, recorded but not yet read by the model */
  held: string[]
  reply: { sendId: string; itemId: string } | null
  latestMcpSendId: string | null
  hasOlder: boolean
  loadingOlder: boolean
  error: string | null
  /** The agent's prompt with choices on screen now */
  approval: AgentChatApproval | null
  codexSpeed: CodexSpeedState | null
  backgroundShells: AgentChatBackgroundShells | null
}

interface AgentChatStoreState {
  chats: ReadonlyMap<string, AgentChat>
  show: (shellId: string) => Promise<boolean>
  hide: (shellId: string) => void
  toggle: (shellId: string) => void
  loadOlder: (shellId: string) => void
  /** `queued`: the agent is busy, so the CLI holds the message until it can read it */
  echoSend: (shellId: string, text: string, previews: readonly Blob[], queued?: boolean, imageIds?: readonly string[]) => string
  acceptSend: (shellId: string, sendId: string, retryQueued?: boolean) => void
  confirmSend: (shellId: string, sendId: string, item: AgentChatItem) => void
  checkSendConfirmations: (shellId: string, idle: boolean) => number | undefined
  applyCapture: (capture: AgentChatCapture) => void
  discardSend: (shellId: string, sendId: string) => void
  stopWaiting: (shellId: string, sendId: string) => void
  /**
   * A slash command sent from the chat that no transcript records (Codex): marks the line with what came
   * of it and puts what it printed (read off the screen) under it
   */
  settleCommand: (shellId: string, sendId: string, result: { state: 'done' | 'screen'; output?: string; mcpSummary?: AgentChatMcpSummary }) => void
  applyFrame: (frame: AgentChatFrame) => void
  /** App locked: every view goes back to the terminal and its conversation is dropped */
  clearAll: () => void
}

const EMPTY_IMAGES: AgentChat['sentImages'] = new Map()
const empty = (): AgentChat => ({ scope: null, transcriptId: null, state: 'opening', kind: null, status: null, title: null, items: [], subagents: [], echoes: [], sentImages: EMPTY_IMAGES, held: [], reply: null, latestMcpSendId: null, hasOlder: false, loadingOlder: false, error: null, approval: null, codexSpeed: null, backgroundShells: null })

let stopFrames: (() => void) | null = null

/**
 * Lines sent from the chat that the transcript has not recorded yet, kept while the shell is shown as its
 * terminal: Claude records a slash command only once it has finished (a /compact takes minutes), so a
 * look at the terminal and back dropped the line the user had just sent (2026-11-20 user report).
 */
const KEPT_ECHO_MS = 30 * 60_000
const SEND_CONFIRMATION_MS = 15_000
const CHAT_IMAGE_BYTES = 4 * 1024 * 1024
const HIDDEN_CHAT_IMAGE_BYTES = 16 * 1024 * 1024
type RetainedChat = Pick<AgentChat, 'echoes' | 'sentImages' | 'held' | 'items' | 'reply' | 'latestMcpSendId'>
const keptEchoes = new Map<string, RetainedChat & { at: number }>()

function imageBytes(images: AgentChat['sentImages']): number {
  return Array.from(images.values()).reduce((total, entry) => total + entry.bytes, 0)
}

function addSentImages(images: AgentChat['sentImages'], item: AgentChatItem, text: string, previews: readonly Blob[]) {
  if (!previews.length) return images
  const next = new Map(images)
  next.set(sentImageKey(item), { text, previews, bytes: previews.reduce((total, preview) => total + preview.size, 0) })
  let bytes = imageBytes(next)
  for (const [key, entry] of next) {
    if (bytes <= CHAT_IMAGE_BYTES) break
    next.delete(key)
    bytes -= entry.bytes
  }
  return next
}

function reconcileSentImages(chat: AgentChat, recorded: ReadonlyMap<string, AgentChatItem>) {
  let next: Map<string, SentChatImages> | undefined
  for (const echo of chat.echoes) {
    const item = recorded.get(echo.id)
    if (!item) continue
    const key = sentImageKey(echo)
    const images = chat.sentImages.get(key)
    if (!images) continue
    next ??= new Map(chat.sentImages)
    next.delete(key)
    next.set(sentImageKey(item), images)
  }
  return next ?? chat.sentImages
}

function keepEchoes(shellId: string, chat: RetainedChat) {
  const ids = echoItemIds(chat.echoes)
  const items = chat.items.filter(item => ids.has(item.id))
  keptEchoes.delete(shellId)
  if (!items.length && !chat.held.length && !chat.sentImages.size) {
    return
  }
  // "답변 생성 중" goes with the line it waits on (the view clears it when the agent is idle again)
  const reply = chat.reply && ids.has(chat.reply.sendId) ? chat.reply : null
  // A recorded message still unread keeps its mark: the transcript is read again on return, ids and all
  const at = Date.now()
  const echoes = chat.echoes.filter(echo => items.some(item => item.id === echo.id)).map(pauseSendConfirmation)
  keptEchoes.set(shellId, { echoes, sentImages: chat.sentImages, held: chat.held, items, reply, latestMcpSendId: chat.latestMcpSendId, at })
  let bytes = 0
  for (const [id, kept] of [...keptEchoes].reverse()) {
    if (at - kept.at >= KEPT_ECHO_MS) {
      keptEchoes.delete(id)
      continue
    }
    const size = imageBytes(kept.sentImages)
    if (bytes + size > HIDDEN_CHAT_IMAGE_BYTES) kept.sentImages = EMPTY_IMAGES
    else bytes += size
  }
}

function takeEchoes(shellId: string): RetainedChat {
  const kept = keptEchoes.get(shellId)
  keptEchoes.delete(shellId)
  return kept && Date.now() - kept.at < KEPT_ECHO_MS
    ? { echoes: kept.echoes, sentImages: kept.sentImages, held: kept.held, items: kept.items, reply: kept.reply, latestMcpSendId: kept.latestMcpSendId }
    : { echoes: [], sentImages: EMPTY_IMAGES, held: [], items: [], reply: null, latestMcpSendId: null }
}

function discardEcho(chat: RetainedChat, sendId: string) {
  const echo = chat.echoes.find(echo => echo.id === sendId)
  const sentImages = new Map(chat.sentImages)
  if (echo) sentImages.delete(sentImageKey(echo))
  return {
    items: chat.items.filter(item => item.id !== sendId),
    echoes: chat.echoes.filter(echo => echo.id !== sendId),
    sentImages,
    reply: chat.reply?.sendId === sendId ? null : chat.reply
  }
}

function appendEcho(chat: RetainedChat, echo: ChatEcho, previews: readonly Blob[]): RetainedChat {
  const { id, time, text } = echo
  const item: AgentChatItem = { id, kind: 'user', time, text: text || '스크린샷 첨부' }
  const items = [...chat.items, item].slice(-MAX_CHAT_ITEMS)
  const droppedId = chat.items.length >= MAX_CHAT_ITEMS ? chat.items[0].id : null
  return {
    ...chat, items,
    sentImages: addSentImages(chat.sentImages, item, text, previews),
    echoes: [...chat.echoes.filter(echo => echo.id !== droppedId), echo],
    reply: { sendId: id, itemId: id }
  }
}

export function isUnconfirmedSend(chat: AgentChat, echo: ChatEcho): boolean {
  return chat.kind !== 'antigravity' && chat.state === 'live'
    && Boolean(chat.transcriptId && echo.delivery?.transcriptId === chat.transcriptId && echo.delivery.unconfirmed)
}

function acceptEcho(chat: RetainedChat, sendId: string, retryQueued?: boolean) {
  const at = chat.echoes.findIndex(echo => echo.id === sendId)
  const echo = chat.echoes[at]
  if (!echo?.delivery) return chat
  const echoes = chat.echoes.slice()
  echoes[at] = { ...echo, queued: retryQueued ?? echo.queued,
    delivery: { ...echo.delivery, acceptedAt: Date.now(), deadline: undefined, unconfirmed: undefined } }
  return { ...chat, echoes, reply: retryQueued === undefined ? chat.reply : { sendId, itemId: sendId } }
}

function pauseSendConfirmation(echo: ChatEcho): ChatEcho {
  const delivery = echo.delivery
  return delivery && (delivery.deadline !== undefined || delivery.unconfirmed)
    ? { ...echo, delivery: { ...delivery, deadline: undefined, unconfirmed: undefined } } : echo
}

export const useAgentChatStore = create<AgentChatStoreState>((set, get) => {
  const update = (shellId: string, change: (chat: AgentChat) => AgentChat) => set((state) => {
    const chat = state.chats.get(shellId)
    if (!chat) return state
    const changed = change(chat)
    if (changed === chat) return state
    const next = new Map(state.chats)
    next.set(shellId, changed)
    return { chats: next }
  })

  return {
    chats: new Map(),
    async show(shellId) {
      if (get().chats.has(shellId)) return true
      stopFrames ??= window.electronAPI.onAgentChatFrame?.(frame => get().applyFrame(frame)) ?? null
      const next = new Map(get().chats)
      // Lines sent before a look at the terminal come back until the transcript records them
      next.set(shellId, { ...empty(), ...takeEchoes(shellId) })
      set({ chats: next })
      const result = await window.electronAPI.agentChatOpen?.(shellId)
      if (result?.ok) return true
      // Not opened (no agent in the shell): back to the terminal
      get().hide(shellId)
      toast.error('채팅으로 볼 수 없습니다', result && !result.ok ? result.error : '이 앱 버전에서는 쓸 수 없습니다.')
      return false
    },
    hide(shellId) {
      const chat = get().chats.get(shellId)
      if (!chat) return
      keepEchoes(shellId, chat)
      window.electronAPI.agentChatClose?.(shellId)
      const next = new Map(get().chats)
      next.delete(shellId)
      set({ chats: next })
    },
    toggle(shellId) {
      if (get().chats.has(shellId)) get().hide(shellId)
      else void get().show(shellId)
    },
    loadOlder(shellId) {
      const chat = get().chats.get(shellId)
      if (!chat || !chat.hasOlder || chat.loadingOlder) return
      update(shellId, current => ({ ...current, loadingOlder: true }))
      void Promise.resolve(window.electronAPI.agentChatOlder?.(shellId)).finally(() => {
        update(shellId, current => ({ ...current, loadingOlder: false }))
      })
    },
    echoSend(shellId, text, previews, queued = false, imageIds = []) {
      const id = `outgoing:${crypto.randomUUID()}`
      update(shellId, chat => {
        const hasImage = previews.length > 0
        const delivery = text.trim() && (hasImage || !isSlashCommand(text))
          ? { transcriptId: chat.transcriptId, imageIds } : undefined
        const echo = { id, text, queued, time: Date.now(), hasImage, delivery }
        return {
          ...chat, ...appendEcho(chat, echo, previews),
          latestMcpSendId: !hasImage && text.trim() === '/mcp' ? id : chat.latestMcpSendId
        }
      })
      return id
    },
    acceptSend(shellId, sendId, retryQueued) {
      const kept = keptEchoes.get(shellId)
      if (kept) keptEchoes.set(shellId, { ...kept, ...acceptEcho(kept, sendId, retryQueued) })
      update(shellId, chat => {
        const accepted = acceptEcho(chat, sendId, retryQueued)
        return accepted === chat ? chat : { ...chat, ...accepted }
      })
    },
    confirmSend(shellId, sendId, item) {
      update(shellId, chat => {
        const echo = chat.echoes.find(echo => echo.id === sendId)
        if (!echo || echo.delivery?.transcriptId !== chat.transcriptId) return chat
        const messages = reconcileChatEchoes(chat.items, [item], 'append', [echo])
        if (!messages.recorded.has(sendId)) return chat
        return {
          ...chat, items: messages.items, echoes: chat.echoes.filter(other => other.id !== sendId),
          sentImages: reconcileSentImages(chat, messages.recorded),
          reply: chat.reply?.sendId === sendId ? null : chat.reply
        }
      })
    },
    checkSendConfirmations(shellId, idle) {
      let next: number | undefined
      update(shellId, chat => {
        if (!idle || chat.kind === 'antigravity' || chat.state !== 'live' || !chat.transcriptId) {
          const echoes = chat.echoes.map(pauseSendConfirmation)
          return echoes.some((echo, index) => echo !== chat.echoes[index]) ? { ...chat, echoes } : chat
        }
        const transcriptId = chat.transcriptId
        const now = Date.now()
        let changed = false
        let reply = chat.reply
        const echoes = chat.echoes.map(echo => {
          const delivery = echo.delivery
          if (delivery?.acceptedAt === undefined || delivery.unconfirmed || (delivery.transcriptId && delivery.transcriptId !== transcriptId)) return echo
          // A send can enter the queue before the CLI reports working. Require a full idle
          // window for every send so the transcript has time to catch up after the turn.
          const deadline = delivery.deadline ?? now + SEND_CONFIRMATION_MS
          const unconfirmed = deadline <= now
          if (unconfirmed && reply?.sendId === echo.id) reply = null
          if (!unconfirmed) next = Math.min(next ?? deadline, deadline)
          if (delivery.transcriptId === transcriptId && deadline === delivery.deadline && !unconfirmed) return echo
          changed = true
          return { ...echo, delivery: { ...delivery, transcriptId, deadline, unconfirmed: unconfirmed ? true as const : undefined } }
        })
        return changed ? { ...chat, echoes, reply } : chat
      })
      return next
    },
    applyCapture(capture) {
      const { shellId, id } = capture
      if ('discard' in capture) { get().discardSend(shellId, id); return }
      const { time, text, queued, preview } = capture
      const echo = { id, time, text, queued, hasImage: true }
      const previews = [new Blob([preview], { type: 'image/png' })]
      if (get().chats.has(shellId)) {
        update(shellId, chat => ({ ...chat, ...appendEcho(chat, echo, previews) }))
      } else {
        keepEchoes(shellId, appendEcho(takeEchoes(shellId), echo, previews))
      }
    },
    discardSend(shellId, sendId) {
      const kept = keptEchoes.get(shellId)
      if (kept) keptEchoes.set(shellId, { ...kept, ...discardEcho(kept, sendId) })
      update(shellId, chat => ({ ...chat, ...discardEcho(chat, sendId) }))
    },
    stopWaiting(shellId, sendId) {
      update(shellId, chat => chat.reply?.sendId === sendId ? { ...chat, reply: null } : chat)
    },
    settleCommand(shellId, sendId, { state, output, mcpSummary }) {
      update(shellId, chat => {
        const at = chat.items.findIndex(item => item.id === sendId)
        if (at === -1 || !chat.echoes.some(echo => echo.id === sendId)) return chat
        const line = { ...chat.items[at], commandState: state }
        const outputId = echoOutputId(sendId)
        const rest = chat.items.filter(item => item.id !== outputId)
        const result: AgentChatItem | null = output ? {
          id: outputId, kind: 'output', time: line.time, text: output, outputCommand: line.text,
          ...(mcpSummary && { mcpSummary })
        } : null
        const items = rest.flatMap(item => item.id !== sendId ? [item] : result ? [line, result] : [line])
        return { ...chat, items, reply: chat.reply?.sendId === sendId ? null : chat.reply }
      })
    },
    applyFrame(frame) {
      if (frame.gone) {
        keptEchoes.delete(frame.shellId)
        if (!get().chats.has(frame.shellId)) return
        const next = new Map(get().chats)
        next.delete(frame.shellId)
        set({ chats: next })
        return
      }
      update(frame.shellId, (chat) => {
        const mode = frame.reset ? 'reset' : frame.older ? 'older' : 'append'
        const kind = frame.kind ?? chat.kind
        const transcriptId = frame.reset ? frame.transcriptId ?? null : chat.transcriptId
        let echoes = chat.echoes
        if (frame.reset && (transcriptId || kind === 'antigravity')) {
          echoes = echoes.filter(echo => !echo.delivery?.transcriptId || echo.delivery.transcriptId === transcriptId)
          if (kind === 'antigravity' && transcriptId) echoes = echoes.map(echo => echo.delivery && !echo.delivery.transcriptId
            ? { ...echo, delivery: { ...echo.delivery, transcriptId } } : echo)
        }
        const messages = frame.items || frame.reset ? reconcileChatEchoes(chat.items, frame.items ?? [], mode, echoes) : null
        let reply = frame.state === 'ended' ? null : chat.reply
        if (messages && reply) {
          const itemId = messages.recorded.get(reply.itemId)?.id ?? reply.itemId
          const at = messages.items.findIndex(item => item.id === itemId)
          // An answer, or what a slash command printed, ends the wait
          if (at === -1 || messages.items.slice(at + 1).some(item => item.kind === 'assistant' || item.kind === 'output')) reply = null
          else if (itemId !== reply.itemId) reply = { ...reply, itemId }
        }
        return {
          ...chat,
          scope: frame.reset ? frame.scope ?? null : chat.scope,
          transcriptId,
          state: frame.state ?? chat.state,
          kind,
          status: frame.status === undefined ? chat.status : frame.status,
          title: frame.title !== undefined ? frame.title : chat.title,
          items: messages?.items ?? chat.items,
          sentImages: messages ? reconcileSentImages(chat, messages.recorded) : chat.sentImages,
          subagents: frame.subagents ?? (frame.reset ? [] : chat.subagents),
          echoes: messages?.echoes ?? chat.echoes,
          // Only Codex records a message before reading it; Claude writes it as it reads it
          held: messages ? nextHeld(chat.held, kind === 'codex' ? messages.recorded : new Map(), chat.echoes, messages.items) : chat.held,
          reply,
          hasOlder: frame.hasOlder ?? chat.hasOlder,
          approval: frame.approval !== undefined ? frame.approval : chat.approval,
          codexSpeed: frame.codexSpeed !== undefined ? frame.codexSpeed : chat.codexSpeed,
          backgroundShells: frame.backgroundShells !== undefined ? frame.backgroundShells : chat.backgroundShells
        }
      })
    },
    clearAll() {
      // Locked: what the user sent goes with the conversation
      keptEchoes.clear()
      for (const shellId of get().chats.keys()) window.electronAPI.agentChatClose?.(shellId)
      set({ chats: new Map() })
    }
  }
})

export const isChatShown = (shellId: string): boolean => useAgentChatStore.getState().chats.has(shellId)
