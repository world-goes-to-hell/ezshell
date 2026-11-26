import { useEffect, useRef } from 'react'
import { INITIAL_SCREEN_WATCH, readScreenWatch } from '../../lib/agentScreenWatch'
import { useAgentScreenReturnStore } from '../../stores/agentScreenReturnStore'

const POLL_MS = 1000

/**
 * While the chat shows, reads the agent's screen about once a second; when a screen of the CLI's own has
 * taken the composer's place (lib/agentScreenWatch.ts) the pane goes to the terminal with the 채팅으로 bar,
 * and comes back by itself once the composer returns (agentScreenReturnStore).
 */
export function useAgentScreenWatch(shellId: string, enabled: boolean, onShowTerminal: () => void) {
  const show = useRef(onShowTerminal)
  show.current = onShowTerminal
  useEffect(() => {
    const read = window.electronAPI.agentChatScreenState
    if (!enabled || !read) return
    let watch = INITIAL_SCREEN_WATCH
    let reading = false
    const timer = window.setInterval(async () => {
      if (reading || useAgentScreenReturnStore.getState().returns.has(shellId)) return
      reading = true
      try {
        const next = readScreenWatch(watch, await read(shellId))
        watch = next.watch
        if (next.open && !useAgentScreenReturnStore.getState().returns.has(shellId)) {
          useAgentScreenReturnStore.getState().begin(shellId)
          show.current()
        }
      } catch {
        watch = INITIAL_SCREEN_WATCH
      } finally {
        reading = false
      }
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [shellId, enabled])
}
