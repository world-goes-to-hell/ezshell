import { create } from 'zustand'
import { WORKSPACE_PANEL_KEY, parseWorkspacePrefs, type WorkspacePanelPrefs, type WorkspaceSection } from '../lib/workspacePanel'

interface WorkspacePanelState extends WorkspacePanelPrefs {
  section: WorkspaceSection
  toggle: () => void
  open: (section?: WorkspaceSection) => void
  close: () => void
  /** `persist`: false while the edge is being dragged, true when it is let go */
  setWidth: (width: number, persist: boolean) => void
  setSection: (section: WorkspaceSection) => void
}

function load(): WorkspacePanelPrefs {
  try {
    return parseWorkspacePrefs(localStorage.getItem(WORKSPACE_PANEL_KEY))
  } catch {
    return parseWorkspacePrefs(null)
  }
}

function save(prefs: WorkspacePanelPrefs) {
  try {
    localStorage.setItem(WORKSPACE_PANEL_KEY, JSON.stringify(prefs))
  } catch {
    // Not remembered this time; the panel still works
  }
}

export const useWorkspacePanelStore = create<WorkspacePanelState>((set, get) => ({
  ...load(),
  section: 'history',
  toggle: () => {
    const isOpen = !get().isOpen
    set({ isOpen })
    save({ isOpen, width: get().width })
  },
  open: (section) => {
    set({ isOpen: true, ...(section ? { section } : {}) })
    save({ isOpen: true, width: get().width })
  },
  close: () => {
    set({ isOpen: false })
    save({ isOpen: false, width: get().width })
  },
  setWidth: (width, persist) => {
    set({ width })
    if (persist) save({ isOpen: get().isOpen, width })
  },
  setSection: (section) => set({ section })
}))
