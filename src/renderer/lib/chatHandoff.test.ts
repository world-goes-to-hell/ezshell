import { describe, expect, it } from 'vitest'
import type { AgentMessageSession } from '../types'
import { handoffProjects, selectedHandoffProject } from './chatHandoff'
import type { GroupProject } from './tabGroups'

const agent = (id: string, over: Partial<AgentMessageSession> = {}): AgentMessageSession => ({
  id, shellId: `local:${id}`, kind: id.startsWith('codex') ? 'codex' : 'claude', cwd: 'D:\\work\\other', active: true,
  status: 'idle', waitingForReply: false, mcpConnected: true, ...over
})

describe('handoffProjects', () => {
  const projects: GroupProject[] = [
    { key: 'd:/work/zen', name: 'Zen', worktrees: ['D:\\work\\Zen', 'D:\\checkouts\\feature'] },
    { key: 'd:/work/atlas', name: 'Atlas', worktrees: ['D:\\work\\Atlas'] }
  ]

  it('combines worktrees, puts the sender’s project first and counts eligible and working agents', () => {
    const agents = [
      agent('codex-12', { cwd: 'd:/work/zen' }),
      agent('claude-4', { cwd: 'D:\\work\\Zen' }),
      agent('codex-3', { cwd: 'd:/checkouts/feature/packages/web', status: 'working' }),
      agent('codex-5', { cwd: 'd:/work/Zen', mcpConnected: false }),
      agent('claude-8', { cwd: 'd:/work/Atlas', active: false }),
      agent('claude-9', { cwd: 'd:/work/Atlas', mcpConnected: false, status: 'sleeping' }),
      agent('codex-7', { cwd: 'd:/checkouts/feature', status: 'working', waitingForReply: true }),
      agent('codex-6', { cwd: 'd:/work/Zebra' })
    ]
    const groups = handoffProjects(agents, 'claude-4', 'D:\\work\\Zen', projects)
    expect(groups.map(group => [group.key, group.name, group.sameProject, group.workingCount, group.agents.map(agent => agent.id)])).toEqual([
      ['d:/work/zen', 'Zen', true, 1, ['codex-3', 'codex-7', 'codex-12']],
      ['d:/work/atlas', 'Atlas', false, 0, ['claude-9']],
      ['folder:d:/work/zebra', 'Zebra', false, 0, ['codex-6']]
    ])
  })

  it('groups unregistered folders by path and unknown folders under 기타', () => {
    const groups = handoffProjects([
      agent('codex-1', { cwd: 'D:\\team-a\\Scratch\\' }),
      agent('codex-2', { cwd: 'd:/team-a/scratch' }),
      agent('codex-3', { cwd: 'D:\\team-b\\Scratch' }),
      agent('codex-4', { cwd: '' }),
      agent('codex-5', { cwd: ' ' })
    ], 'source', 'd:/team-b/scratch', projects)
    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ key: 'folder:d:/team-b/scratch', name: 'Scratch', sameProject: true })
    expect(groups.find(group => group.key === 'folder:d:/team-a/scratch')?.agents).toHaveLength(2)
    const unknown = groups.find(group => group.name === '기타')
    expect(unknown?.agents.map(agent => agent.id)).toEqual(['codex-4', 'codex-5'])
    expect(unknown?.sameProject).toBe(false)
  })

  it('skips the chooser only when one project remains and drops a project that disappeared', () => {
    const groups = handoffProjects([agent('codex-1'), agent('codex-2', { cwd: 'D:/work/atlas' })], null, null, projects)
    expect(selectedHandoffProject([], null)).toBeUndefined()
    expect(selectedHandoffProject(groups, null)).toBeUndefined()
    expect(selectedHandoffProject(groups, groups[1].key)).toBe(groups[1])
    expect(selectedHandoffProject(groups, 'closed-project')).toBeUndefined()
    expect(selectedHandoffProject([groups[0]], 'closed-project')).toBe(groups[0])
  })
})
