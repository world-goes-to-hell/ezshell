import { create } from 'zustand'
import type { AgentSleep } from '../types'
import { AGENT_IDLE_CHANGED, readAgentIdlePrefs, type AgentIdlePrefs } from '../lib/agentIdlePrefs'
import { toast } from './toastStore'

// Agents of local shells closed to save memory (src/agentIdle.js), by shell id: their pane shows them
// asleep until they are woken (there, or by a message for them).

interface AgentSleepState {
  sleeping: Map<string, AgentSleep>
  set: (id: string, sleep: AgentSleep | null) => void
}

export const useAgentSleepStore = create<AgentSleepState>(set => ({
  sleeping: new Map(),
  set: (id, sleep) => set(state => {
    const sleeping = new Map(state.sleeping)
    if (sleep) sleeping.set(id, sleep)
    else sleeping.delete(id)
    return { sleeping }
  })
}))

/** Follows main's sleeps and sends it the idle settings; once per window. Returns the cleanup. */
export function startAgentSleep(): () => void {
  const api = window.electronAPI
  if (typeof api.onLocalShellSleep !== 'function') return () => {}
  const { set } = useAgentSleepStore.getState()
  const stop = api.onLocalShellSleep(({ id, sleeping, failed }) => {
    set(id, sleeping)
    if (failed) toast.error('에이전트를 다시 띄우지 못했습니다. 터미널에서 직접 실행해 주세요.')
  })
  void api.localShellSleeping?.().then(list => { for (const { id, sleeping } of list) set(id, sleeping) }).catch(() => {})
  const configure = (prefs: AgentIdlePrefs) => { void api.agentIdleConfigure?.(prefs).catch(() => {}) }
  configure(readAgentIdlePrefs())
  const onChange = (event: Event) => configure((event as CustomEvent<AgentIdlePrefs>).detail)
  window.addEventListener(AGENT_IDLE_CHANGED, onChange)
  return () => {
    stop()
    window.removeEventListener(AGENT_IDLE_CHANGED, onChange)
  }
}
