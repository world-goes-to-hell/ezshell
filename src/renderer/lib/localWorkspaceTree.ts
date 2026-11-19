// Which worktree an open local terminal belongs to, for the sidebar's local tree. A terminal belongs
// to the worktree its shell started in (or below); with nested checkouts the deepest one wins.
// Terminals outside every registered worktree are listed on their own.

const isWindowsPath = (value: string) => /^[a-zA-Z]:[\\/]?/.test(value) || value.startsWith('\\\\')

/** A path for comparing: one kind of slash, no trailing slash, without case on Windows */
export function pathKey(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const kept = slashed === '' || /^[a-zA-Z]:$/.test(slashed) ? `${slashed}/` : slashed
  return isWindowsPath(value) ? kept.toLowerCase() : kept
}

/** `child` is `parent` itself or somewhere below it */
export function isInsidePath(child: string, parent: string): boolean {
  const c = pathKey(child)
  const p = pathKey(parent)
  if (c === p) return true
  return c.startsWith(p.endsWith('/') ? p : `${p}/`)
}

/** The deepest worktree holding `cwd`, or null */
export function worktreeOf(cwd: string | undefined, worktrees: readonly string[]): string | null {
  if (!cwd) return null
  let best: string | null = null
  for (const tree of worktrees) {
    if (isInsidePath(cwd, tree) && (!best || pathKey(tree).length > pathKey(best).length)) best = tree
  }
  return best
}

export interface TabPlace {
  id: string
  cwd?: string
}

export interface TabAssignment {
  /** Tab ids per worktree path (as given), in the order the tabs came */
  byWorktree: Map<string, string[]>
  /** Tabs in no registered worktree */
  others: string[]
}

export function assignTabs(tabs: readonly TabPlace[], worktrees: readonly string[]): TabAssignment {
  const byWorktree = new Map<string, string[]>()
  const others: string[] = []
  for (const tab of tabs) {
    const tree = worktreeOf(tab.cwd, worktrees)
    if (!tree) {
      others.push(tab.id)
      continue
    }
    byWorktree.set(tree, [...(byWorktree.get(tree) ?? []), tab.id])
  }
  return { byWorktree, others }
}

/** The last folder name of a path, for labels */
export function folderLabel(value: string): string {
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value
}
