import type { LocalAgent } from '../types'
import { useTerminalStore } from '../stores/terminalStore'
import { folderName } from './agentHistory'

// Local shells live in main and outlive their tabs (so a tab can be drawn again without losing the
// shell). When the window itself reloads, every tab is gone but the shells keep running: unseen,
// and an agent in one still answers messages. The window takes them back as tabs.

export interface LiveLocalShell {
  id: string
  name: string
  exited: boolean
  cwd: string | null
  agent: LocalAgent | null
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
  const { adopt, close } = planAdoption(shells, hasLocalTabs)
  for (const id of close) window.electronAPI.localShellClose?.(id)
  adopt.forEach((shell, index) => {
    store.addTerminal(shell.id, {
      id: shell.id, host: '이 PC', username: '', connected: true,
      title: adoptedTitle(shell, index),
      local: { shell: shell.name, ...(shell.cwd ? { cwd: shell.cwd, workspaceLabel: folderName(shell.cwd) } : {}) }
    })
  })
  return adopt.length
}
