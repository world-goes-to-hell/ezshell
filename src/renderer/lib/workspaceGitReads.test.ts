import { describe, expect, it, vi } from 'vitest'
import { createReadCache, gitLogKey, gitStatusKey } from './gitReadCache'
import { prefetchWorkspaceGit, type GitReadApi } from './workspaceGitReads'

const repo = { root: 'D:/work/app', head: 'abc', branch: 'main', worktrees: [], nestedRepositories: [], allBranches: false, commits: [], hasMore: false }

function fakeApi(log: Awaited<ReturnType<GitReadApi['workspaceGitLog']>>): GitReadApi & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    workspaceGitLog: vi.fn(async (folder: string) => { calls.push(`log ${folder}`); return log }),
    workspaceGitStatus: vi.fn(async (root: string) => { calls.push(`status ${root}`); return { success: true as const, repo: null } })
  }
}

describe('prefetchWorkspaceGit', () => {
  it('reads the history of the folder, then the changes of its repository, and keeps both', async () => {
    const cache = createReadCache()
    const from = fakeApi({ success: true, repo })
    await prefetchWorkspaceGit('D:/work/app/src', { cache, from })
    expect(from.calls).toEqual(['log D:/work/app/src', 'status D:/work/app'])
    expect(cache.peek(gitLogKey('D:/work/app/src', false))).toEqual({ success: true, repo })
    expect(cache.peek(gitStatusKey('D:/work/app'))).toEqual({ success: true, repo: null })
  })

  it('reads nothing already kept', async () => {
    const cache = createReadCache()
    const from = fakeApi({ success: true, repo })
    await prefetchWorkspaceGit('D:/work/app', { cache, from })
    await prefetchWorkspaceGit('D:/work/app', { cache, from })
    expect(from.calls).toEqual(['log D:/work/app', 'status D:/work/app'])
  })

  it('stops at a folder outside a repository or a failed read, and keeps no failure', async () => {
    const cache = createReadCache()
    const notRepo = fakeApi({ success: true, repo: null, reason: 'not-repo' })
    await prefetchWorkspaceGit('D:/notes', { cache, from: notRepo })
    expect(notRepo.calls).toEqual(['log D:/notes'])

    const failing = fakeApi({ success: false, error: 'boom' })
    await prefetchWorkspaceGit('D:/broken', { cache, from: failing })
    expect(failing.calls).toEqual(['log D:/broken'])
    expect(cache.peek(gitLogKey('D:/broken', false))).toBeUndefined()
  })

  it('turns a thrown read into no answer instead of an error', async () => {
    const cache = createReadCache()
    const from: GitReadApi = { workspaceGitLog: () => Promise.reject(new Error('gone')) }
    await expect(prefetchWorkspaceGit('D:/work/app', { cache, from })).resolves.toBeUndefined()
  })
})
