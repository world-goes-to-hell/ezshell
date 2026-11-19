import type { WorkspaceGitCommit } from '../types'

type Lane = { hash: string; color: number }
export type GitGraphEdge = { from: number; to: number; color: number; segment: 'incoming' | 'parent' | 'through' }
export type GitGraphRow = { commit: WorkspaceGitCommit; lane: number; color: number; edges: GitGraphEdge[] }

/** Lay out the pending parent commits in order, one row at a time (Git's topo-order). */
export function workspaceGitGraph(commits: readonly WorkspaceGitCommit[]) {
  let waiting: Lane[] = []
  let laneCount = 1
  let nextColor = 0
  const rows: GitGraphRow[] = commits.map(commit => {
    const incoming = waiting.findIndex(lane => lane.hash === commit.hash)
    const lane = incoming === -1 ? waiting.length : incoming
    const color = incoming === -1 ? nextColor++ : waiting[incoming].color
    const after = waiting.filter(entry => entry.hash !== commit.hash)
    const parents = [...new Set(commit.parents)]
    const newParents = parents.flatMap((hash, index) =>
      after.some(entry => entry.hash === hash) ? [] : [{ hash, color: index === 0 ? color : nextColor++ }]
    )
    after.splice(lane, 0, ...newParents)
    const edges: GitGraphEdge[] = waiting.map((entry, from) =>
      from === incoming
        ? { from, to: lane, color, segment: 'incoming' }
        : { from, to: after.indexOf(entry), color: entry.color, segment: 'through' }
    )
    for (const hash of parents) {
      const to = after.findIndex(entry => entry.hash === hash)
      edges.push({ from: lane, to, color: after[to].color, segment: 'parent' })
    }
    laneCount = Math.max(laneCount, lane + 1, after.length)
    waiting = after
    return { commit, lane, color, edges }
  })
  return { rows, laneCount }
}
