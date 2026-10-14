import { create } from 'zustand'
import type { McpActivityItem, McpOutputPart } from '../types'
import { ACTIVITY_PREFS_KEY, DEFAULT_ACTIVITY_PREFS, appendOutputParts, mergeSnapshot, parseActivityPrefs, upsertActivity } from '../lib/mcpActivity'
import type { McpActivityPrefs, McpActivityView } from '../lib/mcpActivity'

export type { McpActivityView }

interface McpActivityState {
  items: McpActivityItem[]
  isPanelOpen: boolean
  view: McpActivityView
  /** Per-server view: show only the sessions with something waiting or running */
  isActiveOnly: boolean
  mergeSnapshot: (items: McpActivityItem[], liveIds: ReadonlySet<string>) => void
  upsert: (item: McpActivityItem) => void
  appendOutput: (id: string, parts: McpOutputPart[]) => void
  /** Forget every request and its output */
  clear: () => void
  setPanelOpen: (open: boolean) => void
  setView: (view: McpActivityView) => void
  setActiveOnly: (isActiveOnly: boolean) => void
}

// Only the view and the filter are stored, never the requests or their output.
// Storage can be unavailable; the panel then works with the defaults and forgets them on restart.
function loadPrefs(): McpActivityPrefs {
  try {
    return parseActivityPrefs(localStorage.getItem(ACTIVITY_PREFS_KEY))
  } catch {
    return DEFAULT_ACTIVITY_PREFS
  }
}

function savePrefs(prefs: McpActivityPrefs): void {
  try {
    localStorage.setItem(ACTIVITY_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // not remembered this time; the choice still applies until the app closes
  }
}

const initialPrefs = loadPrefs()

export const useMcpActivityStore = create<McpActivityState>((set, get) => ({
  items: [],
  isPanelOpen: false,
  view: initialPrefs.view,
  isActiveOnly: initialPrefs.isActiveOnly,
  mergeSnapshot: (items, liveIds) => set((state) => ({ items: mergeSnapshot(state.items, items, liveIds) })),
  upsert: (item) => set((state) => ({ items: upsertActivity(state.items, item) })),
  appendOutput: (id, parts) => set((state) => ({ items: appendOutputParts(state.items, id, parts) })),
  clear: () => set({ items: [] }),
  setPanelOpen: (open) => set({ isPanelOpen: open }),
  setView: (view) => {
    set({ view })
    savePrefs({ view, isActiveOnly: get().isActiveOnly })
  },
  setActiveOnly: (isActiveOnly) => {
    set({ isActiveOnly })
    savePrefs({ view: get().view, isActiveOnly })
  }
}))
