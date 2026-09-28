import { create } from 'zustand'

export interface Session {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  folderId?: string
  icon?: string
  connectTimeout?: number
  keepaliveInterval?: number
  autoReconnect?: boolean
  tags?: string[]
  backgroundColor?: string
  postConnectScript?: string
  // Jump Host 설정
  useJumpHost?: boolean
  jumpHost?: string
  jumpPort?: number
  jumpUsername?: string
  jumpAuthType?: 'password' | 'privateKey'
  jumpPassword?: string
  jumpPrivateKeyPath?: string
  jumpPassphrase?: string
}

export interface Folder {
  id: string
  name: string
  parentId?: string  // For nested folders
  backgroundColor?: string
}

export interface Tag {
  id: string
  name: string
  color: string  // hex color
}

interface SessionState {
  sessions: Session[]
  folders: Folder[]
  expandedFolders: Set<string>
  activeSessionId: string | null
  isLoading: boolean
  isEncrypted: boolean
  availableTags: Tag[]
  activeTagFilter: string | null

  setSessions: (sessions: Session[]) => void
  setFolders: (folders: Folder[]) => void
  toggleFolder: (folderId: string) => void
  setActiveSession: (sessionId: string | null) => void
  setLoading: (loading: boolean) => void
  setEncrypted: (encrypted: boolean) => void

  addSession: (session: Session) => void
  removeSession: (sessionId: string) => void
  updateSession: (sessionId: string, updates: Partial<Session>) => void

  addFolder: (folder: Folder) => void
  updateFolder: (folderId: string, updates: Partial<Folder>) => void
  removeFolder: (folderId: string) => void
  moveSessionToFolder: (sessionId: string, folderId: string | undefined) => void

  addTag: (tag: Tag) => void
  removeTag: (tagId: string) => void
  filterByTag: (tagId: string | null) => void

  loadFromBackend: () => Promise<void>
  saveToBackend: () => Promise<void>
}

// Default tags
const DEFAULT_TAGS: Tag[] = [
  { id: 'production', name: 'Production', color: '#ef4444' },
  { id: 'development', name: 'Development', color: '#22c55e' },
  { id: 'database', name: 'Database', color: '#3b82f6' },
  { id: 'web', name: 'Web', color: '#a855f7' }
]

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  folders: [],
  expandedFolders: new Set(),
  activeSessionId: null,
  isLoading: false,
  isEncrypted: false,
  availableTags: DEFAULT_TAGS,
  activeTagFilter: null,

  setSessions: (sessions) => set({ sessions }),
  setFolders: (folders) => set({ folders }),

  toggleFolder: (folderId) => {
    set((state) => {
      const newExpanded = new Set(state.expandedFolders)
      if (newExpanded.has(folderId)) {
        newExpanded.delete(folderId)
      } else {
        newExpanded.add(folderId)
      }
      return { expandedFolders: newExpanded }
    })
    // Folders are stored as plain JSON (no encryption), so persisting on every toggle is cheap
    const { folders, expandedFolders } = get()
    window.electronAPI.saveFolders({ folders, expandedFolders: Array.from(expandedFolders) })
      .catch((error: unknown) => console.error('Failed to save folder state:', error))
  },

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),
  setLoading: (loading) => set({ isLoading: loading }),
  setEncrypted: (encrypted) => set({ isEncrypted: encrypted }),

  addSession: (session) => set((state) => ({
    sessions: [...state.sessions, session]
  })),

  removeSession: (sessionId) => set((state) => ({
    sessions: state.sessions.filter(s => s.id !== sessionId)
  })),

  updateSession: (sessionId, updates) => set((state) => ({
    sessions: state.sessions.map(s =>
      s.id === sessionId ? { ...s, ...updates } : s
    )
  })),

  addFolder: (folder) => set((state) => ({
    folders: [...state.folders, folder]
  })),

  updateFolder: (folderId, updates) => set((state) => ({
    folders: state.folders.map(f =>
      f.id === folderId ? { ...f, ...updates } : f
    )
  })),

  removeFolder: (folderId) => set((state) => {
    // Get all descendant folder IDs recursively
    const getDescendantIds = (parentId: string): string[] => {
      const children = state.folders.filter(f => f.parentId === parentId)
      return children.flatMap(child => [child.id, ...getDescendantIds(child.id)])
    }
    const allFolderIds = [folderId, ...getDescendantIds(folderId)]

    return {
      folders: state.folders.filter(f => !allFolderIds.includes(f.id)),
      sessions: state.sessions.map(s =>
        allFolderIds.includes(s.folderId || '') ? { ...s, folderId: undefined } : s
      )
    }
  }),

  moveSessionToFolder: (sessionId, folderId) => set((state) => ({
    sessions: state.sessions.map(s =>
      s.id === sessionId ? { ...s, folderId } : s
    )
  })),

  addTag: (tag) => set((state) => ({
    availableTags: [...state.availableTags, tag]
  })),

  removeTag: (tagId) => set((state) => ({
    availableTags: state.availableTags.filter(t => t.id !== tagId),
    sessions: state.sessions.map(s => ({
      ...s,
      tags: s.tags?.filter(t => t !== tagId)
    })),
    activeTagFilter: state.activeTagFilter === tagId ? null : state.activeTagFilter
  })),

  filterByTag: (tagId) => set({ activeTagFilter: tagId }),

  loadFromBackend: async () => {
    set({ isLoading: true })
    try {
      const [sessionsResult, foldersResult] = await Promise.all([
        window.electronAPI.loadSessions(),
        window.electronAPI.loadFolders()
      ])

      if (sessionsResult.success) {
        // Ensure all sessions have an id (for legacy data)
        const sessionsWithIds = (sessionsResult.sessions || []).map((s: any) => ({
          ...s,
          id: s.id || crypto.randomUUID()
        }))
        set({
          sessions: sessionsWithIds,
          isEncrypted: sessionsResult.encrypted || false
        })
        // Save back if any sessions were missing ids
        if (sessionsWithIds.some((s: Session, i: number) => s.id !== sessionsResult.sessions?.[i]?.id)) {
          get().saveToBackend()
        }
      } else if (sessionsResult.needsPassword) {
        set({ isEncrypted: true, sessions: [] })
      }

      if (foldersResult) {
        set({
          folders: foldersResult.folders || [],
          expandedFolders: new Set<string>(foldersResult.expandedFolders || [])
        })
      }
    } catch (error) {
      console.error('Failed to load sessions:', error)
    } finally {
      set({ isLoading: false })
    }
  },

  saveToBackend: async () => {
    const { sessions, folders, expandedFolders } = get()
    try {
      await Promise.all([
        window.electronAPI.saveSessions(sessions),
        window.electronAPI.saveFolders({ folders, expandedFolders: Array.from(expandedFolders) })
      ])
    } catch (error) {
      console.error('Failed to save sessions:', error)
    }
  }
}))
