import { describe, expect, it } from 'vitest'
import type { AgentMessageSession } from '../types'
import { folderNameOf, handoffTargets, sameProject } from './chatHandoff'

const agent = (id: string, over: Partial<AgentMessageSession> = {}): AgentMessageSession => ({
  id, shellId: `local:${id}`, kind: id.startsWith('codex') ? 'codex' : 'claude', cwd: 'D:\\work\\other', active: true,
  status: 'idle', waitingForReply: false, mcpConnected: true, ...over
})

describe('handoffTargets', () => {
  it('lists connected agents other than the chat\'s own, the same project first', () => {
    const agents = [
      agent('codex-12'),
      agent('claude-4', { cwd: 'D:\\work\\app' }),
      agent('codex-3', { cwd: 'd:/work/app/packages/web' }),
      agent('codex-5', { mcpConnected: false }),
      agent('claude-8', { active: false }),
      agent('claude-9', { mcpConnected: false, status: 'sleeping' as AgentMessageSession['status'] })
    ]
    const targets = handoffTargets(agents, 'claude-4', 'D:\\work\\app')
    expect(targets.map(target => target.agent.id)).toEqual(['codex-3', 'claude-9', 'codex-12'])
    expect(targets[0].sameProject).toBe(true)
  })
})

describe('paths', () => {
  it('compares projects without case, slash style or a trailing slash', () => {
    expect(sameProject('D:\\Work\\App\\', 'd:/work/app')).toBe(true)
    expect(sameProject('D:\\work\\application', 'D:\\work\\app')).toBe(false)
    expect(sameProject(null, 'D:\\work')).toBe(false)
  })

  it('takes the last folder name only', () => {
    expect(folderNameOf('D:\\work\\ezshell\\')).toBe('ezshell')
    expect(folderNameOf('/home/me/app')).toBe('app')
    expect(folderNameOf('')).toBe('')
  })
})
