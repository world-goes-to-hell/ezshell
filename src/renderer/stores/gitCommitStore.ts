// The commit being written in the workspace panel's "변경" tab, per repository top: the message and the
// ticked files. Memory only (kept while switching tabs, gone when the app quits or locks).
import { create } from 'zustand'
import type { ChangedFile } from '../lib/gitChangeTree'
import { nextSelection, type CommitSelection } from '../lib/gitCommitSelection'

export interface RepoCommitDraft extends CommitSelection {
  message: string
  /** The change list was read at least once (before that nothing is staged as far as we know) */
  seen: boolean
  /** A commit is running (kept across tab switches) */
  busy: boolean
  /** Why the last commit failed: Git's words, a hook's output too */
  error: string | null
}

const EMPTY: RepoCommitDraft = { message: '', selected: new Set(), staged: new Set(), seen: false, busy: false, error: null }

interface GitCommitStore {
  repos: Readonly<Record<string, RepoCommitDraft>>
  setMessage: (top: string, message: string) => void
  setSelected: (top: string, selected: ReadonlySet<string>) => void
  setCommitting: (top: string, busy: boolean, error?: string | null) => void
  /** A fresh read of the change list: drops paths gone, ticks files newly staged */
  applyStatus: (top: string, files: readonly ChangedFile[]) => void
  /** After a commit: the message goes, the files left in the list keep their boxes */
  committed: (top: string) => void
  clearAll: () => void
}

export const draftOf = (repos: Readonly<Record<string, RepoCommitDraft>>, top: string): RepoCommitDraft => repos[top] ?? EMPTY

export const useGitCommitStore = create<GitCommitStore>((set) => {
  const update = (top: string, change: (draft: RepoCommitDraft) => Partial<RepoCommitDraft>) =>
    set(state => {
      const draft = draftOf(state.repos, top)
      return { repos: { ...state.repos, [top]: { ...draft, ...change(draft) } } }
    })
  return {
    repos: {},
    setMessage: (top, message) => update(top, () => ({ message })),
    setSelected: (top, selected) => update(top, () => ({ selected })),
    setCommitting: (top, busy, error = null) => update(top, () => ({ busy, error })),
    applyStatus: (top, files) => update(top, draft => ({ ...nextSelection(draft.seen ? draft : null, files), seen: true })),
    committed: top => update(top, () => ({ message: '', busy: false, error: null })),
    clearAll: () => set({ repos: {} })
  }
})
