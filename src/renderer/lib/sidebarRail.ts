// The counts on the folded sidebar rail. A saved session tied to a local project
// (lib/localProjectServers.ts) is shown under that project, so its tabs count under local work.

import type { TerminalInfo } from '../stores/terminalStore'

export interface RailCounts {
  sessions: { connected: number; lost: number }
  local: { terminals: number; connected: number; lost: number }
}

export function railCounts(terminals: ReadonlyMap<string, TerminalInfo>, linkedSessionIds: ReadonlySet<string>): RailCounts {
  const counts: RailCounts = { sessions: { connected: 0, lost: 0 }, local: { terminals: 0, connected: 0, lost: 0 } }
  terminals.forEach(info => {
    if (info.db) return
    if (info.local) { counts.local.terminals += 1; return }
    const savedId = info.connectConfig?.savedSessionId
    const group = savedId && linkedSessionIds.has(savedId) ? counts.local : counts.sessions
    if (info.connected) group.connected += 1
    else group.lost += 1
  })
  return counts
}

/** Every saved session tied to some local project */
export const linkedSessionIdsOf = (servers: Readonly<Record<string, readonly string[]>>): Set<string> =>
  new Set(Object.values(servers).flat())
