import { create } from 'zustand'

export interface FileItem {
  name: string
  type: 'file' | 'directory'
  size: number
  modifyTime: number
  permissions?: string
}

export interface Transfer {
  id: string
  type: 'upload' | 'download'
  fileName: string
  localPath: string
  remotePath: string
  progress: number
  speed: number
  status: 'queued' | 'active' | 'paused' | 'completed' | 'error'
  error?: string
}

interface SessionSftpState {
  isOpen: boolean
  remotePath: string
  remoteFiles: FileItem[]
  selectedRemote: Set<string>
  localPath: string
  localFiles: FileItem[]
  selectedLocal: Set<string>
  transfers: Transfer[]
  panelHeight: number
}

const createDefaultSessionState = (): SessionSftpState => ({
  isOpen: false,
  remotePath: '/',
  remoteFiles: [],
  selectedRemote: new Set(),
  localPath: '',
  localFiles: [],
  selectedLocal: new Set(),
  transfers: [],
  panelHeight: 300
})

interface SftpState {
  // Per-session SFTP states
  sessions: Map<string, SessionSftpState>

  // Get or create session state
  getSessionState: (sessionId: string) => SessionSftpState

  // Actions (all now require sessionId)
  isOpen: (sessionId: string) => boolean
  setOpen: (sessionId: string, open: boolean) => void

  remotePath: (sessionId: string) => string
  remoteFiles: (sessionId: string) => FileItem[]
  selectedRemote: (sessionId: string) => Set<string>
  localPath: (sessionId: string) => string
  localFiles: (sessionId: string) => FileItem[]
  selectedLocal: (sessionId: string) => Set<string>
  transfers: (sessionId: string) => Transfer[]
  panelHeight: (sessionId: string) => number

  setRemotePath: (sessionId: string, path: string) => void
  setPanelHeight: (sessionId: string, height: number) => void
  setRemoteFiles: (sessionId: string, files: FileItem[]) => void
  setLocalPath: (sessionId: string, path: string) => void
  setLocalFiles: (sessionId: string, files: FileItem[]) => void
  toggleRemoteSelection: (sessionId: string, name: string) => void
  toggleLocalSelection: (sessionId: string, name: string) => void
  setRemoteSelection: (sessionId: string, name: string) => void
  setLocalSelection: (sessionId: string, name: string) => void
  clearRemoteSelection: (sessionId: string) => void
  clearLocalSelection: (sessionId: string) => void
  selectAllRemote: (sessionId: string) => void
  selectAllLocal: (sessionId: string) => void
  setRemoteMultiSelection: (sessionId: string, names: string[]) => void
  setLocalMultiSelection: (sessionId: string, names: string[]) => void
  setTransfers: (sessionId: string, transfers: Transfer[]) => void
  updateTransfer: (sessionId: string, id: string, updates: Partial<Transfer>) => void

  // Cleanup
  removeSession: (sessionId: string) => void
}

