import { create } from 'zustand'
import type { McpActivityItem, McpOutputPart } from '../types'
import { appendOutputParts, mergeSnapshot, upsertActivity } from '../lib/mcpActivity'

/** How the activity panel shows requests: a list to expand, or one continuous terminal-like log */
export type McpActivityView = 'list' | 'terminal'

interface McpActivityState {
  items: McpActivityItem[]
  isPanelOpen: boolean
  view: McpActivityView
  mergeSnapshot: (items: McpActivityItem[], liveIds: ReadonlySet<string>) => void
  upsert: (item: McpActivityItem) => void
  appendOutput: (id: string, parts: McpOutputPart[]) => void
  /** Forget every request and its output */
  clear: () => void
  setPanelOpen: (open: boolean) => void
  setView: (view: McpActivityView) => void
}

export const useMcpActivityStore = create<McpActivityState>((set) => ({
  items: [],
  isPanelOpen: false,
  view: 'terminal',
  mergeSnapshot: (items, liveIds) => set((state) => ({ items: mergeSnapshot(state.items, items, liveIds) })),
  upsert: (item) => set((state) => ({ items: upsertActivity(state.items, item) })),
  appendOutput: (id, parts) => set((state) => ({ items: appendOutputParts(state.items, id, parts) })),
  clear: () => set({ items: [] }),
  setPanelOpen: (open) => set({ isPanelOpen: open }),
  setView: (view) => set({ view })
}))
