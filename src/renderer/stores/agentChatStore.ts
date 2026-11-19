import { create } from 'zustand'
import type { AgentChatApproval, AgentChatFrame, AgentChatItem, AgentChatState } from '../types'
import { mergeChatItems } from '../lib/agentChatItems'
import { toast } from './toastStore'

// Which local shells are shown as a chat (components/AgentChat) and what each chat shows. Keyed by the
// shell id, not the pane: a shell that moves (panes swapped, moved to a tab, merged, the window
// reloaded) keeps its view. Any number of shells can be chats at once.

export interface AgentChat {
  state: AgentChatState | 'opening'
  kind: 'claude' | 'codex' | null
  title: string | null
  items: AgentChatItem[]
  hasOlder: boolean
  loadingOlder: boolean
  error: string | null
  /** The agent's prompt with choices on screen now */
  approval: AgentChatApproval | null
}

interface AgentChatStoreState {
  chats: ReadonlyMap<string, AgentChat>
  show: (shellId: string) => Promise<boolean>
  hide: (shellId: string) => void
  toggle: (shellId: string) => void
  loadOlder: (shellId: string) => void
  applyFrame: (frame: AgentChatFrame) => void
  /** App locked: every view goes back to the terminal and its conversation is dropped */
  clearAll: () => void
}

const empty = (): AgentChat => ({ state: 'opening', kind: null, title: null, items: [], hasOlder: false, loadingOlder: false, error: null, approval: null })

let stopFrames: (() => void) | null = null

export const useAgentChatStore = create<AgentChatStoreState>((set, get) => {
  const update = (shellId: string, change: (chat: AgentChat) => AgentChat) => set((state) => {
    const chat = state.chats.get(shellId)
    if (!chat) return state
    const next = new Map(state.chats)
    next.set(shellId, change(chat))
    return { chats: next }
  })

  return {
    chats: new Map(),
    async show(shellId) {
      if (get().chats.has(shellId)) return true
      stopFrames ??= window.electronAPI.onAgentChatFrame?.(frame => get().applyFrame(frame)) ?? null
      const next = new Map(get().chats)
      next.set(shellId, empty())
      set({ chats: next })
      const result = await window.electronAPI.agentChatOpen?.(shellId)
      if (result?.ok) return true
      // Not opened (no agent in the shell): back to the terminal
      get().hide(shellId)
      toast.error('채팅으로 볼 수 없습니다', result && !result.ok ? result.error : '이 앱 버전에서는 쓸 수 없습니다.')
      return false
    },
    hide(shellId) {
      if (!get().chats.has(shellId)) return
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
    applyFrame(frame) {
      if (frame.gone) {
        if (!get().chats.has(frame.shellId)) return
        const next = new Map(get().chats)
        next.delete(frame.shellId)
        set({ chats: next })
        return
      }
      update(frame.shellId, (chat) => {
        const mode = frame.reset ? 'reset' : frame.older ? 'older' : 'append'
        return {
          ...chat,
          state: frame.state ?? chat.state,
          kind: frame.kind ?? chat.kind,
          title: frame.title !== undefined ? frame.title : chat.title,
          items: frame.items || frame.reset ? mergeChatItems(chat.items, frame.items ?? [], mode) : chat.items,
          hasOlder: frame.hasOlder ?? chat.hasOlder,
          approval: frame.approval !== undefined ? frame.approval : chat.approval
        }
      })
    },
    clearAll() {
      for (const shellId of get().chats.keys()) window.electronAPI.agentChatClose?.(shellId)
      set({ chats: new Map() })
    }
  }
})

export const isChatShown = (shellId: string): boolean => useAgentChatStore.getState().chats.has(shellId)
