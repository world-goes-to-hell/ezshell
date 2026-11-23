import type { AgentMessage, AgentMessageSession } from '../types'

export const AGENT_MESSAGE_VIEW_KEY = 'ezshell.agentMessageView'
export const parseAgentMessageView = (value: string | null) => value === 'map' || value === 'list' ? value : null

export type MessageState = 'unread' | 'seen' | 'answered'

interface Direction {
  from: string
  to: string
  count: number
  states: Record<MessageState, number>
}

export interface MessageRelationship {
  id: string
  first: string
  second: string
  directions: Direction[]
  messages: AgentMessage[]
}

export function agentMessageMap(agents: readonly AgentMessageSession[], messages: readonly AgentMessage[]) {
  const ids = new Set(agents.map(agent => agent.id))
  const workspaceMessages = messages.filter(({ from, to }) =>
    (ids.has(from) && (ids.has(to) || to === 'user')) || (from === 'user' && ids.has(to)))
  const history = new Set(workspaceMessages.flatMap(({ from, to }) => [from, to]))
  const byMessageId = new Map(workspaceMessages.map(message => [message.id, message]))
  const answered = new Set(workspaceMessages.flatMap(message => {
    const original = message.replyTo ? byMessageId.get(message.replyTo) : undefined
    return original?.from === message.to && original.to === message.from ? [original.id] : []
  }))
  // A deferred reply and an acknowledgement both count as answers in check_sent.
  // The reply message itself still has its own delivery state.
  const messageStates = new Map<string, MessageState>()
  const relationships = new Map<string, MessageRelationship>()
  for (const message of workspaceMessages) {
    const { from, to } = message
    const state = message.read || answered.has(message.id) ? 'answered' : message.seenAt ? 'seen' : 'unread'
    messageStates.set(message.id, state)
    if (from === to || !ids.has(from) || !ids.has(to)) continue
    const [first, second] = from < to ? [from, to] : [to, from]
    const id = JSON.stringify([first, second])
    let relationship = relationships.get(id)
    if (!relationship) {
      relationship = { id, first, second, directions: [], messages: [] }
      relationships.set(id, relationship)
    }
    let direction = relationship.directions.find(item => item.from === from)
    if (!direction) {
      direction = { from, to, count: 0, states: { unread: 0, seen: 0, answered: 0 } }
      relationship.directions.push(direction)
    }
    direction.count++
    direction.states[state]++
    relationship.messages.push(message)
  }
  const nodes = agents.flatMap(agent => {
    const connected = agent.active && (agent.mcpConnected || agent.status === 'sleeping')
    return connected || history.has(agent.id) ? [{ agent, archived: !connected }] : []
  }).sort((a, b) => a.agent.id.localeCompare(b.agent.id, undefined, { numeric: true }))
  const edges = [...relationships.values()].sort((a, b) => a.id.localeCompare(b.id))
  for (const edge of edges) {
    edge.directions.sort((a, b) => a.from.localeCompare(b.from))
    edge.messages.sort((a, b) => a.sentAt - b.sentAt)
  }
  return { nodes, edges, messageStates }
}

export interface MapPoint { x: number; y: number }

export const MAP_CARD_WIDTH = 152
export const MAP_CARD_HEIGHT = 78
const padding = 24

export function layoutAgentMessageMap(ids: readonly string[], viewportWidth: number, viewportHeight: number) {
  const count = ids.length
  const width = Math.max(viewportWidth, count > 1 ? 470 : MAP_CARD_WIDTH + 2 * padding)
  const columns = count < 2 ? 1 : width >= 820 && count >= 5 ? 3 : 2
  const rows = Math.ceil(count / columns)
  const height = Math.max(viewportHeight, rows * 174, MAP_CARD_HEIGHT + 2 * padding)
  const positions = new Map(ids.map((id, index) => {
    const row = Math.floor(index / columns)
    const items = Math.min(columns, count - row * columns)
    const margin = MAP_CARD_WIDTH / 2 + padding
    const x = items === 1 ? width / 2 : margin + (width - margin * 2) * (index % columns) / (items - 1)
    return [id, { x, y: (row + 0.5) * height / rows }]
  }))
  return { positions, width, height }
}

