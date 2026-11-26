import type { AgentChatProvider, LocalDevelopmentRun } from '../types'
import { useTerminalStore } from '../stores/terminalStore'
import { folderName } from './agentHistory'
import { adoptLocalPaneShell, getLocalPaneShellId } from './localPaneShells'
import { planReloadedTabs, readReloadLayout, snapshotLocalTabs, takeReloadLayout, writeReloadLayout } from './localReloadLayout'
import { queueChatView } from './pendingChatViews'
import { isChatShown } from '../stores/agentChatStore'
import type { PaneId } from './splitTree'

// Local shells live in main and outlive their tabs (so a tab can be drawn again without losing the
// shell). When the window itself reloads, every tab is gone but the shells keep running: unseen,
// and an agent in one still answers messages. The window takes them back as tabs.

export interface LiveLocalShell {
  id: string
  name: string
  exited: boolean
  cwd: string | null
  agent: AgentChatProvider | null
  development?: LocalDevelopmentRun
}


/** Only a window without any local tab reloaded; one with tabs owns its shells already */
export function planAdoption(shells: readonly LiveLocalShell[], hasLocalTabs: boolean): { adopt: LiveLocalShell[]; close: string[] } {
  if (hasLocalTabs) return { adopt: [], close: [] }
  return {
    adopt: shells.filter(shell => !shell.exited || shell.development),
    // An ended shell had a tab showing "종료됨": nothing to give back, just let it go
    close: shells.filter(shell => shell.exited && !shell.development).map(shell => shell.id)
  }
}

export function adoptedTitle(shell: LiveLocalShell, index: number): string {
  if (shell.development) return shell.development.label
  const folder = folderName(shell.cwd)
  if (folder) return folder
  return index === 0 ? shell.name : `${shell.name} (${index + 1})`
}

// Shells the session host kept while the app restarted for an update (main took them back at start):
// their tabs come back here, so the restore notice does not open them a second time
const keptAfterUpdate = new Set<string>()
export const keptLocalShells = (): ReadonlySet<string> => keptAfterUpdate

/**
 * Called once after the first unlock; how many tabs came back, and whether they are shells that went on
 * through an update (the layout then comes from the session host, written before the restart)
 */
export async function adoptOrphanLocalShells(): Promise<{ count: number; afterUpdate: boolean }> {
  let shells: LiveLocalShell[]
  try {
    shells = (await window.electronAPI.localShellList?.()) ?? []
  } catch {
    return { count: 0, afterUpdate: false }
  }
  const store = useTerminalStore.getState()
  const hasLocalTabs = Array.from(store.terminals.values()).some(info => info.local)
  // Read (and removed) even when nothing is adopted: it belongs to the page that just went away
  let saved = takeReloadLayout()
  const keptLayout = await window.electronAPI.localShellKeptLayout?.().catch(() => null)
  const afterUpdate = Array.isArray(keptLayout)
  if (saved.length === 0 && afterUpdate) saved = readReloadLayout(keptLayout)
  const { adopt, close } = planAdoption(shells, hasLocalTabs)
  for (const id of close) window.electronAPI.localShellClose?.(id)
  // Tabs as they were before the reload, each pane on its own shell again
  const { tabs, loose } = planReloadedTabs(adopt, saved)
  for (const tab of tabs) {
    // Before the tab is drawn: its panes attach to these shells instead of opening new ones
    for (const [pane, shellId] of Object.entries(tab.panes)) adoptLocalPaneShell(tab.tabId, pane, shellId)
    store.addTerminal(tab.tabId, {
      id: tab.tabId, host: '이 PC', username: '', connected: true,
      title: tab.title ?? tab.shell,
      local: {
        shell: tab.shell, ...(tab.mainShellId !== tab.tabId ? { shellId: tab.mainShellId } : {}),
        ...(tab.cwd ? { cwd: tab.cwd } : {}), ...(tab.workspaceLabel ? { workspaceLabel: tab.workspaceLabel } : {})
      },
      ...(tab.splitTree ? { isSplit: true, splitTree: tab.splitTree, paneSeq: tab.paneSeq } : {})
    })
    // Panes that were chats show as chats again (once the message list has their agents)
    for (const pane of tab.chats ?? []) queueChatView(tab.tabId, pane as PaneId)
  }
  loose.forEach((shell, index) => {
    store.addTerminal(shell.id, {
      id: shell.id, host: '이 PC', username: '', connected: true,
      title: adoptedTitle(shell, index),
      local: { shell: shell.name, ...(shell.cwd ? { cwd: shell.cwd, workspaceLabel: folderName(shell.cwd) } : {}) }
    })
  })
  if (afterUpdate) for (const id of [...tabs.map(tab => tab.mainShellId), ...loose.map(shell => shell.id)]) keptAfterUpdate.add(id)
  return { count: tabs.length + loose.length, afterUpdate }
}

/** Which shell sits in which pane of which tab, now */
export const currentLocalLayout = () => snapshotLocalTabs(useTerminalStore.getState().terminals, getLocalPaneShellId, isChatShown)

/** Called when the page goes away (a reload included): the layout the next page needs to put the shells back */
export function rememberLocalLayout(): void {
  writeReloadLayout(currentLocalLayout())
}
