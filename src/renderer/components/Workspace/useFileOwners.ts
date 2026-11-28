// The agents that changed the uncommitted files of a repository, and its freeze (docs/plan/2026-11-28-agent-file-owners.md):
// read from main when the list is read, and again when main says they changed. Empty until main offers them (an app
// started before the feature, or a preload without it).
import { useEffect, useState } from 'react'
import type { WorkspaceFileOwner, WorkspaceFreeze } from '../../types'
import { pathKey } from '../../lib/localWorkspaceTree'

export interface RepoOwners {
  owners: readonly WorkspaceFileOwner[]
  freeze: WorkspaceFreeze | null
  /** Read again now (after freezing or thawing, before main's notice comes) */
  reload: () => void
}

const NONE: readonly WorkspaceFileOwner[] = []

export function useFileOwners(top: string | null, revision: number): RepoOwners {
  const [state, setState] = useState<{ top: string; owners: readonly WorkspaceFileOwner[]; freeze: WorkspaceFreeze | null } | null>(null)
  const [nudge, setNudge] = useState(0)
  useEffect(() => {
    const read = window.electronAPI.workspaceFileOwners
    if (!top || typeof read !== 'function') return
    let alive = true
    let sequence = 0
    const load = () => {
      const mine = ++sequence
      read(top).then(answer => {
        // A later read may have answered first; a failed read keeps what was shown
        if (alive && mine === sequence && answer?.success) setState({ top, owners: answer.owners, freeze: answer.freeze ?? null })
      }).catch(() => {})
    }
    load()
    // The notice names the repository top: the same folder as `top`, maybe written another way
    const key = pathKey(top)
    const off = window.electronAPI.onWorkspaceFileOwnersChanged?.(event => {
      if (typeof event?.root === 'string' && pathKey(event.root) === key) load()
    })
    return () => { alive = false; off?.() }
  }, [top, revision, nudge])
  const mine = state && top && state.top === top ? state : null
  return { owners: mine?.owners ?? NONE, freeze: mine?.freeze ?? null, reload: () => setNudge(value => value + 1) }
}
