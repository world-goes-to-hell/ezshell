// Panes to show as chats again after their tab came back (app restart record, or a window reload). A chat
// can open only once the shell's agent is in the message list: after a restart the agent starts again
// (--resume) a few seconds later, and a pane other than the main one gets its shell later still. So the
// pane waits here, and is shown as a chat when its shell has a supported agent.

import type { PaneId } from './splitTree'
import { getLocalPaneShellId } from './localPaneShells'
import { isAgentChatProvider, shellAgentOf } from './agentChatItems'
import { useAgentMessagesStore } from '../components/Terminal/AgentMessages'
import { useAgentChatStore } from '../stores/agentChatStore'

/** Past this the agent did not come back: the pane stays a terminal */
export const CHAT_WAIT_MS = 120_000

export interface PendingChat {
  tabId: string
  pane: PaneId
  until: number
}

type Agent = { active: boolean; shellId: string; kind: string }

/** Which waiting panes open as chats now (their shell ids), and which still wait */
export function planChatViews(
  pending: readonly PendingChat[],
  now: number,
  shellOf: (tabId: string, pane: PaneId) => string | undefined,
  agents: readonly Agent[]
): { open: string[]; wait: PendingChat[] } {
  const open: string[] = []
  const wait: PendingChat[] = []
  for (const entry of pending) {
    if (now > entry.until) continue
    const shell = shellOf(entry.tabId, entry.pane)
    const kind = shell ? shellAgentOf(agents, shell)?.kind : undefined
    if (shell && isAgentChatProvider(kind)) open.push(shell)
    else wait.push(entry)
  }
  return { open, wait }
}

let pending: PendingChat[] = []
let stopWatching: (() => void) | null = null

function check(): void {
  const { open, wait } = planChatViews(pending, Date.now(), getLocalPaneShellId, useAgentMessagesStore.getState().snapshot.agents)
  pending = wait
  for (const shell of open) void useAgentChatStore.getState().show(shell)
  if (pending.length === 0) {
    stopWatching?.()
    stopWatching = null
  }
}

/** The pane shows its agent as a chat once the agent is in its shell (within CHAT_WAIT_MS) */
export function queueChatView(tabId: string, pane: PaneId): void {
  pending = [...pending.filter(entry => entry.tabId !== tabId || entry.pane !== pane), { tabId, pane, until: Date.now() + CHAT_WAIT_MS }]
  // The message list changes when an agent registers or binds to its shell
  stopWatching ??= useAgentMessagesStore.subscribe(check)
  check()
}
