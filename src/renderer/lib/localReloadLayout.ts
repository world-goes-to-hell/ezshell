// The layout of local tabs across a window reload. The shells live in main and survive the reload, but
// which shell sits in which pane of which tab is window memory (lib/localPaneShells.ts and the split
// tree in the store): without it every shell came back as a tab of its own (reported 2026-11-20).
// The window writes the layout when its page goes away and reads it once when it takes the shells
// back (lib/localShellAdopt.ts). sessionStorage: it stays across reloads of this window only and is
// gone when the window closes; it holds shell ids, tab names and folders, no terminal content.

import type { TerminalInfo } from '../stores/terminalStore'
import { MAIN_PANE, closePane, paneIds, type PaneId, type SplitNode } from './splitTree'
import { LOCAL_RESTORE_MAX_PANES, readPaneSeq, readTree } from './restoreTabs'
import type { LiveLocalShell } from './localShellAdopt'

const STORAGE_KEY = 'ezshell.localReloadLayout'
const SHELL_ID = /^local:\d{1,9}$/

export interface ReloadTab {
  tabId: string
  /** The tab's own shell (a promoted pane's shell can have another id than the tab) */
  mainShellId: string
  title?: string
  shell: string
  cwd?: string
  workspaceLabel?: string
  splitTree?: SplitNode
  paneSeq?: number
  /** The shell of each pane other than the main one */
  panes: Record<string, string>
  /** Panes (the main one included) that showed their agent as a chat */
  chats?: string[]
}

/** The local tabs as they are now, with the shell of each pane and which panes are chats */
export function snapshotLocalTabs(
  terminals: ReadonlyMap<string, TerminalInfo>,
  paneShellOf: (tabId: string, pane: PaneId) => string | undefined,
  isChat: (shell: string) => boolean = () => false
): ReloadTab[] {
  const tabs: ReloadTab[] = []
  for (const [tabId, info] of terminals) {
    const local = info.local
    if (!local) continue
    const mainShellId = local.shellId ?? tabId
    const panes: Record<string, string> = {}
    const chats = isChat(mainShellId) ? [MAIN_PANE] : []
    const tree = info.splitTree?.kind === 'split' ? info.splitTree : undefined
    for (const pane of tree ? paneIds(tree) : []) {
      if (pane === MAIN_PANE) continue
      const id = paneShellOf(tabId, pane)
      if (!id) continue
      panes[pane] = id
      if (isChat(id)) chats.push(pane)
    }
    tabs.push({
      tabId, mainShellId, title: info.title, shell: local.shell,
      ...(local.cwd ? { cwd: local.cwd } : {}), ...(local.workspaceLabel ? { workspaceLabel: local.workspaceLabel } : {}),
      ...(tree ? { splitTree: tree, paneSeq: info.paneSeq } : {}),
      panes,
      ...(chats.length ? { chats } : {})
    })
  }
  return tabs
}

// eslint-disable-next-line no-control-regex
const line = (value: unknown, max: number): string | undefined => (typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value) ? value : undefined)

/** What was written, checked again: storage is not trusted to hold what this code wrote */
export function readReloadLayout(value: unknown): ReloadTab[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): ReloadTab[] => {
    const e = entry as Record<string, unknown> | null
    if (!e || typeof e !== 'object') return []
    if (typeof e.tabId !== 'string' || !SHELL_ID.test(e.tabId) || typeof e.mainShellId !== 'string' || !SHELL_ID.test(e.mainShellId)) return []
    const splitTree = readTree(e.splitTree, 'local')
    const paneNames = new Set(splitTree ? paneIds(splitTree) : [MAIN_PANE])
    const panes: Record<string, string> = {}
    if (e.panes && typeof e.panes === 'object') {
      const savedPanes = e.panes as Record<string, unknown>
      for (const pane of paneNames) {
        if (pane === MAIN_PANE) continue
        const id = savedPanes[pane]
        if (typeof id === 'string' && SHELL_ID.test(id)) panes[pane] = id
      }
    }
    const paneSeq = splitTree ? readPaneSeq(e.paneSeq) : undefined
    const title = line(e.title, 200)
    const cwd = line(e.cwd, 1024)
    const workspaceLabel = line(e.workspaceLabel, 200)
    const chats = Array.isArray(e.chats)
      ? [...new Set(e.chats.slice(0, LOCAL_RESTORE_MAX_PANES * 2).filter((pane): pane is string => typeof pane === 'string' && paneNames.has(pane)))]
      : []
    return [{
      tabId: e.tabId, mainShellId: e.mainShellId, shell: line(e.shell, 100) ?? 'PowerShell',
      ...(title ? { title } : {}), ...(cwd ? { cwd } : {}), ...(workspaceLabel ? { workspaceLabel } : {}),
      ...(splitTree ? { splitTree, ...(paneSeq !== undefined ? { paneSeq } : {}) } : {}),
      panes,
      ...(chats.length ? { chats } : {})
    }]
  })
}

/**
 * Which running shells go back into which tab and pane. A tab comes back only with its own shell; a
 * pane whose shell is gone (or was given to another pane) is closed up. Shells not placed in a tab
 * (`loose`) come back as tabs of their own, as before.
 */
export function planReloadedTabs(shells: readonly LiveLocalShell[], saved: readonly ReloadTab[]): { tabs: ReloadTab[]; loose: LiveLocalShell[] } {
  const alive = new Set(shells.filter(s => !s.exited).map(s => s.id))
  const claimed = new Set<string>()
  const claimedTabs = new Set<string>()
  const tabs: ReloadTab[] = []
  for (const tab of saved) {
    if (!alive.has(tab.mainShellId) || claimed.has(tab.mainShellId) || claimedTabs.has(tab.tabId)) continue
    claimed.add(tab.mainShellId)
    claimedTabs.add(tab.tabId)
    let tree = tab.splitTree
    const panes: Record<string, string> = {}
    for (const pane of tree ? paneIds(tree) : []) {
      if (pane === MAIN_PANE) continue
      const id = tab.panes[pane]
      if (id && alive.has(id) && !claimed.has(id)) {
        claimed.add(id)
        panes[pane] = id
      } else if (tree) {
        tree = closePane(tree, pane)
      }
    }
    const split = tree?.kind === 'split' ? tree : undefined
    const { splitTree: _tree, paneSeq, panes: _panes, chats: savedChats, ...rest } = tab
    // Chats only of panes that came back
    const chats = (savedChats ?? []).filter(pane => pane === MAIN_PANE || pane in panes)
    tabs.push({
      ...rest, ...(split ? { splitTree: split, ...(paneSeq !== undefined ? { paneSeq } : {}) } : {}), panes,
      ...(chats.length ? { chats } : {})
    })
  }
  return { tabs, loose: shells.filter(s => !s.exited && !claimed.has(s.id)) }
}

export function writeReloadLayout(tabs: readonly ReloadTab[]): void {
  try {
    if (tabs.length === 0) window.sessionStorage.removeItem(STORAGE_KEY)
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs))
  } catch { /* no storage: shells come back as tabs of their own */ }
}

/** Read once and removed */
export function takeReloadLayout(): ReloadTab[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    window.sessionStorage.removeItem(STORAGE_KEY)
    return raw ? readReloadLayout(JSON.parse(raw)) : []
  } catch {
    return []
  }
}
