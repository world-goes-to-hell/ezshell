// The work folders registered for local work: the "로컬 작업" dialog adds and removes them, and the
// sidebar's local tree shows them. Kept in localStorage (the app's data folder, so it outlives a
// restart); both places read it here and hear changes through one window event.

export const LOCAL_PROJECTS_KEY = 'ezshell.localProjects'
export const LOCAL_PROJECTS_EVENT = 'ezshell:local-projects-changed'
/**
 * Opens a local terminal tab with an agent ({ cwd?, agent?, workspaceLabel? }): the screen tests start
 * their fake agents this way, since the 로컬 작업 dialog opens the user's shell only. It asks nothing of
 * main that the page could not ask through `localShellOpen` already.
 */
export const OPEN_LOCAL_TERMINAL_EVENT = 'ezshell:open-local-terminal'
/** Folded projects and worktrees of the sidebar tree */
export const LOCAL_TREE_FOLDED_KEY = 'ezshell.localTreeFolded'

const MAX_ENTRIES = 200
const MAX_PATH_LENGTH = 4096

function readStrings(key: string): string[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(data)) return []
    const usable = data.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= MAX_PATH_LENGTH)
    return [...new Set(usable)].slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

function writeStrings(key: string, values: readonly string[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify([...new Set(values)].slice(0, MAX_ENTRIES)))
    return true
  } catch {
    return false
  }
}

export function readLocalProjects(): string[] {
  return readStrings(LOCAL_PROJECTS_KEY)
}

/** Saves the list and tells the other readers; false when it could not be stored */
export function writeLocalProjects(folders: readonly string[]): boolean {
  const saved = writeStrings(LOCAL_PROJECTS_KEY, folders)
  if (saved) window.dispatchEvent(new Event(LOCAL_PROJECTS_EVENT))
  return saved
}

export function readFoldedNodes(): Set<string> {
  return new Set(readStrings(LOCAL_TREE_FOLDED_KEY))
}

export function writeFoldedNodes(keys: ReadonlySet<string>): void {
  writeStrings(LOCAL_TREE_FOLDED_KEY, [...keys])
}
