// The counts on the folded sidebar rail. A saved session tied to a local project
// (lib/localProjectServers.ts) is shown under that project, so its tabs count under local work.

import type { TerminalInfo } from '../stores/terminalStore'
import { isSshTab } from './sessionTabs'

export interface RailCounts {
  sessions: { connected: number; lost: number }
  local: { terminals: number; connected: number; lost: number }
}

export function railCounts(terminals: ReadonlyMap<string, TerminalInfo>, projectTabIds: ReadonlySet<string>): RailCounts {
  const counts: RailCounts = { sessions: { connected: 0, lost: 0 }, local: { terminals: 0, connected: 0, lost: 0 } }
  terminals.forEach(info => {
    if (info.local) { counts.local.terminals += 1; return }
    // Only SSH tabs are sessions: not DB tabs, nor browser tabs (counted as connected sessions until 2026-11-24)
    if (!isSshTab(info)) return
    const group = projectTabIds.has(info.id) ? counts.local : counts.sessions
    if (info.connected) group.connected += 1
    else group.lost += 1
  })
  return counts
}
