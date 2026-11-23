import type { AgentChatProvider } from '../types'
import { useTerminalStore } from '../stores/terminalStore'
import { folderName } from './agentHistory'
import { adoptLocalPaneShell, getLocalPaneShellId } from './localPaneShells'
import { planReloadedTabs, snapshotLocalTabs, takeReloadLayout, writeReloadLayout } from './localReloadLayout'
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
}


/** Only a window without any local tab reloaded; one with tabs owns its shells already */
export function planAdoption(shells: readonly LiveLocalShell[], hasLocalTabs: boolean): { adopt: LiveLocalShell[]; close: string[] } {
  if (hasLocalTabs) return { adopt: [], close: [] }
  return {
    adopt: shells.filter(shell => !shell.exited),
    // An ended shell had a tab showing "종료됨": nothing to give back, just let it go
    close: shells.filter(shell => shell.exited).map(shell => shell.id)
  }
}

export function adoptedTitle(shell: LiveLocalShell, index: number): string {
  const folder = folderName(shell.cwd)
  if (folder) return folder
  return index === 0 ? shell.name : `${shell.name} (${index + 1})`
}

/** Called once after the first unlock; returns how many tabs came back */
export async function adoptOrphanLocalShells(): Promise<number> {
  let shells: LiveLocalShell[]
  try {
    shells = (await window.electronAPI.localShellList?.()) ?? []
  } catch {
    return 0
  }
  const store = useTerminalStore.getState()
  const hasLocalTabs = Array.from(store.terminals.values()).some(info => info.local)
  // Read (and removed) even when nothing is adopted: it belongs to the page that just went away
  const saved = takeReloadLayout()
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
  return tabs.length + loose.length
}

/** Called when the page goes away (a reload included): the layout the next page needs to put the shells back */
export function rememberLocalLayout(): void {
  writeReloadLayout(snapshotLocalTabs(useTerminalStore.getState().terminals, getLocalPaneShellId, isChatShown))
}
