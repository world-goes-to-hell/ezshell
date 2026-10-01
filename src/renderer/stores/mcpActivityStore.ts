import { create } from 'zustand'
import type { McpActivityItem } from '../types'
import { mergeSnapshot, upsertActivity } from '../lib/mcpActivity'

interface McpActivityState {
  items: McpActivityItem[]
  isPanelOpen: boolean
  mergeSnapshot: (items: McpActivityItem[], liveIds: ReadonlySet<string>) => void
  upsert: (item: McpActivityItem) => void
  setPanelOpen: (open: boolean) => void
}

export const useMcpActivityStore = create<McpActivityState>((set) => ({
  items: [],
  isPanelOpen: false,
  mergeSnapshot: (items, liveIds) => set((state) => ({ items: mergeSnapshot(state.items, items, liveIds) })),
  upsert: (item) => set((state) => ({ items: upsertActivity(state.items, item) })),
  setPanelOpen: (open) => set({ isPanelOpen: open })
}))
