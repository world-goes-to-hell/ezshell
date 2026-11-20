// Which work a tab belongs to, so the tab strip shows one work at a time
// (docs/plan/2026-11-19-tab-groups-by-project.md). Pure: the projects come from the sidebar's list
// (registered folders with their worktrees), the links from lib/localProjectServers.ts.
import type { TerminalInfo } from '../stores/terminalStore'
import { folderLabel, pathKey, worktreeOf } from './localWorkspaceTree'
import type { ProjectServers } from './localProjectServers'

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

/** The group of one tab. `preferred`: the group in front, chosen when a session is linked to several projects */
export function groupOfTab(
  id: string,
  terminals: ReadonlyMap<string, TerminalInfo>,
  projects: readonly GroupProject[],
  servers: ProjectServers,
  preferred: string | null = null
): string {
  const info = terminals.get(id)
  if (!info) return GENERAL_GROUP
  if (info.browser) {
    const group = info.browser.group
    return group && (group.startsWith(FOLDER_GROUP_PREFIX) || projects.some(project => project.key === group)) ? group : GENERAL_GROUP
  }
  if (info.db) return info.db.sshSessionId && info.db.sshSessionId !== id ? groupOfTab(info.db.sshSessionId, terminals, projects, servers, preferred) : GENERAL_GROUP
  if (info.local) return localGroupOf(info.local.cwd, projects)
  const saved = info.connectConfig?.savedSessionId
  if (!saved) return GENERAL_GROUP
  const known = new Set(projects.map(project => project.key))
  const linked = Object.keys(servers).filter(key => known.has(key) && servers[key].includes(saved))
  if (linked.length === 0) return GENERAL_GROUP
  return preferred && linked.includes(preferred) ? preferred : linked[0]
}

/** The groups that have tabs, in the order their first tab came; each with its tabs in strip order */
export function groupTabs(
  tabIds: readonly string[],
  terminals: ReadonlyMap<string, TerminalInfo>,
  projects: readonly GroupProject[],
  servers: ProjectServers,
  preferred: string | null = null
): TabGroup[] {
  const groups = new Map<string, TabGroup>()
  const names = new Map(projects.map(project => [project.key, project.name]))
  for (const id of tabIds) {
    const key = groupOfTab(id, terminals, projects, servers, preferred)
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

/** The next or previous tab within the tabs shown (Ctrl+Tab), wrapping around */
export function stepTab(shown: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (shown.length === 0) return null
  const index = current ? shown.indexOf(current) : -1
  if (index < 0) return shown[0]
  return shown[(index + step + shown.length) % shown.length]
}
