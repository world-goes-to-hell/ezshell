// Which uncommitted files are ticked for the next commit in the workspace panel's "변경" tab
// (docs/plan/2026-11-24-workspace-git-commit.md). Paths are relative to the repository top.
import type { ChangedFile, ChangeNode } from './gitChangeTree'

export type CheckState = 'all' | 'some' | 'none'

/** The selection of one repository, with the files that were staged at the last read */
export interface CommitSelection {
  selected: ReadonlySet<string>
  staged: ReadonlySet<string>
}

/** A conflict cannot be committed before it is resolved; "sub/" is another repository inside this one */
export const isSelectable = (file: ChangedFile): boolean => file.kind !== 'conflict' && !file.path.endsWith('/')

/** The files that can be ticked under a node (or a list of nodes) */
export function selectablePaths(nodes: ChangeNode | readonly ChangeNode[]): string[] {
  const list = Array.isArray(nodes) ? nodes : [nodes as ChangeNode]
  return list.flatMap(node => node.kind === 'file'
    ? (isSelectable(node.file) ? [node.path] : [])
    : selectablePaths(node.children))
}

export function checkState(paths: readonly string[], selected: ReadonlySet<string>): CheckState {
  const ticked = paths.filter(path => selected.has(path)).length
  return ticked === 0 ? 'none' : ticked === paths.length ? 'all' : 'some'
}

/** A folder's (or the whole list's) box: ticks them all unless all are ticked already, then unticks them */
export function togglePaths(selected: ReadonlySet<string>, paths: readonly string[]): ReadonlySet<string> {
  if (checkState(paths, selected) === 'all') {
    const leaving = new Set(paths)
    return new Set([...selected].filter(path => !leaving.has(path)))
  }
  return new Set([...selected, ...paths])
}

export function toggleOne(selected: ReadonlySet<string>, path: string): ReadonlySet<string> {
  return selected.has(path) ? new Set([...selected].filter(item => item !== path)) : new Set([...selected, path])
}

/**
 * After the change list is read again: paths that left the list (or became conflicts) leave the
 * selection, and a file that became staged since the last read is ticked (all staged files on the
 * first read). A staged file the user unticked stays unticked.
 */
export function nextSelection(previous: CommitSelection | null, files: readonly ChangedFile[]): CommitSelection {
  const selectable = new Set(files.filter(isSelectable).map(file => file.path))
  const staged = new Set(files.filter(file => file.staged).map(file => file.path))
  const before = previous?.staged ?? new Set<string>()
  const kept = [...(previous?.selected ?? [])].filter(path => selectable.has(path))
  const newlyStaged = [...staged].filter(path => !before.has(path) && selectable.has(path))
  return { selected: new Set([...kept, ...newlyStaged]), staged }
}
