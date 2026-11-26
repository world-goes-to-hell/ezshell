import { create } from 'zustand'
import { useAgentChatStore } from './agentChatStore'

// A slash command sent from the chat opened a screen of the CLI's own (`/config`, `/resume`, `/mcp` …):
// the chat cannot draw it, so the pane shows the real terminal and the user works the screen there. Once
// the agent's composer is back (the screen closed) the pane goes back to the chat (user request,
// 2026-11-21: every slash command should work from the chat).

const POLL_MS = 600
// Read twice in a row: a screen being redrawn can look like the composer for a moment
const STEADY_READS = 2
const GIVE_UP_MS = 30 * 60_000
const LOGIN_DRAW_MS = 1800

type ScreenReturn = { login: boolean; continueLogin: boolean }

interface AgentScreenReturnState {
  /** Shell id → the terminal screen the pane is waiting for */
  returns: ReadonlyMap<string, ScreenReturn>
  begin: (shellId: string, login?: boolean) => void
  /** Back to the chat now (button), or stay in the terminal (`back` false) */
  end: (shellId: string, back: boolean) => void
}

const timers = new Map<string, number>()

export const useAgentScreenReturnStore = create<AgentScreenReturnState>((set, get) => {
  function stop(shellId: string) {
    const timer = timers.get(shellId)
    if (timer !== undefined) window.clearInterval(timer)
    timers.delete(shellId)
    if (!get().returns.has(shellId)) return
    const next = new Map(get().returns)
    next.delete(shellId)
    set({ returns: next })
  }

  function backToChat(shellId: string) {
    stop(shellId)
    void useAgentChatStore.getState().show(shellId).then(shown => {
      if (shown) window.setTimeout(() => document.getElementById(`agent-chat-input-${shellId}`)?.focus(), 0)
    })
  }

  return {
    returns: new Map(),
    begin(shellId, login = false) {
      const read = window.electronAPI.agentChatScreenState
      if (!read) return
      stop(shellId)
      const started = Date.now()
      const initial: ScreenReturn = { login, continueLogin: false }
      set({ returns: new Map(get().returns).set(shellId, initial) })
      let steady = 0
      let reading = false
      let sawScreen = false
      const timer = window.setInterval(async () => {
        // The user opened the chat again meanwhile, or it has been long enough
        if (useAgentChatStore.getState().chats.has(shellId) || Date.now() - started > GIVE_UP_MS) return stop(shellId)
        if (reading) return
        reading = true
        try {
          const screen = await read(shellId)
          if (timers.get(shellId) !== timer) return
          if (!screen) return stop(shellId)
          const previous = get().returns.get(shellId)
          if (!previous) return
          const next = { login: previous.login || Boolean(screen.loginStage), continueLogin: screen.loginStage === 'continue' }
          if (next.login !== previous.login || next.continueLogin !== previous.continueLogin) {
            set({ returns: new Map(get().returns).set(shellId, next) })
          }
          sawScreen ||= screen.composer === null || Boolean(screen.loginStage)
          const drawn = !login || sawScreen || Date.now() - started >= LOGIN_DRAW_MS
          steady = drawn && screen.composer !== null && !screen.approval && !screen.loginStage ? steady + 1 : 0
          if (steady >= STEADY_READS) backToChat(shellId)
        } catch {
          if (timers.get(shellId) === timer) stop(shellId)
        } finally {
          reading = false
        }
      }, POLL_MS)
      timers.set(shellId, timer)
    },
    end(shellId, back) {
      if (back) backToChat(shellId)
      else stop(shellId)
    }
  }
})