export function clampMessageMapPoint(point: MapPoint, width: number, height: number): MapPoint {
  const horizontal = MAP_CARD_WIDTH / 2 + 6
  const vertical = MAP_CARD_HEIGHT / 2 + 6
  return {
    x: Math.max(horizontal, Math.min(width - horizontal, point.x)),
    y: Math.max(vertical, Math.min(height - vertical, point.y))
  }
}

function connectAt(card: MapPoint, towards: MapPoint) {
  const dx = towards.x - card.x
  const dy = towards.y - card.y
  const factor = 1 / Math.max(Math.abs(dx) / (MAP_CARD_WIDTH / 2 + 3), Math.abs(dy) / (MAP_CARD_HEIGHT / 2 + 3))
  return { x: card.x + dx * factor, y: card.y + dy * factor }
}

export function messageMapArrow(from: MapPoint, to: MapPoint, twoWay: boolean) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  if (distance === 0) return null
  const bend = twoWay ? 23 / distance : 0
  const control = { x: (from.x + to.x) / 2 - dy * bend, y: (from.y + to.y) / 2 + dx * bend }
  const start = connectAt(from, control)
  const end = connectAt(to, control)
  if ((end.x - start.x) * dx + (end.y - start.y) * dy <= 0) return null
  return {
    path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    angle: Math.atan2(dy, dx) * 180 / Math.PI
  }
}

interface MapBox { point: MapPoint; width: number; height: number }

function overlapArea(a: MapBox, b: MapBox, gap = 0) {
  const width = Math.min(a.width, b.width, (a.width + b.width) / 2 + gap - Math.abs(a.point.x - b.point.x))
  const height = Math.min(a.height, b.height, (a.height + b.height) / 2 + gap - Math.abs(a.point.y - b.point.y))
  return Math.max(0, width) * Math.max(0, height)
}

const labelRatios = [0, 0.08, -0.08, 0.16, -0.16, 0.24, -0.24, 0.32, -0.32, 0.40, -0.40]
const labelOffsets = [0, 24, -24, 48, -48, 72, -72, 96, -96, 128, -128, 156, -156]

export function layoutMessageMapLabels(edges: readonly MessageRelationship[], positions: ReadonlyMap<string, MapPoint>, canvasWidth: number, canvasHeight: number) {
  const labels = new Map<string, MapBox & { overCard: boolean }>()
  const cards = [...positions.values()].map(point => ({ point, width: MAP_CARD_WIDTH, height: MAP_CARD_HEIGHT }))
  for (const edge of edges) {
    const from = positions.get(edge.first)!
    const to = positions.get(edge.second)!
    const dx = to.x - from.x
    const dy = to.y - from.y
    const distance = Math.hypot(dx, dy) || 1
    const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
    const statusCount = Math.max(...edge.directions.map(direction => Object.values(direction.states).filter(Boolean).length))
    const width = 42 + statusCount * 37
    const height = 13 + edge.directions.length * 16
    const placed = [...labels.values()]
    const offset = (along: number, beside: number) => ({
      x: middle.x + dx * along - dy / distance * beside,
      y: middle.y + dy * along + dx / distance * beside
    })
    const candidates = [middle, offset(0.19, 0), offset(-0.19, 0), offset(0, 48), offset(0, -48),
      { x: middle.x, y: middle.y - height - 8 }, { x: middle.x, y: middle.y + height + 8 },
      { x: middle.x - width - 8, y: middle.y }, { x: middle.x + width + 8, y: middle.y }
    ]
    const fits = ({ x, y }: MapPoint) => x >= width / 2 && x <= canvasWidth - width / 2 &&
      y >= height / 2 && y <= canvasHeight - height / 2
    const isClear = (point: MapPoint) => fits(point) &&
      !cards.some(card => overlapArea({ point, width, height }, card, 4)) &&
      !placed.some(label => overlapArea({ point, width, height }, label, 4))
    let point = candidates.find(isClear)
    if (!point) {
      const expanded = labelOffsets.flatMap(beside => labelRatios.map(along => offset(along, beside)))
      point = expanded.find(isClear)
      if (!point) {
        // When space runs out, give the card priority and minimize overlap with other labels.
        const fallback = [...candidates, ...expanded].filter(fits).map(point => {
          const box = { point, width, height }
          return {
            point,
            cardArea: cards.reduce((area, card) => area + overlapArea(box, card), 0),
            labelArea: placed.reduce((area, label) => area + overlapArea(box, label), 0)
          }
        }).sort((a, b) => a.cardArea - b.cardArea || a.labelArea - b.labelArea)[0]
        point = fallback?.point ?? {
          x: Math.max(width / 2, Math.min(canvasWidth - width / 2, middle.x)),
          y: Math.max(height / 2, Math.min(canvasHeight - height / 2, middle.y))
        }
      }
    }
    const box = { point, width, height }
    labels.set(edge.id, { ...box, overCard: cards.some(card => overlapArea(box, card) > 0) })
  }
  return labels
}

