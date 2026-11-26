import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { withSearch, withoutSearch } from '../lib/projectSearchHistory'

export type ProjectSearchMode = 'file' | 'content'

/** 프로젝트 검색 (components/ProjectSearch): open in a mode, with text to start from */
interface ProjectSearchState {
  open: { mode: ProjectSearchMode; query: string; at: number } | null
  /** The text in the search box, kept after it closes: opening again shows the same search (2026-11-26 user request) */
  lastQuery: string
  /** The searches whose result was opened, newest first (stored) */
  history: Record<ProjectSearchMode, string[]>
  show: (mode: ProjectSearchMode, query?: string) => void
  close: () => void
  keep: (query: string) => void
  record: (mode: ProjectSearchMode, text: string) => void
  forget: (mode: ProjectSearchMode, text: string) => void
}

const validList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').reduceRight<string[]>((list, entry) => withSearch(list, entry), []) : []

export const useProjectSearchStore = create<ProjectSearchState>()(
  persist(
    set => ({
      open: null,
      lastQuery: '',
      history: { file: [], content: [] },
      show: (mode, query = '') => set(state => ({ open: { mode, query: query || state.lastQuery, at: Date.now() } })),
      close: () => set({ open: null }),
      keep: query => set({ lastQuery: query }),
      record: (mode, text) => set(state => ({ history: { ...state.history, [mode]: withSearch(state.history[mode], text) } })),
      forget: (mode, text) => set(state => ({ history: { ...state.history, [mode]: withoutSearch(state.history[mode], text) } }))
    }),
    {
      name: 'ezshell.projectSearch',
      partialize: ({ history }) => ({ history }),
      // A stored value from an older or edited file: only lists of single-line text are taken
      merge: (stored, current) => {
        const history = (stored as { history?: Partial<Record<ProjectSearchMode, unknown>> } | undefined)?.history
        return { ...current, history: { file: validList(history?.file), content: validList(history?.content) } }
      }
    }
  )
)
