// The workspace panel's Git reads, shared by the tabs and by the read ahead that runs while the panel is
// open: the "변경" tab needs the history first (to know the repository) and then the changes, two Git
// commands one after the other, so opening it the first time waited for both.
import type { WorkspaceGitRepository, WorkspaceGitStatus } from '../types'
import { gitLogKey, gitReads, gitStatusKey, succeeded, type ReadCache } from './gitReadCache'

export type GitLogAnswer =
  | { success: true; repo: WorkspaceGitRepository }
  | { success: true; repo: null; reason: 'git-missing' | 'not-repo' }
  | { success: false; error: string }
export type GitStatusAnswer = { success: true; repo: WorkspaceGitStatus | null } | { success: false; error: string }

export interface GitReadApi {
  workspaceGitLog: (folder: string, allBranches?: boolean) => Promise<GitLogAnswer>
  workspaceGitStatus?: (root: string) => Promise<GitStatusAnswer>
}

const api = (): GitReadApi => window.electronAPI

/** A folder's history (null when the read itself failed) */
export const loadGitLog = (folder: string, allBranches: boolean, from: GitReadApi = api()): Promise<GitLogAnswer | null> =>
  from.workspaceGitLog(folder, allBranches).catch(() => null)

/** A repository's changes not committed yet */
export const loadGitStatus = (root: string, from: GitReadApi = api()): Promise<GitStatusAnswer> =>
  (from.workspaceGitStatus as NonNullable<GitReadApi['workspaceGitStatus']>)(root)
    .catch(() => ({ success: false as const, error: '커밋하지 않은 변경을 읽지 못했습니다.' }))

/**
 * Reads ahead what the "변경" and "Git 기록" tabs show first for `folder` (the terminal's checkout), so
 * opening them shows it at once. Only what is not kept yet: a tab reads again when it opens anyway.
 */
export async function prefetchWorkspaceGit(folder: string, { cache = gitReads, from = api() }: { cache?: ReadCache; from?: GitReadApi } = {}): Promise<void> {
  const logKey = gitLogKey(folder, false)
  const log = cache.peek<GitLogAnswer | null>(logKey) ?? await cache.read(logKey, () => loadGitLog(folder, false, from), succeeded)
  if (!log?.success || !log.repo || !from.workspaceGitStatus) return
  const root = log.repo.root
  const statusKey = gitStatusKey(root)
  if (cache.peek(statusKey) !== undefined) return
  await cache.read(statusKey, () => loadGitStatus(root, from), succeeded)
}
