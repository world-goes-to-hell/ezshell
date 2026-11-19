// The uncommitted changes as a folder tree (like an editor's source control view): folders first,
// then files, each folder with the number of changed files under it and the lines added / removed.
import type { WorkspaceGitFile, WorkspaceGitFileKind } from '../types'

export interface ChangedFile extends WorkspaceGitFile {
  /** Lines added / removed; null for a binary file or when not counted */
  added: number | null
  removed: number | null
  /** Also staged (in the index) */
  staged: boolean
}

export interface ChangeFolder {
  kind: 'folder'
  /** Path from the repository top, with forward slashes */
  path: string
  name: string
  children: ChangeNode[]
  /** Changed files anywhere below */
  count: number
}

export interface ChangeLeaf {
  kind: 'file'
  path: string
  name: string
  file: ChangedFile
}

export type ChangeNode = ChangeFolder | ChangeLeaf

/** One entry per path; when a path is both staged and changed, the work tree's kind wins */
const PRIORITY: Record<WorkspaceGitFileKind, number> = { conflict: 6, deleted: 5, renamed: 4, copied: 3, added: 2, modified: 1, untracked: 0 }

export function mergeChanges(
  staged: readonly WorkspaceGitFile[], changed: readonly WorkspaceGitFile[], untracked: readonly WorkspaceGitFile[],
  stats: Readonly<Record<string, readonly [number | null, number | null]>> = {}
): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>()
  const stagedPaths = new Set(staged.map(file => file.path))
  for (const file of [...staged, ...changed, ...untracked]) {
    const known = byPath.get(file.path)
    if (known && PRIORITY[known.kind] >= PRIORITY[file.kind]) continue
    const [added, removed] = stats[file.path] ?? [null, null]
    byPath.set(file.path, { ...file, ...(known?.from && !file.from ? { from: known.from } : {}), added, removed, staged: stagedPaths.has(file.path) })
  }
  return [...byPath.values()]
}

/** Folders → files, sorted by name (folders first); a folder counts the files below it */
export function buildChangeTree(files: readonly ChangedFile[]): ChangeNode[] {
  const root: ChangeFolder = { kind: 'folder', path: '', name: '', children: [], count: 0 }
  for (const file of files) {
    const parts = file.path.split('/')
    let folder = root
    folder.count++
    for (let index = 0; index < parts.length - 1; index++) {
      const path = parts.slice(0, index + 1).join('/')
      let next = folder.children.find((child): child is ChangeFolder => child.kind === 'folder' && child.path === path)
      if (!next) {
        next = { kind: 'folder', path, name: parts[index], children: [], count: 0 }
        folder.children.push(next)
      }
      next.count++
      folder = next
    }
    folder.children.push({ kind: 'file', path: file.path, name: parts[parts.length - 1], file })
  }
  const sort = (nodes: ChangeNode[]): ChangeNode[] => nodes
    .map(node => (node.kind === 'folder' ? { ...node, children: sort(node.children) } : node))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1))
  return sort(root.children)
}

/** Lines added and removed over all files (binary files count as 0) */
export function totalLines(files: readonly ChangedFile[]): { added: number; removed: number } {
  return files.reduce((sum, file) => ({ added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0) }), { added: 0, removed: 0 })
}

/** 18966 → "18,966" */
export const formatCount = (value: number): string => value.toLocaleString('en-US')
