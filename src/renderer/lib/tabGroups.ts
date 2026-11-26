// Which work a tab belongs to, so the tab strip shows one work at a time
// (docs/plan/2026-11-19-tab-groups-by-project.md). Pure: the projects come from the sidebar's list
// (registered folders with their worktrees); an SSH tab keeps the work it was opened from.
import type { TerminalInfo } from '../stores/terminalStore'
import { folderLabel, pathKey, worktreeOf } from './localWorkspaceTree'

/** Tabs that belong to no project */
export const GENERAL_GROUP = 'general'
export const GENERAL_LABEL = '일반'

export interface GroupProject {
  /** projectKeyOf of the project */
  key: string
  name: string
  /** Every checkout of the project (worktrees, or the one folder) */
  worktrees: readonly string[]
}

export interface TabGroup {
  key: string
  label: string
  tabIds: string[]
}

/**
 * A local tab in a folder no registered project covers is a work of its own (its folder), not one of
 * the general tabs with the SSH sessions: they showed in one strip (reported 2026-11-20). A shell
 * opened without a folder stays in general.
 */
export const FOLDER_GROUP_PREFIX = 'folder:'
const folderGroupOf = (cwd: string | undefined): string => (cwd ? FOLDER_GROUP_PREFIX + pathKey(cwd) : GENERAL_GROUP)
const folderGroupLabel = (key: string): string => folderLabel(key.slice(FOLDER_GROUP_PREFIX.length))
const isWorkGroup = (key: string | null | undefined, projects: readonly GroupProject[]): key is string =>
  Boolean(key && (key === GENERAL_GROUP || key.startsWith(FOLDER_GROUP_PREFIX) || projects.some(project => project.key === key)))

export function projectOfFolder(cwd: string | undefined, projects: readonly GroupProject[]): GroupProject | undefined {
  let best: { project: GroupProject; length: number } | undefined
  for (const project of projects) {
    const tree = worktreeOf(cwd, project.worktrees)
    if (tree && (!best || tree.length > best.length)) best = { project, length: tree.length }
  }
  return best?.project
}

const localGroupOf = (cwd: string | undefined, projects: readonly GroupProject[]) =>
  projectOfFolder(cwd, projects)?.key ?? folderGroupOf(cwd)

/** Launch the + menu's shell in the front tab's folder, or the work's last local folder. */
export function localFolderForGroup(
  group: string | null,
  projects: readonly GroupProject[],
  activeFolder: string | undefined,
  rememberedFolder: string | undefined,
  otherFolders: readonly (string | undefined)[]
): string | undefined {
  if (!group || group === GENERAL_GROUP) return undefined
  const folder = [activeFolder, rememberedFolder, ...otherFolders].find(cwd => cwd && localGroupOf(cwd, projects) === group)
  if (folder) return folder
  const project = projects.find(item => item.key === group)
  if (project) return project.worktrees.find(tree => pathKey(tree) === group) ?? project.worktrees[0]
  return group.startsWith(FOLDER_GROUP_PREFIX) ? group.slice(FOLDER_GROUP_PREFIX.length) : undefined
}

/**
 * The + menu's local terminal choices (2026-11-26 user request: in the mbris-new work, with the backend tab in
 * front, the shell opened in backend and there was no way to open one in mbris-new). `root`: the worktree
 * holding the folder (or the folder); `here`: the folder itself, only when it is a folder below that root.
 */
export function localTerminalChoices(folder: string | undefined, worktree: string | undefined): { root?: string; here?: string } {
  if (!folder) return {}
  const root = worktree ?? folder
  const inside = pathKey(folder) !== pathKey(root) && pathKey(folder).startsWith(`${pathKey(root).replace(/\/$/, '')}/`)
  return inside ? { root, here: folder } : { root }
}

/**
 * The group of one tab. An SSH tab belongs to a work only when it was opened from that work (its
 * `workGroup`: the work's 서버 row or + menu, kept when tabs are restored). A session opened from the
 * session list is a general tab even when it is linked to a project (2026-11-20 user decision: it went
 * into the project's tabs because of the link).
 */
export function groupOfTab(
  id: string,
  terminals: ReadonlyMap<string, TerminalInfo>,
  projects: readonly GroupProject[]
): string {
  const info = terminals.get(id)
  if (!info) return GENERAL_GROUP
  if (info.browser) {
    const group = info.browser.group
    return isWorkGroup(group, projects) ? group : GENERAL_GROUP
  }
  if (info.db) return info.db.sshSessionId && info.db.sshSessionId !== id ? groupOfTab(info.db.sshSessionId, terminals, projects) : GENERAL_GROUP
  if (info.local) return localGroupOf(info.local.cwd, projects)
  const workGroup = info.connectConfig?.workGroup
  return isWorkGroup(workGroup, projects) ? workGroup : GENERAL_GROUP
}

/** The groups that have tabs, in the order their first tab came; each with its tabs in strip order */
export function groupTabs(
  tabIds: readonly string[],
  terminals: ReadonlyMap<string, TerminalInfo>,
  projects: readonly GroupProject[],
): TabGroup[] {
  const groups = new Map<string, TabGroup>()
  const names = new Map(projects.map(project => [project.key, project.name]))
  for (const id of tabIds) {
    const key = groupOfTab(id, terminals, projects)
    const label = names.get(key) ?? (key.startsWith(FOLDER_GROUP_PREFIX) ? folderGroupLabel(key) : GENERAL_LABEL)
    const group = groups.get(key) ?? { key, label, tabIds: [] }
    groups.set(key, { ...group, tabIds: [...group.tabIds, id] })
  }
  // A folder group is named after its folder as a local tab has it (the key is lowercased on Windows)
  return [...groups.values()].map(group => {
    if (!group.key.startsWith(FOLDER_GROUP_PREFIX)) return group
    const cwd = group.tabIds.map(id => terminals.get(id)?.local?.cwd).find(Boolean)
    return cwd ? { ...group, label: folderLabel(cwd) } : group
  })
}

/**
 * The worktree each browser, SSH and DB tab of a project's work is listed under in the sidebar's local
 * tree (the local terminals go by their own folder: localWorkspaceTree.assignTabs). A browser tab goes
 * under the folder it was opened from; a tab without one under the project's main checkout.
 * Tabs of no project (general, an unregistered folder) are not listed. Ids keep the order given.
 */
export function workTabsByWorktree(
  tabIds: readonly string[],
  terminals: ReadonlyMap<string, TerminalInfo>,
  projects: readonly GroupProject[]
): Map<string, string[]> {
  const byWorktree = new Map<string, string[]>()
  for (const id of tabIds) {
    const info = terminals.get(id)
    if (!info || info.local) continue
    const group = groupOfTab(id, terminals, projects)
    const project = projects.find(item => item.key === group)
    if (!project) continue
    const tree = worktreeOf(info.browser?.cwd, project.worktrees)
      ?? project.worktrees.find(path => pathKey(path) === project.key) ?? project.worktrees[0]
    if (!tree) continue
    byWorktree.set(tree, [...(byWorktree.get(tree) ?? []), id])
  }
  return byWorktree
}

/** The next or previous tab within the tabs shown (Ctrl+Tab), wrapping around */
export function stepTab(shown: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (shown.length === 0) return null
  const index = current ? shown.indexOf(current) : -1
  if (index < 0) return shown[0]
  return shown[(index + step + shown.length) % shown.length]
}
