// Which agent changed which uncommitted file, as the "변경" tab shows it (docs/plan/2026-11-28-agent-file-owners.md):
// a chip with the agent's role on the file row, an overlap mark when two or more agents changed it, and the commit
// box's "에이전트로 고르기" that ticks one agent's files. Kept free of React for tests.
import type { AgentMessageSession, WorkspaceFileOwner, WorkspaceFreeze } from '../types'
import { isInsidePath } from './localWorkspaceTree'

export type FileAgent = WorkspaceFileOwner['agents'][number]

/** The chip on a file row: the role the agent was given, else its id */
export const agentChip = (agent: FileAgent): string => agent.role?.trim() || agent.id

/** The agent in full: "claude-2 · 개발A" */
export const agentName = (agent: FileAgent): string => agent.role?.trim() ? `${agent.id} · ${agent.role.trim()}` : agent.id

export const overlaps = (owner: WorkspaceFileOwner | undefined): boolean => (owner?.agents.length ?? 0) > 1

/** A file row's tooltip: who changed it, most recent first, and when the match is a guess */
export function ownersTitle(owner: WorkspaceFileOwner): string {
  const names = owner.agents.map(agentName).join(', ')
  const lead = overlaps(owner) ? `여러 에이전트가 고쳤습니다: ${names}` : `고친 에이전트: ${names}`
  return owner.uncertain ? `${lead}\n같은 때 여러 에이전트가 도구를 실행해 추정입니다.` : lead
}

/** The owners by path, for the rows */
export const ownersByPath = (owners: readonly WorkspaceFileOwner[]): ReadonlyMap<string, WorkspaceFileOwner> =>
  new Map(owners.map(owner => [owner.path, owner]))

export interface AgentFiles {
  agent: FileAgent
  /** Its files that can be ticked (in the list now), in the list's order */
  paths: string[]
  /** How many of them another agent changed too */
  shared: number
}

/**
 * The agents of the commit box's "에이전트로 고르기": each with the files it changed that can be ticked now, the
 * agent with the most recent change first. An agent with nothing to tick is left out.
 */
export function agentsWithFiles(owners: readonly WorkspaceFileOwner[], selectable: readonly string[]): AgentFiles[] {
  const byPath = ownersByPath(owners)
  const found = new Map<string, AgentFiles & { lastAt: number }>()
  for (const path of selectable) {
    const owner = byPath.get(path)
    if (!owner) continue
    for (const agent of owner.agents) {
      const entry = found.get(agent.id) ?? { agent, paths: [], shared: 0, lastAt: 0 }
      entry.paths.push(path)
      if (owner.agents.length > 1) entry.shared++
      if (agent.lastAt > entry.lastAt) { entry.lastAt = agent.lastAt; entry.agent = agent }
      found.set(agent.id, entry)
    }
  }
  return [...found.values()].sort((a, b) => b.lastAt - a.lastAt).map(({ lastAt: _lastAt, ...entry }) => entry)
}

/**
 * The agents the freeze can keep working (its `except`): Claude and Codex agents alive in the repository or a
 * folder inside it, the ones that hear the freeze
 */
export function agentsInRepo(agents: readonly AgentMessageSession[], top: string): AgentMessageSession[] {
  return agents.filter(agent => agent.active && (agent.kind === 'claude' || agent.kind === 'codex') && !!agent.cwd && isInsidePath(agent.cwd, top))
}

export const FREEZE_REASON_MAX = 200

/** The band over the changes while frozen: "동결 중 · 개발B만 작업 · 병합 · 14:20부터" */
export function freezeLine(freeze: WorkspaceFreeze, now = Date.now()): string {
  const at = new Date(freeze.since)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const day = new Date(now).toDateString() === at.toDateString() ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`
  const keeps = freeze.except ? `${freeze.except.role?.trim() || freeze.except.id}만 작업` : '모든 에이전트 멈춤'
  return ['동결 중', keeps, freeze.reason?.trim(), `${day}부터`].filter(Boolean).join(' · ')
}

/** A reason main takes: one line of up to 200 characters, or an error to show */
export function freezeReason(text: string): { reason?: string } | { error: string } {
  const reason = text.trim()
  if (!reason) return {}
  if (/[\r\n\u2028\u2029]/.test(reason)) return { error: '이유는 한 줄로 적어 주세요.' }
  if ([...reason].length > FREEZE_REASON_MAX) return { error: `이유는 ${FREEZE_REASON_MAX}자까지입니다.` }
  return { reason }
}
