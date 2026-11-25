import type { AgentMessageSession } from '../types'

// The agents an answer can be handed to from the chat view (`인계`, docs/plan/2026-11-25-chat-reply-handoff.md):
// connected ones other than the chat's own, the same project's first. Main checks the choice again.

/** A path compared without case or slash style (Windows) and without a trailing slash */
const pathKey = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Whether two folders are the same project: one is the other or inside it */
export function sameProject(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const x = pathKey(a)
  const y = pathKey(b)
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

/** The last folder name of a path, or '' */
export function folderNameOf(cwd: string | null | undefined): string {
  if (!cwd) return ''
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

export interface HandoffTarget {
  agent: AgentMessageSession
  sameProject: boolean
}

/** Agents that can take the answer now: running with the message MCP (or asleep, woken by the message) */
export function handoffTargets(agents: readonly AgentMessageSession[], sourceId: string | null, sourceCwd: string | null): HandoffTarget[] {
  return agents
    .filter(agent => agent.active && agent.id !== sourceId && (agent.mcpConnected || agent.status === 'sleeping'))
    .map(agent => ({ agent, sameProject: sameProject(agent.cwd, sourceCwd) }))
    .sort((x, y) => Number(y.sameProject) - Number(x.sameProject)
      || x.agent.id.localeCompare(y.agent.id, undefined, { numeric: true }))
}