export const useSftpStore = create<SftpState>((set, get) => ({
  sessions: new Map(),

  getSessionState: (sessionId: string) => {
    const sessions = get().sessions
    if (!sessions.has(sessionId)) {
      // Return default state without setting - lazy initialization will happen on write
      return createDefaultSessionState()
    }
    return sessions.get(sessionId)!
  },

  isOpen: (sessionId: string) => {
    const sessions = get().sessions
    if (!sessions.has(sessionId)) {
      return false
    }
    return sessions.get(sessionId)!.isOpen
  },

  setOpen: (sessionId: string, open: boolean) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, isOpen: open })
    return { sessions }
  }),

  remotePath: (sessionId: string) => get().getSessionState(sessionId).remotePath,
  remoteFiles: (sessionId: string) => get().getSessionState(sessionId).remoteFiles,
  selectedRemote: (sessionId: string) => get().getSessionState(sessionId).selectedRemote,
  localPath: (sessionId: string) => get().getSessionState(sessionId).localPath,
  localFiles: (sessionId: string) => get().getSessionState(sessionId).localFiles,
  selectedLocal: (sessionId: string) => get().getSessionState(sessionId).selectedLocal,
  transfers: (sessionId: string) => get().getSessionState(sessionId).transfers,
  panelHeight: (sessionId: string) => get().getSessionState(sessionId).panelHeight,

  setRemotePath: (sessionId: string, path: string) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, remotePath: path, selectedRemote: new Set() })
    return { sessions }
  }),

  setRemoteFiles: (sessionId: string, files: FileItem[]) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, remoteFiles: files })
    return { sessions }
  }),

  setLocalPath: (sessionId: string, path: string) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, localPath: path, selectedLocal: new Set() })
    return { sessions }
  }),

  setLocalFiles: (sessionId: string, files: FileItem[]) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, localFiles: files })
    return { sessions }
  }),

  toggleRemoteSelection: (sessionId: string, name: string) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    const newSelected = new Set(sessionState.selectedRemote)
    if (newSelected.has(name)) {
      newSelected.delete(name)
    } else {
      newSelected.add(name)
    }
    sessions.set(sessionId, { ...sessionState, selectedRemote: newSelected })
    return { sessions }
  }),

  toggleLocalSelection: (sessionId: string, name: string) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    const newSelected = new Set(sessionState.selectedLocal)
    if (newSelected.has(name)) {
      newSelected.delete(name)
    } else {
      newSelected.add(name)
    }
    sessions.set(sessionId, { ...sessionState, selectedLocal: newSelected })
    return { sessions }
  }),

  setRemoteSelection: (sessionId: string, name: string) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, selectedRemote: new Set([name]) })
    return { sessions }
  }),

  setLocalSelection: (sessionId: string, name: string) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, selectedLocal: new Set([name]) })
    return { sessions }
  }),

  clearRemoteSelection: (sessionId: string) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, selectedRemote: new Set() })
    return { sessions }
  }),

  clearLocalSelection: (sessionId: string) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, selectedLocal: new Set() })
    return { sessions }
  }),

  selectAllRemote: (sessionId: string) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    const allNames = new Set(sessionState.remoteFiles.map(f => f.name))
    sessions.set(sessionId, { ...sessionState, selectedRemote: allNames })
    return { sessions }
  }),

  selectAllLocal: (sessionId: string) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    const allNames = new Set(sessionState.localFiles.map(f => f.name))
    sessions.set(sessionId, { ...sessionState, selectedLocal: allNames })
    return { sessions }
  }),

  setRemoteMultiSelection: (sessionId: string, names: string[]) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    const newSelected = new Set(sessionState.selectedRemote)
    names.forEach(n => newSelected.add(n))
    sessions.set(sessionId, { ...sessionState, selectedRemote: newSelected })
    return { sessions }
  }),

  setLocalMultiSelection: (sessionId: string, names: string[]) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    const newSelected = new Set(sessionState.selectedLocal)
    names.forEach(n => newSelected.add(n))
    sessions.set(sessionId, { ...sessionState, selectedLocal: newSelected })
    return { sessions }
  }),

  setTransfers: (sessionId: string, transfers: Transfer[]) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, transfers })
    return { sessions }
  }),

  updateTransfer: (sessionId: string, id: string, updates: Partial<Transfer>) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    const transfers = sessionState.transfers.map(t => t.id === id ? { ...t, ...updates } : t)
    sessions.set(sessionId, { ...sessionState, transfers })
    return { sessions }
  }),

  setPanelHeight: (sessionId: string, height: number) => set((state) => {
    const sessions = new Map(state.sessions)
    const sessionState = sessions.get(sessionId) || createDefaultSessionState()
    sessions.set(sessionId, { ...sessionState, panelHeight: height })
    return { sessions }
  }),

  removeSession: (sessionId: string) => set((state) => {
    const sessions = new Map(state.sessions)
    sessions.delete(sessionId)
    return { sessions }
  })
}))
