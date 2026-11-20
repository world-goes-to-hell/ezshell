// What each work's tab group remembers while another is in front (docs/plan/2026-11-19-tab-groups-by-project.md):
// its last front tab (the group chip goes back to it) and its screen split. Memory only.
import { create } from 'zustand'
import type { LayoutState } from './terminalStore'

/** A work's screen split while another work is in front: each screen's tabs and front tab, shares, focus */
export interface SavedSplit {
  direction: LayoutState['direction']
  panes: Array<{ terminalIds: string[]; activeTerminalId: string | null }>
  sizes: number[]
  focus: number
}

interface TabGroupState {
  /** The group in front the last time it was looked at */
  current: string | null
  lastTab: Record<string, string>
  lastLocalFolder: Record<string, string>
  splits: Record<string, SavedSplit>
  setCurrent: (group: string) => void
  remember: (group: string, tabId: string, localFolder?: string) => void
  saveSplit: (group: string, split: SavedSplit) => void
  takeSplit: (group: string) => SavedSplit | null
}

export const useTabGroupStore = create<TabGroupState>((set, get) => ({
  current: null,
  lastTab: {},
  lastLocalFolder: {},
  splits: {},
  setCurrent: (group) => set({ current: group }),
  remember: (group, tabId, localFolder) => {
    set(state => {
      if (state.lastTab[group] === tabId && (!localFolder || localFolder === state.lastLocalFolder[group])) return state
      return {
        lastTab: { ...state.lastTab, [group]: tabId },
        lastLocalFolder: localFolder ? { ...state.lastLocalFolder, [group]: localFolder } : state.lastLocalFolder
      }
    })
  },
  saveSplit: (group, split) => set(state => ({ splits: { ...state.splits, [group]: split } })),
  takeSplit: (group) => {
    const split = get().splits[group] ?? null
    if (split) set(state => {
      const { [group]: _taken, ...rest } = state.splits
      return { splits: rest }
    })
    return split
  }
}))
