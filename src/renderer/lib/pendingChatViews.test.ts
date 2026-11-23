import { describe, expect, it, vi } from 'vitest'

vi.mock('../components/Terminal/AgentMessages', () => ({ useAgentMessagesStore: { getState: () => ({ snapshot: { agents: [] } }), subscribe: () => () => {} } }))
vi.mock('../stores/agentChatStore', () => ({ useAgentChatStore: { getState: () => ({ show: async () => true }) } }))

const { planChatViews } = await import('./pendingChatViews')

const shells: Record<string, string> = { 'local:1\nmain': 'local:1', 'local:1\nsplit-1': 'local:2' }
const shellOf = (tabId: string, pane: string) => shells[`${tabId}\n${pane}`]
const agent = (shellId: string, kind = 'codex', active = true) => ({ shellId, kind, active })

describe('planChatViews', () => {
  const waiting = [{ tabId: 'local:1', pane: 'main', until: 1000 }, { tabId: 'local:1', pane: 'split-1', until: 1000 }]

  it('opens the panes whose shell has a live Claude or Codex, and keeps the others waiting', () => {
    const { open, wait } = planChatViews(waiting, 10, shellOf, [agent('local:1', 'claude')])
    expect(open).toEqual(['local:1'])
    expect(wait.map(entry => entry.pane)).toEqual(['split-1'])
  })

  it('waits while the pane has no shell yet, or its agent ended or is of another kind', () => {
    const noShell = planChatViews([{ tabId: 'local:9', pane: 'main', until: 1000 }], 10, shellOf, [agent('local:9')])
    expect(noShell.open).toEqual([])
    expect(planChatViews(waiting, 10, shellOf, [agent('local:1', 'codex', false), agent('local:2', 'other')]).open).toEqual([])
  })

  it('opens Antigravity chat only after a live agent has been bound to that shell', () => {
    const { open, wait } = planChatViews(waiting, 10, shellOf, [agent('local:1', 'antigravity', false), agent('local:2', 'antigravity')])
    expect(open).toEqual(['local:2'])
    expect(wait).toEqual([waiting[0]])
  })

  it('gives up on a pane whose agent did not come back in time', () => {
    expect(planChatViews(waiting, 2000, shellOf, [agent('local:1')])).toEqual({ open: [], wait: [] })
  })
})
