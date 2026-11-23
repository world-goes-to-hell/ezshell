import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { RiArrowRightLine, RiFolder3Line } from 'react-icons/ri'
import type { LocalAgentStatus } from '../../types'
import { folderLabel } from '../../lib/localWorkspaceTree'
import {
  clampMessageMapPoint, layoutAgentMessageMap, layoutMessageMapLabels, MAP_CARD_HEIGHT, MAP_CARD_WIDTH, messageMapArrow,
  type agentMessageMap, type MapPoint, type MessageState
} from '../../lib/agentMessageMap'
import { AGENT_PROVIDER_ICONS } from '../ui/agentProviderIcons'

export const MESSAGE_STATE_LABELS: Record<MessageState, string> = {
  unread: '안 읽음', seen: '읽음·답 없음', answered: '답함'
}
const messageStates = ['unread', 'seen', 'answered'] as const

const agentStatuses: Record<LocalAgentStatus | 'reply', string> = {
  unknown: '상태 확인 중', starting: '시작 중', idle: '쉼', working: '작업 중',
  blocked: '승인 대기', error: '오류', ended: '종료', sleeping: '잠듦', reply: '답장 대기'
}

interface Props {
  model: ReturnType<typeof agentMessageMap>
  selectedAgent?: string
  selectedEdge?: string
  onSelectAgent: (id: string) => void
  onSelectEdge: (id: string) => void
}

interface Drag {
  id: string
  pointerId: number
  client: MapPoint
  origin: MapPoint
  moved: boolean
}

