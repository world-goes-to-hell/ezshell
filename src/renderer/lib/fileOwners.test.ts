import { describe, expect, it } from 'vitest'
import { agentChip, agentName, agentsInRepo, agentsWithFiles, freezeLine, freezeReason, overlaps, ownersTitle } from './fileOwners'
import type { AgentMessageSession, WorkspaceFileOwner } from '../types'

const A = { id: 'claude-2', kind: 'claude' as const, role: '개발A', lastAt: 30 }
const E = { id: 'claude-8', kind: 'claude' as const, role: '개발E', lastAt: 20 }
const C = { id: 'codex-5', kind: 'codex' as const, lastAt: 40 }
const owners: WorkspaceFileOwner[] = [
  { path: 'src/a.ts', agents: [A], uncertain: false },
  { path: 'src/shared.ts', agents: [A, E], uncertain: false },
  { path: 'src/e.ts', agents: [E], uncertain: true },
  { path: 'gone.ts', agents: [C], uncertain: false }
]

describe('the agents of uncommitted files', () => {
  it('names an agent by its role on the chip and in full in the tooltip', () => {
    expect(agentChip(A)).toBe('개발A')
    expect(agentChip(C)).toBe('codex-5')
    expect(agentName(A)).toBe('claude-2 · 개발A')
    expect(agentName({ ...C, role: '  ' })).toBe('codex-5')
  })

  it('marks a file two agents changed, and a guessed match', () => {
    expect(overlaps(owners[1])).toBe(true)
    expect(overlaps(owners[0])).toBe(false)
    expect(overlaps(undefined)).toBe(false)
    expect(ownersTitle(owners[1])).toBe('여러 에이전트가 고쳤습니다: claude-2 · 개발A, claude-8 · 개발E')
    expect(ownersTitle(owners[2])).toContain('추정')
  })

  it('lists each agent with the files it changed that can be ticked now, most recent first', () => {
    const selectable = ['src/a.ts', 'src/e.ts', 'src/shared.ts', 'src/nobody.ts']
    expect(agentsWithFiles(owners, selectable)).toEqual([
      { agent: A, paths: ['src/a.ts', 'src/shared.ts'], shared: 1 },
      { agent: E, paths: ['src/e.ts', 'src/shared.ts'], shared: 1 }
    ])
    // An agent whose files are all gone from the list (committed, ignored) is not offered
    expect(agentsWithFiles(owners, ['src/a.ts']).map(entry => entry.agent.id)).toEqual(['claude-2'])
  })

  it('offers the live agents of the repository (and folders inside it) as the one that keeps working', () => {
    const agents = [
      { id: 'claude-1', kind: 'claude', active: true, cwd: 'C:\\work\\shop' },
      { id: 'codex-2', kind: 'codex', active: true, cwd: 'C:/work/shop/backend' },
      { id: 'claude-3', kind: 'claude', active: false, cwd: 'C:\\work\\shop' },
      { id: 'claude-4', kind: 'claude', active: true, cwd: 'C:\\work\\shop-other' },
      { id: 'aside-5', kind: 'aside', active: true, cwd: 'C:\\work\\shop' }
    ] as unknown as AgentMessageSession[]
    expect(agentsInRepo(agents, 'C:/work/shop').map(agent => agent.id)).toEqual(['claude-1', 'codex-2'])
  })

  it('tells the freeze in one line, and checks the reason as main does', () => {
    const now = new Date(2026, 10, 28, 15, 0).getTime()
    const since = new Date(2026, 10, 28, 14, 20).getTime()
    expect(freezeLine({ since, except: { id: 'claude-1', role: '개발B' }, reason: '병합' }, now)).toBe('동결 중 · 개발B만 작업 · 병합 · 14:20부터')
    expect(freezeLine({ since }, now)).toBe('동결 중 · 모든 에이전트 멈춤 · 14:20부터')
    expect(freezeReason('  ')).toEqual({})
    expect(freezeReason(' 병합 중 ')).toEqual({ reason: '병합 중' })
    expect(freezeReason('a\nb')).toEqual({ error: '이유는 한 줄로 적어 주세요.' })
    expect(freezeReason('x'.repeat(201))).toEqual({ error: '이유는 200자까지입니다.' })
  })
})
