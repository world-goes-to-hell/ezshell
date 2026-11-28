// The tab strip shows one work at a time (docs/plan/2026-11-19-tab-groups-by-project.md). The group in
// front is the group of the tab in front, so opening a tab or going to one from the sidebar switches it.
// When the group changes, its screen split is put away for later and the new group's is brought back.
import { useEffect, useMemo, useRef } from 'react'
import { useTerminalStore, type LayoutState } from '../stores/terminalStore'
import { useTabGroupStore, type SavedSplit } from '../stores/tabGroupStore'
import { useLocalProjects } from './useLocalProjects'
import { buildProjectNodes, type ProjectNode, type WorktreeNode } from '../components/Sidebar/LocalProjectsTree'
import { projectKeyOf } from '../lib/localProjectServers'
import { groupOfTab, groupTabs, localFolderForGroup, projectOfFolder, type GroupProject, type TabGroup } from '../lib/tabGroups'
import { pathKey, worktreeOf } from '../lib/localWorkspaceTree'
import { lastViewedTab } from '../lib/tabRecency'

export interface TabGroupView {
  groups: TabGroup[]
  projects: readonly GroupProject[]
  projectNodes: readonly ProjectNode[]
  activeGroup: string | null
  /** The tabs of the group in front, in strip order */
  shownIds: string[]
  localFolder: (tabId: string | null) => string | undefined
  worktreeForFolder: (cwd: string) => WorktreeNode | undefined
  /** The group's last front tab, or its first */
  openGroup: (key: string) => void
}

const splitOf = (layout: LayoutState): SavedSplit | null =>
  layout.mode === 'split' && layout.panes.length > 1
    ? { direction: layout.direction, panes: layout.panes.map(pane => ({ ...pane })), sizes: [...layout.sizes], focus: layout.activePane ?? 0 }
    : null

export function useTabGroups(unlocked: boolean): TabGroupView {
  const { projects } = useLocalProjects(unlocked)
  const terminals = useTerminalStore(state => state.terminals)
  const activeId = useTerminalStore(state => state.activeTerminalId)

  const projectNodes = useMemo(() => buildProjectNodes(projects), [projects])
  const groupProjects: GroupProject[] = useMemo(() => projectNodes.map(node => ({
    key: projectKeyOf(node), name: node.name, worktrees: node.worktrees.map(tree => tree.path)
  })), [projectNodes])
  const worktrees = useMemo(() => new Map(projectNodes.flatMap(node => node.worktrees.map(tree => [pathKey(tree.path), tree] as const))), [projectNodes])
  const groups = useMemo(() => groupTabs([...terminals.keys()], terminals, groupProjects), [terminals, groupProjects])
  const activeGroup = activeId && terminals.has(activeId) ? groupOfTab(activeId, terminals, groupProjects) : groups[0]?.key ?? null
  const shownIds = useMemo(() => groups.find(group => group.key === activeGroup)?.tabIds ?? [...terminals.keys()], [groups, activeGroup, terminals])

  // The tab in front before this render, to tell a closed tab from a switch
  const previousFront = useRef<string | null>(null)
  useEffect(() => {
    if (!activeGroup) return
    const store = useTabGroupStore.getState()
    const terminalState = useTerminalStore.getState()
    const before = store.current
    const front = terminalState.activeTerminalId

    // Closing a tab handed the front to another work: stay in the closed tab's work while it has tabs
    const closed = previousFront.current && !terminalState.terminals.has(previousFront.current)
    previousFront.current = front
    if (closed && before && before !== activeGroup) {
      const stay = groups.find(group => group.key === before)
      if (stay && stay.tabIds.length > 0) {
        // The tab of that work seen most recently (lib/tabRecency.ts), as in one strip
        const last = store.lastTab[before]
        terminalState.setActiveTerminal(lastViewedTab(stay.tabIds) ?? (last && stay.tabIds.includes(last) ? last : stay.tabIds[stay.tabIds.length - 1]))
        return
      }
    }
    if (front) store.remember(activeGroup, front, terminalState.terminals.get(front)?.local?.cwd)
    if (before === activeGroup) return

    // Switching: the old group's split is put away (with the tabs it had), the new group's comes back
    const leaving = before ? splitOf(terminalState.layout) : null
    if (before && leaving) {
      store.saveSplit(before, leaving)
      terminalState.closeSplit()
      if (front) useTerminalStore.getState().setActiveTerminal(front)
    }
    store.setCurrent(activeGroup)
    const saved = store.takeSplit(activeGroup)
    const mine = new Set(groups.find(group => group.key === activeGroup)?.tabIds ?? [])
    // Only this work's tabs, in the screens they had; every other tab goes into the first screen
    const panes = saved?.panes.map(pane => ({ ...pane, terminalIds: pane.terminalIds.filter(id => mine.has(id)) })) ?? []
    if (saved && panes.filter(pane => pane.terminalIds.length > 0).length > 1) {
      const placed = new Set(panes.flatMap(pane => pane.terminalIds))
      const others = [...useTerminalStore.getState().terminals.keys()].filter(id => !placed.has(id))
      const all = [{ ...panes[0], terminalIds: [...panes[0].terminalIds, ...others] }, ...panes.slice(1)]
      useTerminalStore.getState().setLayout({ mode: 'split', direction: saved.direction, panes: all, sizes: saved.sizes, activePane: saved.focus })
      const restored = useTerminalStore.getState()
      // A jump to a specific tab (for example from the work overview) takes precedence over the saved screen focus.
      if (front && mine.has(front) && terminalState.focusRequest?.sessionId === front) {
        restored.focusTerminal(front)
      } else {
        const savedFront = restored.layout.panes[restored.layout.activePane ?? 0]?.activeTerminalId
        if (savedFront) restored.setActiveTerminal(savedFront)
      }
    }
  }, [activeGroup, activeId, groups])

  const openGroup = (key: string) => {
    const group = groups.find(item => item.key === key)
    if (!group || group.tabIds.length === 0) return
    const store = useTabGroupStore.getState()
    const terminalState = useTerminalStore.getState()
    const last = store.lastTab[key]
    if (activeGroup && key !== activeGroup) {
      // Focusing another work's tab first would change the active tab and focus of the split we save.
      const leaving = splitOf(terminalState.layout)
      if (leaving) {
        store.saveSplit(activeGroup, leaving)
        terminalState.closeSplit()
      }
    }
    terminalState.focusTerminal(last && group.tabIds.includes(last) ? last : group.tabIds[0])
  }

  const localFolder = (tabId: string | null) => localFolderForGroup(
    activeGroup, groupProjects, tabId ? terminals.get(tabId)?.local?.cwd : undefined,
    activeGroup ? useTabGroupStore.getState().lastLocalFolder[activeGroup] : undefined,
    [...shownIds].reverse().map(id => terminals.get(id)?.local?.cwd)
  )
  const worktreeForFolder = (cwd: string) => {
    const project = projectOfFolder(cwd, groupProjects)
    const tree = project && worktreeOf(cwd, project.worktrees)
    return tree ? worktrees.get(pathKey(tree)) : undefined
  }

  return { groups, projects: groupProjects, projectNodes, activeGroup, shownIds, openGroup, localFolder, worktreeForFolder }
}
