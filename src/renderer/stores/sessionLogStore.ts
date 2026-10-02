import { create } from 'zustand'

interface SessionLogState {
  /** Tab id → file its output is being written to */
  files: Record<string, string>
  setLogging: (sessionId: string, filePath: string) => void
  clearLogging: (sessionId: string) => void
  /**
   * Take the main process's list as the truth, except for tabs that changed during this subscription:
   * a change event is newer than a list that was requested before it.
   */
  mergeSnapshot: (items: Array<{ sessionId: string; filePath: string }>, changedIds: ReadonlySet<string>) => void
}

export const useSessionLogStore = create<SessionLogState>((set) => ({
  files: {},
  setLogging: (sessionId, filePath) => set((state) => ({ files: { ...state.files, [sessionId]: filePath } })),
  clearLogging: (sessionId) => set((state) => {
    if (!(sessionId in state.files)) return state
    const { [sessionId]: removed, ...rest } = state.files
    return { files: rest }
  }),
  mergeSnapshot: (items, changedIds) => set((state) => ({
    files: {
      ...Object.fromEntries(items.filter(item => !changedIds.has(item.sessionId)).map(item => [item.sessionId, item.filePath])),
      ...Object.fromEntries(Object.entries(state.files).filter(([sessionId]) => changedIds.has(sessionId)))
    }
  }))
}))
