import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ConnectionRecord {
  id: string
  sessionId: string
  sessionName: string
  host: string
  username: string
  connectedAt: string // ISO timestamp
}

interface HistoryState {
  recentConnections: ConnectionRecord[]
  maxHistory: number
  addConnection: (record: Omit<ConnectionRecord, 'id' | 'connectedAt'>) => void
  removeConnection: (id: string) => void
  clearHistory: () => void
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      recentConnections: [],
      maxHistory: 10,

      addConnection: (record) => {
        const newRecord: ConnectionRecord = {
          ...record,
          id: crypto.randomUUID(),
          connectedAt: new Date().toISOString()
        }
        set(state => ({
          recentConnections: [
            newRecord,
            ...state.recentConnections.filter(r => r.sessionId !== record.sessionId)
          ].slice(0, state.maxHistory)
        }))
      },

      removeConnection: (id) => {
        set(state => ({
          recentConnections: state.recentConnections.filter(r => r.id !== id)
        }))
      },

      clearHistory: () => set({ recentConnections: [] })
    }),
    { name: 'ssh-connection-history' }
  )
)
