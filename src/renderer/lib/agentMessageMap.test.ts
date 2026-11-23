import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentMessageSession } from '../types'
import {
  AGENT_MESSAGE_VIEW_KEY, agentMessageMap, clampMessageMapPoint, layoutAgentMessageMap, layoutMessageMapLabels,
  MAP_CARD_HEIGHT, MAP_CARD_WIDTH, messageMapArrow, type MapPoint
} from './agentMessageMap'
import { UI_SETTING_ENTRIES } from './uiSettingsBackup'

function agent(id: string, fields: Partial<AgentMessageSession> = {}): AgentMessageSession {
  return { id, shellId: id, kind: 'claude', cwd: 'C:\\work', active: true, status: 'idle', waitingForReply: false, mcpConnected: true, ...fields }
}

function message(id: string, from: string, to: string, fields: Partial<AgentMessage> = {}): AgentMessage {
  return { id, from, to, text: id, sentAt: 1, read: false, ...fields }
}

interface Box { point: MapPoint; width: number; height: number }

function overlaps(a: Box, b: Box) {
  return Math.abs(a.point.x - b.point.x) < (a.width + b.width) / 2 &&
    Math.abs(a.point.y - b.point.y) < (a.height + b.height) / 2
}

describe('agent message map', () => {
  it('counts both directions and puts a pair’s messages in chronological order', () => {
    const agents = [agent('claude-1'), agent('codex-2'), agent('codex-3')]
    const model = agentMessageMap(agents, [
      message('later-reply', 'codex-2', 'claude-1', { replyTo: 'request', replyStatus: 'deferred', sentAt: 5 }),
      message('seen', 'claude-1', 'codex-2', { seenAt: 4, sentAt: 3 }),
      message('request', 'claude-1', 'codex-2', { sentAt: 2 }),
      message('acknowledged', 'claude-1', 'codex-2', { read: true, sentAt: 4 }),
      message('unread', 'claude-1', 'codex-2', { sentAt: 6 }),
      message('another-pair', 'claude-1', 'codex-3'),
      message('user-note', 'claude-1', 'user'),
      message('cross-workspace', 'claude-1', 'claude-4')
    ])
    expect(model.edges).toHaveLength(2)
    expect(model.edges[0].directions).toEqual([
      { from: 'claude-1', to: 'codex-2', count: 4, states: { unread: 1, seen: 1, answered: 2 } },
      { from: 'codex-2', to: 'claude-1', count: 1, states: { unread: 1, seen: 0, answered: 0 } }
    ])
    expect(model.edges[0].messages.map(item => item.id)).toEqual(['request', 'seen', 'acknowledged', 'later-reply', 'unread'])
    expect(model.messageStates.get('user-note')).toBe('unread')
    expect(model.messageStates.has('cross-workspace')).toBe(false)
  })

  it('keeps connected and sleeping agents with no traffic and dims disconnected agents with history', () => {
    const agents = [
      agent('codex-10'),
      agent('codex-2', { active: false, status: 'ended', mcpConnected: false }),
      agent('codex-3', { active: false, status: 'ended', mcpConnected: false }),
      agent('codex-4', { status: 'sleeping', mcpConnected: false }),
      agent('codex-5', { mcpConnected: false })
    ]
    const model = agentMessageMap(agents, [message('note', 'codex-2', 'user')])
    expect(model.nodes.map(({ agent, archived }) => [agent.id, archived])).toEqual([
      ['codex-2', true], ['codex-4', false], ['codex-10', false]
    ])
    expect(model.edges).toHaveLength(0)
  })

  it('recounts arrivals and read states without changing a pair ID', () => {
    const agents = [agent('claude-1'), agent('codex-2')]
    const request = message('request', 'claude-1', 'codex-2')
    const initial = agentMessageMap(agents, [request])
    const updated = agentMessageMap(agents, [{ ...request, seenAt: 2 },
      message('reply', 'codex-2', 'claude-1', { replyTo: 'request', replyStatus: 'completed' })])
    expect(updated.edges[0].id).toBe(initial.edges[0].id)
    expect(updated.messageStates.get('request')).toBe('answered')
    expect(updated.messageStates.get('reply')).toBe('unread')
  })
})

