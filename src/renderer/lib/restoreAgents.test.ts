import { describe, expect, it, vi } from 'vitest'
import type { AgentUsage } from '../types'
import { agentsOfPanes, openLocalWithAgents } from './restoreAgents'

const CLAUDE = 'abcdef12-1111-4222-8333-444455556666'
const CODEX = '01a1ec18-9b8a-71c1-839d-2e31c010300f'
const usage = (agent: 'claude' | 'codex', sessionId: string | null): AgentUsage => ({ agent, model: null, effort: null, sessionId, context: null, fiveHour: null, sevenDay: null })

describe('agentsOfPanes', () => {
  it('takes the session of each pane whose shell reported one, and the agent alone otherwise', () => {
    const shells: Record<string, string> = { main: 'local:1', 'split-1': 'local:2', 'split-2': 'local:3' }
    const byShell = new Map([['local:1', usage('codex', CODEX)], ['local:2', usage('claude', CLAUDE)], ['local:3', usage('claude', null)]])
    expect(agentsOfPanes(['main', 'split-1', 'split-2'], pane => shells[pane], byShell)).toEqual([
      { pane: 'main', agent: 'codex', sessionId: CODEX },
      { pane: 'split-1', agent: 'claude', sessionId: CLAUDE },
      { pane: 'split-2', agent: 'claude' }
    ])
  })

  it('marks the panes that show their agent as a chat', () => {
    const shells: Record<string, string> = { main: 'local:1', 'split-1': 'local:2' }
    const byShell = new Map([['local:1', usage('codex', CODEX)], ['local:2', usage('claude', null)]])
    expect(agentsOfPanes(['main', 'split-1'], pane => shells[pane], byShell, new Map(), shell => shell === 'local:2')).toEqual([
      { pane: 'main', agent: 'codex', sessionId: CODEX },
      { pane: 'split-1', agent: 'claude', chat: true }
    ])
  })

  it('takes the agent of a pane from the message list when it has not reported usage', () => {
    expect(agentsOfPanes(['main', 'split-1'], pane => (pane === 'main' ? 'local:1' : 'local:2'), new Map(), new Map([['local:1', 'claude' as const]])))
      .toEqual([{ pane: 'main', agent: 'claude' }])
  })
})

describe('openLocalWithAgents', () => {
  const tab = { kind: 'local' as const, cwd: 'D:\\work', workspaceLabel: 'work', agents: [
    { pane: 'main', agent: 'codex' as const, sessionId: CODEX },
    { pane: 'split-1', agent: 'claude' as const, sessionId: CLAUDE }
  ] }

  it('queues the panes that were chats to open as chats again', async () => {
    const queueChat = vi.fn()
    const chats = { ...tab, agents: [{ ...tab.agents[0], chat: true as const }, tab.agents[1]] }
    expect(await openLocalWithAgents(chats, vi.fn(async () => 'local:7'), vi.fn(), queueChat)).toBe('local:7')
    expect(queueChat.mock.calls).toEqual([['local:7', 'main']])
  })

  it('resumes the main pane and queues the other panes', async () => {
    const open = vi.fn(async () => 'local:7')
    const queue = vi.fn()
    expect(await openLocalWithAgents(tab, open, queue)).toBe('local:7')
    expect(open.mock.calls).toEqual([[{ cwd: 'D:\\work', workspaceLabel: 'work', agent: 'codex', resume: `codex:${CODEX}` }]])
    expect(queue.mock.calls).toEqual([['local:7', 'split-1', { agent: 'claude', resume: `claude:${CLAUDE}` }]])
  })

  it('starts the same agent fresh when there was no conversation or it cannot be resumed', async () => {
    const fresh = { kind: 'local' as const, cwd: 'D:\\work', agents: [{ pane: 'main', agent: 'codex' as const }, { pane: 'split-1', agent: 'claude' as const }] }
    const open = vi.fn(async () => 'local:5')
    const queue = vi.fn()
    expect(await openLocalWithAgents(fresh, open, queue)).toBe('local:5')
    expect(open.mock.calls).toEqual([[{ cwd: 'D:\\work', workspaceLabel: undefined, agent: 'codex' }]])
    expect(queue.mock.calls).toEqual([['local:5', 'split-1', { agent: 'claude' }]])

    const failing = vi.fn(async (options: { resume?: string; agent?: string }) => (options.resume ? null : options.agent ? 'local:6' : 'local:7'))
    expect(await openLocalWithAgents(tab, failing, vi.fn())).toBe('local:6')
    expect(failing).toHaveBeenLastCalledWith({ cwd: 'D:\\work', workspaceLabel: 'work', agent: 'codex' })
  })

  it('opens a plain shell when no agent can be started at all', async () => {
    const open = vi.fn(async (options: { resume?: string; agent?: string }) => (options.resume || options.agent ? null : 'local:8'))
    expect(await openLocalWithAgents(tab, open, vi.fn())).toBe('local:8')
    expect(open).toHaveBeenLastCalledWith({ cwd: 'D:\\work', workspaceLabel: 'work' })
  })

  it('opens a tab without agents as before', async () => {
    const open = vi.fn(async () => 'local:9')
    await openLocalWithAgents({ kind: 'local', cwd: 'D:\\x' }, open, vi.fn())
    expect(open.mock.calls).toEqual([[{ cwd: 'D:\\x', workspaceLabel: undefined }]])
  })
})
