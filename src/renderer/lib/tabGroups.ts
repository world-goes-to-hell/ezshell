// Which work a tab belongs to, so the tab strip shows one work at a time
// (docs/plan/2026-11-19-tab-groups-by-project.md). Pure: the projects come from the sidebar's list
// (registered folders with their worktrees), the links from lib/localProjectServers.ts.
import type { TerminalInfo } from '../stores/terminalStore'
import { worktreeOf } from './localWorkspaceTree'
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
  if (info.db) return info.db.sshSessionId && info.db.sshSessionId !== id ? groupOfTab(info.db.sshSessionId, terminals, projects, servers, preferred) : GENERAL_GROUP
  if (info.local) {
    const cwd = info.local.cwd
    let best: { key: string; length: number } | null = null
    for (const project of projects) {
      const tree = worktreeOf(cwd, project.worktrees)
      if (tree && (!best || tree.length > best.length)) best = { key: project.key, length: tree.length }
    }
    return best?.key ?? GENERAL_GROUP
  }
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
    const group = groups.get(key) ?? { key, label: names.get(key) ?? GENERAL_LABEL, tabIds: [] }
    groups.set(key, { ...group, tabIds: [...group.tabIds, id] })
  }
  return [...groups.values()]
}

/** The next or previous tab within the tabs shown (Ctrl+Tab), wrapping around */
export function stepTab(shown: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (shown.length === 0) return null
  const index = current ? shown.indexOf(current) : -1
  if (index < 0) return shown[0]
  return shown[(index + step + shown.length) % shown.length]
}