describe('message map geometry', () => {
  it('centers a single card and gives small windows a scrollable canvas for multiple cards', () => {
    expect(layoutAgentMessageMap(['claude-1'], 500, 300).positions.get('claude-1')).toEqual({ x: 250, y: 150 })
    const layout = layoutAgentMessageMap(['a', 'b', 'c', 'd', 'e'], 320, 200)
    expect(layout.width).toBeGreaterThan(320)
    expect(layout.height).toBeGreaterThan(200)
    expect(layout.positions.get('a')!.x + MAP_CARD_WIDTH).toBeLessThan(layout.positions.get('b')!.x)
    expect(layout.positions.get('a')!.y + MAP_CARD_HEIGHT).toBeLessThan(layout.positions.get('c')!.y)
    expect(clampMessageMapPoint({ x: -100, y: 500 }, 300, 200)).toEqual({ x: MAP_CARD_WIDTH / 2 + 6, y: 200 - MAP_CARD_HEIGHT / 2 - 6 })
  })

  it('draws arrows to the edge of each card and curves a return arrow to the opposite side', () => {
    const left = { x: 100, y: 100 }
    const right = { x: 400, y: 100 }
    expect(messageMapArrow(left, right, false)).toEqual({ path: 'M 179 100 Q 250 100 321 100', angle: 0 })
    expect(messageMapArrow(left, right, true)?.path).toContain('Q 250 123')
    expect(messageMapArrow(right, left, true)?.path).toContain('Q 250 77')
    expect(messageMapArrow(left, left, true)).toBeNull()
  })

  it('separates the labels of two crossing relationships', () => {
    const agents = ['a', 'b', 'c', 'd'].map(id => agent(id))
    const model = agentMessageMap(agents, [message('one', 'a', 'd'), message('two', 'b', 'c')])
    const { positions, width, height } = layoutAgentMessageMap(agents.map(item => item.id), 470, 350)
    const [first, second] = [...layoutMessageMapLabels(model.edges, positions, width, height).values()]
    expect(overlaps(first, second)).toBe(false)
  })

  it.each([
    { shape: 'star', count: 12, edges: 11 },
    { shape: 'complete', count: 10, edges: 45 }
  ])('keeps all $edges labels clear in a $count-agent $shape at 690×430', ({ shape, count, edges: edgeCount }) => {
    const ids = Array.from({ length: count }, (_, index) => `a-${index + 1}`)
    const traffic = ids.flatMap((from, index) => {
      if (shape === 'star' && index !== 0) return []
      return ids.slice(index + 1).map(to => message(`${from}/${to}`, from, to))
    })
    const graph = agentMessageMap(ids.map(id => agent(id)), traffic)
    const { positions, width, height } = layoutAgentMessageMap(ids, 690, 430)
    const labels = [...layoutMessageMapLabels(graph.edges, positions, width, height).values()]
    const cards = [...positions.values()].map(point => ({ point, width: MAP_CARD_WIDTH, height: MAP_CARD_HEIGHT }))

    expect(labels).toHaveLength(edgeCount)
    expect(labels.filter(label => label.overCard || cards.some(card => overlaps(label, card)))).toHaveLength(0)
    expect(labels.flatMap((label, index) => labels.slice(index + 1).filter(other => overlaps(label, other)))).toHaveLength(0)
  })

  it('marks a label for the foreground when the cards leave no room for it', () => {
    const { edges } = agentMessageMap([agent('a'), agent('b')], [message('one', 'a', 'b')])
    const positions = new Map([['a', { x: 76, y: 39 }], ['b', { x: 80, y: 39 }]])
    const [label] = [...layoutMessageMapLabels(edges, positions, 152, 78).values()]

    expect(label.overCard).toBe(true)
    expect(label.point.x).toBeGreaterThanOrEqual(label.width / 2)
    expect(label.point.x).toBeLessThanOrEqual(152 - label.width / 2)
  })
})

it('backs up only the two supported view choices', () => {
  const setting = UI_SETTING_ENTRIES.find(entry => entry.key === AGENT_MESSAGE_VIEW_KEY)!
  const context = { shortcutIds: [] }
  expect(setting.normalize('map', context)).toBe('map')
  expect(setting.normalize('list', context)).toBe('list')
  expect(setting.normalize('a work folder', context)).toBeNull()
})
