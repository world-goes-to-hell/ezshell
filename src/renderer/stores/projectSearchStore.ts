import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { withSearch, withoutSearch } from '../lib/projectSearchHistory'

export type ProjectSearchMode = 'file' | 'content'

/** 프로젝트 검색 (components/ProjectSearch): open in a mode, with text to start from */
interface ProjectSearchState {
  open: { mode: ProjectSearchMode; query: string; regex: boolean; at: number } | null
  /** The text in the search box, kept after it closes: opening again shows the same search (2026-11-26 user request) */
  lastQuery: string
  lastRegex: boolean
  /** The searches whose result was opened, newest first (stored) */
  history: Record<ProjectSearchMode, string[]>
  regexHistory: Record<ProjectSearchMode, string[]>
  show: (mode: ProjectSearchMode, query?: string) => void
  close: () => void
  keep: (query: string, regex?: boolean) => void
  record: (mode: ProjectSearchMode, text: string, regex?: boolean) => void
  forget: (mode: ProjectSearchMode, text: string, regex?: boolean) => void
}

const validList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').reduceRight<string[]>((list, entry) => withSearch(list, entry), []) : []

const validHistory = (value?: Partial<Record<ProjectSearchMode, unknown>>) => ({ file: validList(value?.file), content: validList(value?.content) })

export const useProjectSearchStore = create<ProjectSearchState>()(
  persist(
    set => ({
      open: null,
      lastQuery: '',
      lastRegex: false,
      history: { file: [], content: [] },
      regexHistory: { file: [], content: [] },
      show: (mode, query = '') => set(state => ({ open: { mode, query: query || state.lastQuery, regex: !query && state.lastRegex, at: Date.now() } })),
      close: () => set({ open: null }),
      keep: (query, regex = false) => set({ lastQuery: query, lastRegex: regex }),
      record: (mode, text, regex = false) => set(state => {
        const list = regex ? 'regexHistory' : 'history'
        return { [list]: { ...state[list], [mode]: withSearch(state[list][mode], text) } }
      }),
      forget: (mode, text, regex = false) => set(state => {
        const list = regex ? 'regexHistory' : 'history'
        return { [list]: { ...state[list], [mode]: withoutSearch(state[list][mode], text) } }
      })
    }),
    {
      name: 'ezshell.projectSearch',
      partialize: ({ history, regexHistory }) => ({ history, ...(regexHistory.file.length || regexHistory.content.length ? { regexHistory } : {}) }),
      // A stored value from an older or edited file: only lists of single-line text are taken
      merge: (stored, current) => {
        const lists = stored as Partial<Record<'history' | 'regexHistory', Partial<Record<ProjectSearchMode, unknown>>>> | undefined
        return { ...current, history: validHistory(lists?.history), regexHistory: validHistory(lists?.regexHistory) }
      }
    }
  )
)
