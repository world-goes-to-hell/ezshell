import type { AgentMessage, AgentMessageSession } from '../types'
import type { TerminalInfo } from '../stores/terminalStore'
import { folderLabel } from './localWorkspaceTree'
import { MAIN_PANE, paneIds, type PaneId } from './splitTree'

const COLOR_COUNT = 8

export function agentIdentityLabel({ id, role }: Pick<AgentMessageSession, 'id' | 'role'>) {
  return role ? `${id} · ${role}` : id
}

export function agentIdentityColor(id: string): string {
  const serial = Number(/-(\d+)$/.exec(id)?.[1])
  let slot = 0
  if (Number.isSafeInteger(serial) && serial > 0) slot = serial - 1
  else for (const character of id) slot = (slot * 31 + character.codePointAt(0)!) % COLOR_COUNT
  const index = slot % COLOR_COUNT
  const tone = `var(--agent-identity-tone-${index + 1})`
  const cycle = Math.floor(slot / COLOR_COUNT)
  if (!cycle) return tone
  // Mix the same theme tones in a stable order for larger groups of agents.
  const companion = (index + (cycle - 1) % (COLOR_COUNT - 1) + 1) % COLOR_COUNT
  return `color-mix(in oklch, ${tone} 68%, var(--agent-identity-tone-${companion + 1}))`
}

export interface AgentPaneLocation {
  tabId: string
  pane: PaneId
  tabLabel: string
  number: number
  label: string
}

export function agentPaneLocation(tab: TerminalInfo | undefined, shellId: string, shellAt: (pane: PaneId) => string | undefined): AgentPaneLocation | undefined {
  if (!tab?.local || !shellId) return
  const panes = tab.splitTree ? paneIds(tab.splitTree) : [MAIN_PANE]
  const index = panes.findIndex(pane => shellAt(pane) === shellId)
  if (index === -1) return
  const tabLabel = tab.title || folderLabel(tab.local.cwd ?? '') || '로컬 터미널'
  const number = index + 1
  return { tabId: tab.id, pane: panes[index], tabLabel, number, label: `${tabLabel} · 칸 ${number}` }
}

export function agentDisplayName(agent: Pick<AgentMessageSession, 'role' | 'id' | 'cwd'>, location?: AgentPaneLocation) {
  return agent.role || location?.label || folderLabel(agent.cwd) || agent.id
}

export const agentSearchTerm = (value: string) => value.trim().normalize('NFC').toLowerCase()

export function agentMessageMatches(message: AgentMessage, term: string, roles: ReadonlyMap<string, string | null | undefined>) {
  return !term || [message.text, message.from, message.to, roles.get(message.from), roles.get(message.to)]
    .some(value => value && agentSearchTerm(value).includes(term))
}
