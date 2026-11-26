import { create } from 'zustand'

export type ProjectSearchMode = 'file' | 'content'

/** 프로젝트 검색 (components/ProjectSearch): open in a mode, with text to start from */
interface ProjectSearchState {
  open: { mode: ProjectSearchMode; query: string; at: number } | null
  show: (mode: ProjectSearchMode, query?: string) => void
  close: () => void
}

export const useProjectSearchStore = create<ProjectSearchState>(set => ({
  open: null,
  show: (mode, query = '') => set(state => ({ open: { mode, query: query || state.open?.query || '', at: Date.now() } })),
  close: () => set({ open: null })
}))
