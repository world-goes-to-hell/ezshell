// The Claude Code / Codex agents of local tabs, kept in the restore record and started again when the
// tabs are opened again after a restart (closing the app ends the shells and the agents in them).
// A pane whose agent had a conversation resumes it (the session id comes from its usage report; main
// checks it against the transcripts of this PC); a pane whose agent had none, or whose transcript is
// gone, starts the same agent fresh. Seen 2026-11-19: only the agent that had been talked to came back.

import type { TerminalInfo } from '../stores/terminalStore'
import type { AgentUsage, LocalAgent } from '../types'
import { MAIN_PANE, isSplitTree, paneIds, type PaneId } from './splitTree'
import { getLocalPaneShellId, queuePaneStart, type PaneStart } from './localPaneShells'
import type { RestoreAgent, RestoreTab } from './restoreTabs'
import { useAgentMessagesStore } from '../components/Terminal/AgentMessages'

/** The agent history key main resumes by */
export const historyKey = (agent: RestoreAgent & { sessionId: string }) => `${agent.agent}:${agent.sessionId}`

/**
 * For each pane, its agent: the session reported in its usage when there is one, otherwise the agent
 * known from the message list (`kinds`: shell id → agent), which an agent that never answered yet has.
 */
export function agentsOfPanes(
  panes: readonly PaneId[],
  shellOf: (pane: PaneId) => string | undefined,
  byShell: ReadonlyMap<string, AgentUsage>,
  kinds: ReadonlyMap<string, LocalAgent> = new Map()
): RestoreAgent[] {
  return panes.flatMap((pane): RestoreAgent[] => {
    const shell = shellOf(pane)
    if (!shell) return []
    const usage = byShell.get(shell)
    if (usage?.sessionId) return [{ pane, agent: usage.agent, sessionId: usage.sessionId }]
    const agent = usage?.agent ?? kinds.get(shell)
    return agent ? [{ pane, agent }] : []
  })
}

export function agentsOfLocalTab(tabId: string, info: TerminalInfo | undefined, byShell: ReadonlyMap<string, AgentUsage>, kinds?: ReadonlyMap<string, LocalAgent>): RestoreAgent[] {
  const local = info?.local
  if (!local) return []
  const panes = isSplitTree(info.splitTree) && info.splitTree ? paneIds(info.splitTree) : [MAIN_PANE]
  return agentsOfPanes(panes, pane => (pane === MAIN_PANE ? local.shellId ?? tabId : getLocalPaneShellId(tabId, pane)), byShell, kinds)
}

/** The agents running in local shells (shell id → kind), as the message list knows them */
export const agentKindsByShell = (): Map<string, LocalAgent> => new Map(useAgentMessagesStore.getState().snapshot.agents
  .filter(agent => agent.active && agent.shellId && (agent.kind === 'claude' || agent.kind === 'codex'))
  .map(agent => [agent.shellId, agent.kind] as const))

type OpenLocal = (options: { cwd?: string; workspaceLabel?: string; agent?: LocalAgent; resume?: string }) => Promise<string | null>

/** How a pane's agent starts again: its conversation, or the same agent fresh */
const startOf = (agent: RestoreAgent): PaneStart => (agent.sessionId
  ? { agent: agent.agent, resume: historyKey({ ...agent, sessionId: agent.sessionId }) }
  : { agent: agent.agent })

/**
 * Opens a recorded local tab: its main pane resumes its agent's conversation (or starts that agent
 * fresh, or as a last resort a plain shell), and its other panes start theirs when they open.
 */
export async function openLocalWithAgents(
  tab: Extract<RestoreTab, { kind: 'local' }>,
  open: OpenLocal,
  queue: (tabId: string, pane: PaneId, start: PaneStart) => void = queuePaneStart
): Promise<string | null> {
  const main = tab.agents?.find(agent => agent.pane === MAIN_PANE)
  const base = { cwd: tab.cwd, workspaceLabel: tab.workspaceLabel }
  let id: string | null = null
  if (main?.sessionId) id = await open({ ...base, ...startOf(main) })
  if (!id && main) id = await open({ ...base, agent: main.agent })
  if (!id) id = await open(base)
  if (id) for (const agent of tab.agents ?? []) if (agent.pane !== MAIN_PANE) queue(id, agent.pane as PaneId, startOf(agent))
  return id
}
