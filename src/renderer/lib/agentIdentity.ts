import type { AgentMessage, AgentMessageSession, LocalAgentStatus } from '../types'
import type { TerminalInfo } from '../stores/terminalStore'
import { folderLabel } from './localWorkspaceTree'
import { MAIN_PANE, paneIds, type PaneId } from './splitTree'

const COLOR_COUNT = 8

export const AGENT_PROVIDER_NAMES = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' } as const

const statusLabels: Record<LocalAgentStatus | 'reply', string> = {
  unknown: '상태 확인 중', starting: '시작 중', idle: '쉼', working: '작업 중',
  blocked: '응답 필요', error: '오류', ended: '종료', sleeping: '잠듦', reply: '답장 대기'
}

export function agentIdentityStatus(agent: AgentMessageSession, archived = false): { status: LocalAgentStatus | 'reply'; label: string } {
  const waiting = agent.waitingForReply && ['working', 'idle', 'unknown'].includes(agent.status)
  const status = archived ? 'ended' : waiting ? 'reply' : agent.status
  const label = archived && agent.active ? '연결 끊김' : statusLabels[status]
  return { status, label }
}

/**
 * Where an agent's state came from, for tooltips only (user decision 5 of
 * docs/plan/2026-11-24-agent-state-via-official-signals.md). Only the word main sends, nothing else.
 */
export function agentStatusSourceNote(kind: AgentMessageSession['kind'], source: AgentMessageSession['statusSource']): string | undefined {
  if (source === 'hook') return `${kind === 'claude' ? 'Claude' : AGENT_PROVIDER_NAMES[kind] ?? '에이전트'} 가 알려 준 신호로 판단`
  if (source === 'screen') return '터미널 화면을 보고 판단'
  return undefined
}

export function agentIdentityTooltip(agent: AgentMessageSession, location?: AgentPaneLocation, archived = false) {
  const { id, role, kind, cwd, exitCode } = agent
  const { status, label } = agentIdentityStatus(agent, archived)
  const detail = role && role !== id ? id : undefined
  const state = status === 'error' && exitCode ? label + ' (종료 코드 ' + exitCode + ')' : label
  const identity = detail ? role + ' · ' + detail : id
  // An archived card's state is not the agent's reported one: no source then
  const source = archived ? undefined : agentStatusSourceNote(kind, agent.statusSource)
  // Three lines (name / kind · state / place, CLAUDE.md): the state's source qualifies the state on its line
  const title = [identity, [AGENT_PROVIDER_NAMES[kind], state, source].filter(Boolean).join(' · '), location?.label || cwd].filter(Boolean).join('\n')
  return { title, 'data-tooltip-detail': detail }
}

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

/** A local agent's name in the work overview and sidebar: "Codex 9", or "리뷰어 · Codex 9" once it has a role */
export function localAgentName(agent: Pick<AgentMessageSession, 'id' | 'kind' | 'role'>) {
  const base = `${AGENT_PROVIDER_NAMES[agent.kind]} ${agent.id.slice(agent.kind.length + 1)}`
  const role = agent.role?.trim()
  return role ? `${role} · ${base}` : base
}

export const agentSearchTerm = (value: string) => value.trim().normalize('NFC').toLowerCase()

export function agentMessageMatches(message: AgentMessage, term: string, roles: ReadonlyMap<string, string | null | undefined>) {
  return !term || [message.text, message.from, message.to, roles.get(message.from), roles.get(message.to)]
    .some(value => value && agentSearchTerm(value).includes(term))
}