export function AgentMessageMap({ model, selectedAgent, selectedEdge, onSelectAgent, onSelectEdge }: Props) {
  const arrowId = useId()
  const viewport = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [movedPositions, setMovedPositions] = useState<Record<string, MapPoint>>({})
  const [dragging, setDragging] = useState<string>()
  const drag = useRef<Drag | null>(null)
  const draggedClick = useRef<string | null>(null)

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const { positions, width, height } = layoutAgentMessageMap(model.nodes.map(({ agent }) => agent.id), size.width, size.height)
  for (const [id, point] of positions) {
    positions.set(id, clampMessageMapPoint(movedPositions[id] ?? point, width, height))
  }
  const labels = layoutMessageMapLabels(model.edges, positions, width, height)

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string, origin: MapPoint) {
    if (event.button !== 0 || !event.isPrimary) return
    draggedClick.current = null
    drag.current = { id, pointerId: event.pointerId, client: { x: event.clientX, y: event.clientY }, origin, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveCard(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current
    const box = canvas.current?.getBoundingClientRect()
    if (!state || state.pointerId !== event.pointerId || !box?.width || !box.height) return
    const dx = event.clientX - state.client.x
    const dy = event.clientY - state.client.y
    if (!state.moved && Math.hypot(dx, dy) < 4) return
    if (!state.moved) setDragging(state.id)
    state.moved = true
    const target = clampMessageMapPoint({ x: state.origin.x + dx * width / box.width, y: state.origin.y + dy * height / box.height }, width, height)
    setMovedPositions(current => ({ ...current, [state.id]: target }))
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    draggedClick.current = state.moved ? state.id : null
    drag.current = null
    setDragging(undefined)
  }

  return (
    <div ref={viewport} className="agent-message-map-viewport" role="region" aria-label="에이전트 관계도" tabIndex={0}>
      {model.nodes.length === 0 ? <p className="agent-message-map-empty">표시할 에이전트가 없습니다.</p> : (
        <div ref={canvas} className="agent-message-map-canvas" style={{ width, height }}>
          <svg className="agent-message-map-lines" width={width} height={height} aria-hidden="true">
            <defs>
              {[false, true].map(highlighted => (
                <marker key={String(highlighted)} id={`${arrowId}-${highlighted}`} viewBox="0 0 10 10"
                  refX={9} refY={5} markerWidth={7} markerHeight={7} markerUnits="userSpaceOnUse" orient="auto">
                  <path className="agent-message-map-arrowhead" data-highlighted={highlighted} d="M 0 0 L 10 5 L 0 10 Z" />
                </marker>
              ))}
            </defs>
            {model.edges.flatMap(edge => edge.directions.map(direction => {
              const from = positions.get(direction.from)!
              const to = positions.get(direction.to)!
              const arrow = messageMapArrow(from, to, edge.directions.length > 1)
              if (!arrow) return null
              const highlighted = selectedEdge === edge.id || direction.states.unread > 0
              return (
                <g key={edge.id + direction.from} data-highlighted={highlighted} onClick={() => onSelectEdge(edge.id)}>
                  <path className="agent-message-map-line" d={arrow.path} markerEnd={`url(#${arrowId}-${highlighted})`} />
                  <path className="agent-message-map-hit" d={arrow.path} />
                </g>
              )
            }))}
          </svg>
          {model.edges.map(edge => {
            const { point, overCard } = labels.get(edge.id)!
            const unread = edge.directions.some(direction => direction.states.unread > 0)
            const description = edge.directions.map(({ from, to, count, states }) =>
              `${from} → ${to}, ${count}개, ${messageStates.map(state => `${MESSAGE_STATE_LABELS[state]} ${states[state]}개`).join(', ')}`).join('\n')
            return (
              <button key={edge.id} type="button" className="agent-message-map-edge" aria-pressed={selectedEdge === edge.id}
                aria-label={description} title={description} data-unread={unread} data-over-card={overCard}
                style={{ left: point.x, top: point.y }} onClick={() => onSelectEdge(edge.id)}>
                {edge.directions.map(({ from, to, count, states }) => {
                  const arrow = messageMapArrow(positions.get(from)!, positions.get(to)!, edge.directions.length > 1)
                  return (
                    <span key={from} className="agent-message-map-direction">
                      <RiArrowRightLine size={13} style={{ transform: `rotate(${arrow?.angle ?? 0}deg)` }} aria-hidden="true" />
                      <strong>{count}</strong>
                      {messageStates.filter(state => states[state]).map(state => (
                        <span key={state} data-state={state}>{state === 'seen' ? '읽음' : MESSAGE_STATE_LABELS[state]} {states[state]}</span>
                      ))}
                    </span>
                  )
                })}
              </button>
            )
          })}
          {model.nodes.map(({ agent, archived }) => {
            const point = positions.get(agent.id)!
            const Icon = AGENT_PROVIDER_ICONS[agent.kind]
            const statusKind = archived ? 'ended' : agent.waitingForReply && agent.status === 'working' ? 'reply' : agent.status
            const status = archived && agent.active ? '연결 끊김' : agentStatuses[statusKind]
            const folder = folderLabel(agent.cwd)
            return (
              <button key={agent.id} type="button" className="agent-message-map-card" aria-pressed={selectedAgent === agent.id}
                data-agent-id={agent.id} data-archived={archived} data-dragging={dragging === agent.id}
                title={`${agent.id} · ${status}\n${agent.cwd}`} style={{ left: point.x, top: point.y, width: MAP_CARD_WIDTH, height: MAP_CARD_HEIGHT }}
                onPointerDown={event => startDrag(event, agent.id, point)} onPointerMove={moveCard}
                onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
                onClick={event => {
                  if (!event.detail || draggedClick.current !== agent.id) onSelectAgent(agent.id)
                  draggedClick.current = null
                }}>
                <span className="agent-message-map-card-name"><Icon className="agent-message-provider" data-kind={agent.kind} size={16} aria-hidden="true" /><strong>{agent.id}</strong></span>
                <span className="agent-message-map-card-status" data-status={statusKind}><i />{status}</span>
                {folder && <span className="agent-message-map-card-folder"><RiFolder3Line size={13} aria-hidden="true" /><span>{folder}</span></span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
