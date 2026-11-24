import { create } from 'zustand'
import { WORKSPACE_PANEL_KEY, parseWorkspacePrefs, type WorkspacePanelPrefs, type WorkspaceSection } from '../lib/workspacePanel'

/** A folder a chat link asked the files tree to show (`shellId`: the chat's shell, whose folder is the root) */
export interface WorkspaceReveal {
  shellId: string
  folder: string
  seq: number
  at: number
  /** When the folder cannot be shown in the tree (outside the panel's folder): the file manager */
  fallback: () => void
}

interface WorkspacePanelState extends WorkspacePanelPrefs {
  section: WorkspaceSection
  reveal: WorkspaceReveal | null
  revealFolder: (request: Omit<WorkspaceReveal, 'seq' | 'at'>) => void
  /** Clears the request, only if it is still that one */
  finishReveal: (seq: number) => void
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
  reveal: null,
  revealFolder: (request) => {
    set({ isOpen: true, section: 'files', reveal: { ...request, seq: (get().reveal?.seq ?? 0) + 1, at: Date.now() } })
    save({ isOpen: true, width: get().width })
  },
  finishReveal: (seq) => {
    if (get().reveal?.seq === seq) set({ reveal: null })
  },
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