/** A card can go anywhere right of and below the map's edge; the map grows to hold it */
export function keepInMap(point: MapPoint): MapPoint {
  return { x: Math.max(MAP_CARD_WIDTH / 2 + 6, point.x), y: Math.max(MAP_CARD_HEIGHT / 2 + 6, point.y) }
}

/**
 * Cards the user placed stay where they were put; the others take the automatic grid's places in
 * order, skipping any place a placed card covers (extra rows open below when the grid runs out).
 */
export function placeAgentMessageMap(ids: readonly string[], saved: ReadonlyMap<string, MapPoint>, viewportWidth: number, viewportHeight: number) {
  const base = layoutAgentMessageMap(ids, viewportWidth, viewportHeight)
  const positions = new Map<string, MapPoint>()
  const taken: MapPoint[] = []
  for (const id of ids) {
    const point = saved.get(id)
    if (!point) continue
    const kept = keepInMap(point)
    positions.set(id, kept)
    taken.push(kept)
  }
  const slots = [...base.positions.values()]
  const xs = [...new Set(slots.map(slot => slot.x))].sort((a, b) => a - b)
  const ys = [...new Set(slots.map(slot => slot.y))].sort((a, b) => a - b)
  const rowStep = ys.length > 1 ? ys[1] - ys[0] : 174
  const columns = slots.length ? Math.max(...ys.map(y => slots.filter(slot => slot.y === y).length)) : 1
  const fullRow = slots.slice(0, columns).map(slot => slot.x)
  const rowXs = fullRow.length ? fullRow : xs
  for (let row = 1; row <= ids.length; row++) {
    for (const x of rowXs) slots.push({ x, y: (ys[ys.length - 1] ?? rowStep / 2) + row * rowStep })
  }
  const clear = (slot: MapPoint) => taken.every(point =>
    Math.abs(point.x - slot.x) >= MAP_CARD_WIDTH + 16 || Math.abs(point.y - slot.y) >= MAP_CARD_HEIGHT + 16)
  let next = 0
  for (const id of ids) {
    if (positions.has(id)) continue
    while (next < slots.length && !clear(slots[next])) next++
    const slot = slots[next] ?? { x: base.width / 2, y: base.height + rowStep / 2 }
    next++
    positions.set(id, slot)
    taken.push(slot)
  }
  let width = base.width
  let height = base.height
  for (const { x, y } of positions.values()) {
    width = Math.max(width, x + MAP_CARD_WIDTH / 2 + padding)
    height = Math.max(height, y + MAP_CARD_HEIGHT / 2 + padding)
  }
  return { positions, width, height }
}
