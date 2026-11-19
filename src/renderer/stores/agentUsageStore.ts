import { create } from 'zustand'
import type { AgentUsage, AgentUsageReport } from '../types'

interface AgentUsageState {
  /** local shell id → the latest usage of the agent running in it */
  byShell: ReadonlyMap<string, AgentUsage>
  apply: (report: AgentUsageReport) => void
  reset: (reports: readonly AgentUsageReport[]) => void
}

export const useAgentUsageStore = create<AgentUsageState>((set) => ({
  byShell: new Map(),
  apply: ({ shellId, usage }) => set((state) => {
    if (!shellId) return state
    const next = new Map(state.byShell)
    if (usage) next.set(shellId, usage)
    else next.delete(shellId)
    return { byShell: next }
  }),
  reset: (reports) => set({
    byShell: new Map(reports.flatMap(({ shellId, usage }) => (shellId && usage ? [[shellId, usage] as const] : [])))
  })
}))
