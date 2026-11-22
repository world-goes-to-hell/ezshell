import { create } from 'zustand'
import type { AgentChatApproval, AgentChatFrame, AgentChatItem, AgentChatState, AgentChatSubagent, CodexSpeedState } from '../types'
import { MAX_CHAT_ITEMS, echoItemIds, echoOutputId, reconcileChatEchoes, type ChatEcho } from '../lib/agentChatItems'
import { toast } from './toastStore'

// Which local shells are shown as a chat (components/AgentChat) and what each chat shows. Keyed by the
// shell id, not the pane: a shell that moves (panes swapped, moved to a tab, merged, the window
// reloaded) keeps its view. Any number of shells can be chats at once.

export interface AgentChat {
  scope: string | null
  state: AgentChatState | 'opening'
  kind: 'claude' | 'codex' | null
  title: string | null
  items: AgentChatItem[]
  subagents: AgentChatSubagent[]
  echoes: ChatEcho[]
  reply: { sendId: string; itemId: string } | null
  hasOlder: boolean
  loadingOlder: boolean
  error: string | null
  /** The agent's prompt with choices on screen now */
  approval: AgentChatApproval | null
  codexSpeed: CodexSpeedState | null
}

interface AgentChatStoreState {
  chats: ReadonlyMap<string, AgentChat>
  show: (shellId: string) => Promise<boolean>
  hide: (shellId: string) => void
  toggle: (shellId: string) => void
  loadOlder: (shellId: string) => void
  echoSend: (shellId: string, text: string, hasImage: boolean) => string
  discardSend: (shellId: string, sendId: string) => void
  stopWaiting: (shellId: string, sendId: string) => void
  /**
   * A slash command sent from the chat that no transcript records (Codex): marks the line with what came
   * of it and puts what it printed (read off the screen) under it
   */
  settleCommand: (shellId: string, sendId: string, result: { state: 'done' | 'screen'; output?: string }) => void
  applyFrame: (frame: AgentChatFrame) => void
  /** App locked: every view goes back to the terminal and its conversation is dropped */
  clearAll: () => void
}

const empty = (): AgentChat => ({ scope: null, state: 'opening', kind: null, title: null, items: [], subagents: [], echoes: [], reply: null, hasOlder: false, loadingOlder: false, error: null, approval: null, codexSpeed: null })

let stopFrames: (() => void) | null = null

/**
 * Lines sent from the chat that the transcript has not recorded yet, kept while the shell is shown as its
 * terminal: Claude records a slash command only once it has finished (a /compact takes minutes), so a
 * look at the terminal and back dropped the line the user had just sent (2026-11-20 user report).
 */
const KEPT_ECHO_MS = 30 * 60_000
const keptEchoes = new Map<string, { echoes: ChatEcho[]; items: AgentChatItem[]; reply: AgentChat['reply']; at: number }>()

function keepEchoes(shellId: string, chat: AgentChat) {
  const ids = echoItemIds(chat.echoes)
  const items = chat.items.filter(item => ids.has(item.id))
  if (!items.length) {
    keptEchoes.delete(shellId)
    return
  }
  // "답변 생성 중" goes with the line it waits on (the view clears it when the agent is idle again)
  const reply = chat.reply && ids.has(chat.reply.sendId) ? chat.reply : null
  keptEchoes.set(shellId, { echoes: chat.echoes.filter(echo => items.some(item => item.id === echo.id)), items, reply, at: Date.now() })
}

function takeEchoes(shellId: string): Pick<AgentChat, 'echoes' | 'items' | 'reply'> {
  const kept = keptEchoes.get(shellId)
  keptEchoes.delete(shellId)
  return kept && Date.now() - kept.at < KEPT_ECHO_MS
    ? { echoes: kept.echoes, items: kept.items, reply: kept.reply }
    : { echoes: [], items: [], reply: null }
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
    echoSend(shellId, text, hasImage) {
      const id = `outgoing:${crypto.randomUUID()}`
      const time = Date.now()
      const item: AgentChatItem = { id, kind: 'user', time, text: text || '스크린샷 첨부' }
      update(shellId, chat => {
        const items = [...chat.items, item].slice(-MAX_CHAT_ITEMS)
        const droppedId = chat.items.length >= MAX_CHAT_ITEMS ? chat.items[0].id : null
        return {
          ...chat, items,
          echoes: [...chat.echoes.filter(echo => echo.id !== droppedId), { id, text, hasImage, time }],
          reply: { sendId: id, itemId: id }
        }
      })
      return id
    },
    discardSend(shellId, sendId) {
      update(shellId, chat => ({
        ...chat,
        items: chat.items.filter(item => item.id !== sendId),
        echoes: chat.echoes.filter(echo => echo.id !== sendId),
        reply: chat.reply?.sendId === sendId ? null : chat.reply
      }))
    },
    stopWaiting(shellId, sendId) {
      update(shellId, chat => chat.reply?.sendId === sendId ? { ...chat, reply: null } : chat)
    },
    settleCommand(shellId, sendId, { state, output }) {
      update(shellId, chat => {
        const at = chat.items.findIndex(item => item.id === sendId)
        if (at === -1 || !chat.echoes.some(echo => echo.id === sendId)) return chat
        const line = { ...chat.items[at], commandState: state }
        const outputId = echoOutputId(sendId)
        const rest = chat.items.filter(item => item.id !== outputId)
        const items = rest.flatMap(item => item.id !== sendId ? [item]
          : output ? [line, { id: outputId, kind: 'output' as const, time: line.time, text: output }] : [line])
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
        const messages = frame.items || frame.reset ? reconcileChatEchoes(chat.items, frame.items ?? [], mode, chat.echoes) : null
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
          state: frame.state ?? chat.state,
          kind: frame.kind ?? chat.kind,
          title: frame.title !== undefined ? frame.title : chat.title,
          items: messages?.items ?? chat.items,
          subagents: frame.subagents ?? (frame.reset ? [] : chat.subagents),
          echoes: messages?.echoes ?? chat.echoes,
          reply,
          hasOlder: frame.hasOlder ?? chat.hasOlder,
          approval: frame.approval !== undefined ? frame.approval : chat.approval,
          codexSpeed: frame.codexSpeed !== undefined ? frame.codexSpeed : chat.codexSpeed
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
