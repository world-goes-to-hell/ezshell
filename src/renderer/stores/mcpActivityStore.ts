import { create } from 'zustand'
import type { McpActivityItem, McpOutputPart } from '../types'
import { ACTIVITY_PREFS_KEY, DEFAULT_ACTIVITY_PREFS, appendOutputParts, hideLane, mergeSnapshot, parseActivityPrefs, upsertActivity } from '../lib/mcpActivity'
import type { McpActivityLane, McpActivityPrefs, McpActivityView, McpHiddenLanes } from '../lib/mcpActivity'

export type { McpActivityView }

interface McpActivityState {
  items: McpActivityItem[]
  isPanelOpen: boolean
  /** Slid to the right edge after a press on the app behind it (memory only) */
  isPanelCollapsed: boolean
  view: McpActivityView
  /** Per-server view: show only the sessions with something waiting or running */
  isActiveOnly: boolean
  /** Per-server view: lanes the user closed (memory only, like the requests) */
  hiddenLanes: McpHiddenLanes
  /** Per-server view: session ids in the order the user dragged the lanes to (memory only) */
  laneOrder: string[]
  mergeSnapshot: (items: McpActivityItem[], liveIds: ReadonlySet<string>) => void
  upsert: (item: McpActivityItem) => void
  appendOutput: (id: string, parts: McpOutputPart[]) => void
  /** Forget every request and its output */
  clear: () => void
  /** Opening always shows the whole panel */
  setPanelOpen: (open: boolean) => void
  setPanelCollapsed: (isCollapsed: boolean) => void
  /** Status bar button: open a closed panel, expand a collapsed one, close an expanded one */
  togglePanel: () => void
  setView: (view: McpActivityView) => void
  setActiveOnly: (isActiveOnly: boolean) => void
  /** Close a lane in the per-server view until its session gets a new request */
  hideLane: (lane: McpActivityLane) => void
  showAllLanes: () => void
  setLaneOrder: (order: string[]) => void
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
  isPanelCollapsed: false,
  view: initialPrefs.view,
  isActiveOnly: initialPrefs.isActiveOnly,
  hiddenLanes: {},
  laneOrder: [],
  mergeSnapshot: (items, liveIds) => set((state) => ({ items: mergeSnapshot(state.items, items, liveIds) })),
  upsert: (item) => set((state) => ({ items: upsertActivity(state.items, item) })),
  appendOutput: (id, parts) => set((state) => ({ items: appendOutputParts(state.items, id, parts) })),
  clear: () => set({ items: [], hiddenLanes: {}, laneOrder: [] }),
  setPanelOpen: (open) => set({ isPanelOpen: open, isPanelCollapsed: false }),
  setPanelCollapsed: (isCollapsed) => set((state) => ({ isPanelCollapsed: state.isPanelOpen && isCollapsed })),
  togglePanel: () => set((state) => {
    if (!state.isPanelOpen) return { isPanelOpen: true, isPanelCollapsed: false }
    if (state.isPanelCollapsed) return { isPanelCollapsed: false }
    return { isPanelOpen: false, isPanelCollapsed: false }
  }),
  setView: (view) => {
    set({ view })
    savePrefs({ view, isActiveOnly: get().isActiveOnly })
  },
  setActiveOnly: (isActiveOnly) => {
    set({ isActiveOnly })
    savePrefs({ view: get().view, isActiveOnly })
  },
  hideLane: (lane) => set((state) => ({ hiddenLanes: hideLane(state.hiddenLanes, lane) })),
  showAllLanes: () => set({ hiddenLanes: {} }),
  setLaneOrder: (order) => set({ laneOrder: order })
}))
