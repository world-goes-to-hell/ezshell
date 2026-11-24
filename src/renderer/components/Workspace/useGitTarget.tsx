// Which repository the workspace panel's Git tabs ("변경", "Git 기록") show: the terminal's checkout by
// default, or another worktree / nested repository picked in the header (and, for the history,
// all branches together).
import { useEffect, useState, type ReactNode } from 'react'
import { RiFolderLine } from 'react-icons/ri'
import { create } from 'zustand'
import type { WorkspaceGitRepository } from '../../types'
import { folderName } from '../../lib/agentHistory'
import { isInsidePath, pathKey, worktreeOf } from '../../lib/localWorkspaceTree'
import { SelectMenu } from '../ui/SelectMenu'

const readGit = (folder: string) => window.electronAPI.workspaceGitLog(folder)
const readAllGit = (folder: string) => window.electronAPI.workspaceGitLog(folder, true)
const ALL_BRANCHES = 'all-branches'

type TargetChoice = { origin: string; value: string } | null

/**
 * The repository picked in the header, shared by both tabs: a worktree picked in the history is the one
 * the changes tab shows too. "전체 브랜치" means the terminal's checkout in the changes tab.
 */
const useTargetChoice = create<{ choice: TargetChoice; setChoice: (next: TargetChoice | ((previous: TargetChoice) => TargetChoice)) => void }>(set => ({
  choice: null,
  setChoice: next => set(state => ({ choice: typeof next === 'function' ? next(state.choice) : next }))
}))

type GitLogAnswer = Awaited<ReturnType<typeof readGit>>

function useFolderData<T>(folder: string | null, load: (folder: string) => Promise<T>, revision: number) {
  const [sample, setSample] = useState<{ folder: string; revision: number; load: typeof load; data: T | null } | null>(null)
  useEffect(() => {
    if (folder === null) return
    let active = true
    void Promise.resolve().then(() => load(folder)).then(
      data => { if (active) setSample({ folder, revision, load, data }) },
      () => { if (active) setSample({ folder, revision, load, data: null }) }
    )
    return () => { active = false }
  }, [folder, load, revision])
  const latest = sample?.folder === folder && sample.load === load ? sample : null
  return {
    result: latest?.revision === revision ? latest : null,
    latest: latest?.data
  }
}

export interface GitTarget {
  /** Changes on refresh (and after a commit): everything shown is read again */
  revision: number
  refresh: () => void
  /** null while reading */
  result: { data: GitLogAnswer | null } | null
  repo: WorkspaceGitRepository | null
  displayPath: string
  displayBranch?: string
  /** The repository picker for the header, when there is more than one to pick */
  picker?: ReactNode
}

export function useGitTarget(folder: string, { offerAllBranches: allowAll }: { offerAllBranches: boolean }): GitTarget {
  // Keep the repository list when moving among its checkouts and nested repositories. A manual
  // choice belongs to the checkout where it was made and clears when the terminal changes checkout.
  const [anchor, setAnchor] = useState(folder)
  const [revision, setRevision] = useState(0)
  const selection = useTargetChoice(state => state.choice)
  const setSelection = useTargetChoice(state => state.setChoice)
  const terminal = useFolderData(anchor, readGit, revision)
  const current = terminal.latest?.success ? terminal.latest.repo : null
  const worktrees = current?.worktrees ?? []
  const base = worktrees[0]?.path ?? anchor
  const named = (path: string) => pathKey(path) !== pathKey(base) && isInsidePath(path, base)
    ? path.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') : folderName(path)
  const choices = [
    ...worktrees.map(tree => ({ ...tree, label: named(tree.path), kind: '워크트리' })),
    ...(current?.nestedRepositories ?? []).map(path => ({ path, branch: undefined, label: named(path), kind: '하위 저장소' }))
  ]
  const closest = worktreeOf(folder, choices.map(tree => tree.path))
  const defaultPath = closest ?? current?.root ?? anchor
  useEffect(() => {
    if (!closest && pathKey(folder) !== pathKey(anchor)) setAnchor(folder)
    // Until the repository is read, the default is only the terminal's folder: keep a choice made in
    // the other tab instead of dropping it
    if (!current) return
    setSelection(previous => previous?.origin === defaultPath ? previous : null)
  }, [folder, anchor, closest, defaultPath, current, setSelection])

  const choice = selection?.origin === defaultPath ? selection.value : null
  const offerAllBranches = allowAll && worktrees.length > 1 && worktrees.some(tree => tree.path === defaultPath)
  const allBranches = offerAllBranches && choice === ALL_BRANCHES
  const chosen = choices.find(tree => tree.path === choice)
  const displayPath = chosen?.path ?? defaultPath
  const otherFolder = allBranches || pathKey(displayPath) !== pathKey(current?.root ?? anchor) ? displayPath : null
  const alternate = useFolderData(otherFolder, allBranches ? readAllGit : readGit, revision)
  const result = otherFolder ? alternate.result : terminal.result
  const data = result?.data
  const repo = data?.success ? data.repo : null
  const targetBranch = choices.find(tree => tree.path === displayPath)?.branch
  const displayBranch = repo ? repo.branch ?? (repo.head ? '분리된 HEAD' : undefined)
    : targetBranch === null ? '분리된 HEAD' : targetBranch ?? undefined
  const picker = choices.length > 1 ? (
    <div className="workspace-git-picker" title={displayPath}>
      <SelectMenu size="compact" ariaLabel="Git 저장소 대상" icon={<RiFolderLine size={15} aria-hidden="true" />}
        value={allBranches ? ALL_BRANCHES : displayPath} onChange={value => setSelection({ origin: defaultPath, value })}
        options={[...choices.map(tree => {
          const duplicate = choices.some(other => tree !== other && tree.label === other.label)
          return { value: tree.path, label: duplicate ? `${tree.label} · ${tree.kind}` : tree.label }
        }), ...(offerAllBranches ? [{ value: ALL_BRANCHES, label: '전체 브랜치' }] : [])]} />
    </div>
  ) : undefined
  return { revision, refresh: () => setRevision(value => value + 1), result, repo, displayPath, displayBranch, picker }
}
