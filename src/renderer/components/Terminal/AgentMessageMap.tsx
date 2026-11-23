import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import {
  RiArrowRightLine, RiFocus3Line, RiFolder3Line, RiLayoutRightLine, RiLayoutRight2Line, RiRefreshLine, RiZoomInLine, RiZoomOutLine
} from 'react-icons/ri'
import { folderLabel } from '../../lib/localWorkspaceTree'
import { agentIdentityColor, agentIdentityStatus, agentIdentityTooltip, type AgentPaneLocation } from '../../lib/agentIdentity'
import {
  keepInMap, layoutMessageMapLabels, MAP_CARD_HEIGHT, MAP_CARD_WIDTH, messageMapArrow, placeAgentMessageMap,
  type agentMessageMap, type MapPoint, type MessageState
} from '../../lib/agentMessageMap'
import {
  clearCards, isLayoutKey, MAX_ZOOM, MIN_ZOOM, readMapLayout, saveCard, saveZoom, touchCards, writeMapLayout, type MapLayout
} from '../../lib/agentMapLayout'
import { cardBounds, centerView, clampPan, fitView, zoomAround, zoomStep, type MapView } from '../../lib/agentMapView'
import { createWheelStepper } from '../../lib/appZoom'
import { AGENT_PROVIDER_ICONS } from '../ui/agentProviderIcons'
import { AgentIdentityAction, AgentIdentityDot } from '../ui/AgentIdentity'

export const MESSAGE_STATE_LABELS: Record<MessageState, string> = {
  unread: '안 읽음', seen: '읽음·답 없음', answered: '답함'
}
const messageStates = ['unread', 'seen', 'answered'] as const

/**
 * Cards placed by an agent that has no conversation key yet (it has not reported its session): kept
 * for this run by agent id, per scope, and moved to the stored layout once the key arrives.
 */
const sessionPositions = new Map<string, Map<string, MapPoint>>()

interface Props {
  model: ReturnType<typeof agentMessageMap>
  /** The project or folder the map shows: positions and zoom are kept per scope */
  scope: string
  selectedAgent?: string
  selectedEdge?: string
  locations: ReadonlyMap<string, AgentPaneLocation>
  detailOpen: boolean
  onToggleDetail: () => void
  onSelectAgent: (id: string) => void
  onSelectEdge: (id: string) => void
  onEditRole: (id: string) => void
  onGoToPane: (id: string) => void
}

interface Drag {
  id: string
  pointerId: number
  client: MapPoint
  origin: MapPoint
  moved: boolean
}

interface Pan { pointerId: number; client: MapPoint; start: MapView }

const CARD_STEP = 16
const PAN_STEP = 48
const ZOOM_SAVE_DELAY_MS = 400

export function AgentMessageMap({ model, scope, selectedAgent, selectedEdge, locations, detailOpen, onToggleDetail, onSelectAgent, onSelectEdge, onEditRole, onGoToPane }: Props) {
  const arrowId = useId()
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [layout, setLayout] = useState<MapLayout>(() => readMapLayout())
  const [livePosition, setLivePosition] = useState<{ id: string; point: MapPoint } | null>(null)
  const [, setSessionRevision] = useState(0)
  const [view, setView] = useState<MapView | null>(null)
  const [dragging, setDragging] = useState<string>()
  const [panning, setPanning] = useState(false)
  const drag = useRef<Drag | null>(null)
  const pan = useRef<Pan | null>(null)
  const draggedClick = useRef<string | null>(null)
  const zoomSave = useRef<ReturnType<typeof setTimeout>>(undefined)

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const updateLayout = (change: (current: MapLayout) => MapLayout) => {
    setLayout(current => {
      const next = change(current)
      if (next !== current) writeMapLayout(next)
      return next
    })
  }

  // Where each card was put: by its conversation key, or (no key yet) by agent id for this run
  const scopeCards = layout.scopes[scope]?.cards ?? {}
  const scopeSession = sessionPositions.get(scope)
  const saved = new Map<string, MapPoint>()
  for (const { agent } of model.nodes) {
    const stored = isLayoutKey(agent.layoutKey) ? scopeCards[agent.layoutKey] : undefined
    const point = stored ?? scopeSession?.get(agent.id)
    if (point) saved.set(agent.id, { x: point.x, y: point.y })
  }
  if (livePosition) saved.set(livePosition.id, livePosition.point)
  const ids = model.nodes.map(({ agent }) => agent.id)
  const { positions, width, height } = placeAgentMessageMap(ids, saved, size.width, size.height)
  const labels = layoutMessageMapLabels(model.edges, positions, width, height)
  const bounds = cardBounds(positions.values())
  const viewRef = useRef({ view, bounds, size })
  viewRef.current = { view, bounds, size }

  // A key that arrived moves the run's position into the stored layout; keys still in use stay fresh
  const keyed = model.nodes.flatMap(({ agent }) => isLayoutKey(agent.layoutKey) ? [`${agent.id}=${agent.layoutKey}`] : []).join(',')
  useEffect(() => {
    const now = Date.now()
    const session = sessionPositions.get(scope)
    const keys: string[] = []
    const moves: [string, MapPoint][] = []
    for (const { agent } of model.nodes) {
      if (!isLayoutKey(agent.layoutKey)) continue
      keys.push(agent.layoutKey)
      const point = session?.get(agent.id)
      if (point) {
        moves.push([agent.layoutKey, point])
        session!.delete(agent.id)
      }
    }
    updateLayout(value => touchCards(moves.reduce((next, [key, point]) => saveCard(next, scope, key, point, now), value), scope, keys, now))
    if (moves.length) setSessionRevision(revision => revision + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, keyed])

  // Opening (and a resized viewport): the saved zoom centered on the cards, or everything fitted.
  // Where the map was dragged is not kept.
  const placedFor = useRef('')
  useLayoutEffect(() => {
    if (!size.width || !size.height) return
    const key = `${scope}|${size.width}x${size.height}|${bounds ? 'cards' : 'empty'}`
    if (placedFor.current === key) return
    placedFor.current = key
    const zoom = layout.scopes[scope]?.zoom
    if (!bounds) { setView({ zoom: zoom ?? 1, x: 0, y: 0 }); return }
    setView(zoom ? centerView(bounds, size, zoom) : fitView(bounds, size))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, size.width, size.height, Boolean(bounds)])

  const current = view ?? { zoom: 1, x: 0, y: 0 }

  const rememberZoom = (zoom: number) => {
    clearTimeout(zoomSave.current)
    zoomSave.current = setTimeout(() => updateLayout(value => saveZoom(value, scope, zoom, Date.now())), ZOOM_SAVE_DELAY_MS)
  }
  useEffect(() => () => clearTimeout(zoomSave.current), [])

  const zoomTo = (zoom: number, anchor?: MapPoint) => {
    const { view: latest, bounds: area, size: box } = viewRef.current
    const base = latest ?? { zoom: 1, x: 0, y: 0 }
    const next = clampPan(zoomAround(base, zoom, anchor ?? { x: box.width / 2, y: box.height / 2 }), area, box)
    setView(next)
    rememberZoom(next.zoom)
  }
  const fit = () => {
    const { bounds: area, size: box } = viewRef.current
    if (!area || !box.width) return
    const next = fitView(area, box)
    setView(next)
    rememberZoom(next.zoom)
  }
  const resetLayout = () => {
    sessionPositions.delete(scope)
    updateLayout(value => clearCards(value, scope))
    setSessionRevision(revision => revision + 1)
    placedFor.current = ''
    // The automatic places come back on the next render; fit them then
    requestAnimationFrame(() => fit())
  }

  // Ctrl + wheel zooms around the pointer (before the app's own Ctrl + wheel zoom hears it); the
  // wheel alone moves the map
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const toStep = createWheelStepper()
    const onWheel = (event: WheelEvent) => {
      const { view: latest, bounds: area, size: box } = viewRef.current
      if (!latest) return
      event.preventDefault()
      event.stopPropagation()
      if (event.ctrlKey || event.metaKey) {
        const direction = toStep(event.deltaY)
        if (!direction) return
        const rect = element.getBoundingClientRect()
        zoomTo(zoomStep(latest.zoom, direction), { x: event.clientX - rect.left, y: event.clientY - rect.top })
        return
      }
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY
      setView(clampPan({ ...latest, x: latest.x - dx, y: latest.y - dy }, area, box))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const persistCard = (id: string, point: MapPoint) => {
    const agent = model.nodes.find(node => node.agent.id === id)?.agent
    if (!agent) return
    if (isLayoutKey(agent.layoutKey)) {
      const key = agent.layoutKey
      updateLayout(value => saveCard(value, scope, key, point, Date.now()))
    } else {
      let session = sessionPositions.get(scope)
      if (!session) { session = new Map(); sessionPositions.set(scope, session) }
      session.set(id, point)
      setSessionRevision(revision => revision + 1)
    }
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, id: string, origin: MapPoint) {
    if (event.button !== 0 || !event.isPrimary) return
    draggedClick.current = null
    drag.current = { id, pointerId: event.pointerId, client: { x: event.clientX, y: event.clientY }, origin, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveCard(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    const dx = event.clientX - state.client.x
    const dy = event.clientY - state.client.y
    if (!state.moved && Math.hypot(dx, dy) < 4) return
    if (!state.moved) setDragging(state.id)
    state.moved = true
    const zoom = viewRef.current.view?.zoom ?? 1
    setLivePosition({ id: state.id, point: keepInMap({ x: state.origin.x + dx / zoom, y: state.origin.y + dy / zoom }) })
  }

  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    draggedClick.current = state.moved ? state.id : null
    drag.current = null
    setDragging(undefined)
    if (state.moved) {
      const zoom = viewRef.current.view?.zoom ?? 1
      persistCard(state.id, keepInMap({
        x: state.origin.x + (event.clientX - state.client.x) / zoom,
        y: state.origin.y + (event.clientY - state.client.y) / zoom
      }))
    }
    setLivePosition(null)
  }

  /** Alt + arrow keys move the focused card (Shift: farther), the keyboard's way to drag */
  function moveCardByKey(event: KeyboardEvent<HTMLButtonElement>, id: string, point: MapPoint) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return
    const step = event.shiftKey ? CARD_STEP * 4 : CARD_STEP
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    persistCard(id, keepInMap({ x: point.x + delta[0], y: point.y + delta[1] }))
  }

  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || !view) return
    const target = event.target as Element
    if (target.closest('.agent-message-map-card, .agent-message-map-edge, .agent-message-map-controls, .agent-message-map-hit')) return
    pan.current = { pointerId: event.pointerId, client: { x: event.clientX, y: event.clientY }, start: view }
    event.currentTarget.setPointerCapture(event.pointerId)
    setPanning(true)
  }
  function movePan(event: PointerEvent<HTMLDivElement>) {
    const state = pan.current
    if (!state || state.pointerId !== event.pointerId) return
    const { bounds: area, size: box } = viewRef.current
    setView(clampPan({ ...state.start, x: state.start.x + event.clientX - state.client.x, y: state.start.y + event.clientY - state.client.y }, area, box))
  }
  function endPan(event: PointerEvent<HTMLDivElement>) {
    if (pan.current?.pointerId !== event.pointerId) return
    pan.current = null
    setPanning(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const action = event.key === '0' ? 'fit' : event.key === '=' || event.key === '+' ? 'in' : event.key === '-' ? 'out' : null
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      if (action === 'fit') fit()
      else zoomTo(zoomStep(current.zoom, action === 'in' ? 1 : -1))
      return
    }
    // Arrow keys move the map while the map itself (not a card) has the focus
    if (event.target !== event.currentTarget || event.altKey || event.shiftKey) return
    const delta = { ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] }[event.key]
    if (!delta) return
    event.preventDefault()
    setView(clampPan({ ...current, x: current.x + delta[0], y: current.y + delta[1] }, bounds, size))
  }

  const percent = Math.round(current.zoom * 100)
  const hasCustomPlaces = Object.keys(scopeCards).length > 0 || Boolean(scopeSession?.size)
  const DetailIcon = detailOpen ? RiLayoutRight2Line : RiLayoutRightLine
  const detailLabel = detailOpen ? '메시지 패널 접기' : '메시지 패널 펼치기'

  return (
    <div ref={viewport} className="agent-message-map-viewport" role="region" aria-label="에이전트 관계도"
      aria-description="빈 곳을 끌어 옮기고 Ctrl+휠로 확대·축소합니다. 카드는 끌거나 Alt+방향키로 옮깁니다."
      tabIndex={0} data-panning={panning} onKeyDown={onKeyDown}
      onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}>
      {model.nodes.length === 0 ? <p className="agent-message-map-empty">표시할 에이전트가 없습니다.</p> : (
        <div className="agent-message-map-canvas" data-zoom={current.zoom}
          style={{ width, height, visibility: view ? undefined : 'hidden', transform: `translate(${current.x}px, ${current.y}px) scale(${current.zoom})` }}>
          <svg className="agent-message-map-lines" width={width} height={height} aria-hidden="true">
            <defs>
              {model.nodes.map(({ agent }) => (
                <marker key={agent.id} id={`${arrowId}-${agent.id}`} viewBox="0 0 10 10" style={{ color: agentIdentityColor(agent.id) }}
                  refX={9} refY={5} markerWidth={7} markerHeight={7} markerUnits="userSpaceOnUse" orient="auto">
                  <path fill="currentColor" d="M 0 0 L 10 5 L 0 10 Z" />
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
                <g key={edge.id + direction.from} data-highlighted={highlighted} style={{ color: agentIdentityColor(direction.from) }} onClick={() => onSelectEdge(edge.id)}>
                  <path className="agent-message-map-line" d={arrow.path} markerEnd={`url(#${arrowId}-${direction.from})`} />
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
                      <RiArrowRightLine size={13} style={{ transform: `rotate(${arrow?.angle ?? 0}deg)`, color: agentIdentityColor(from) }} aria-hidden="true" />
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
            const { status, label } = agentIdentityStatus(agent, archived)
            const location = locations.get(agent.id)
            const context = location?.tabLabel || folderLabel(agent.cwd)
            const tooltip = agentIdentityTooltip(agent, location, archived)
            return (
              <div key={agent.id} className="agent-message-map-card" data-selected={selectedAgent === agent.id}
                data-agent-id={agent.id} data-archived={archived} data-dragging={dragging === agent.id} data-placed={saved.has(agent.id)}
                style={{ left: point.x, top: point.y, width: MAP_CARD_WIDTH, height: MAP_CARD_HEIGHT }}>
                <button type="button" className="agent-message-map-card-pick" aria-pressed={selectedAgent === agent.id}
                  {...tooltip} aria-label={tooltip.title.replace(/\n/g, ', ')}
                  onPointerDown={event => startDrag(event, agent.id, point)} onPointerMove={moveCard}
                  onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
                  onKeyDown={event => moveCardByKey(event, agent.id, point)}
                  onClick={event => {
                    if (!event.detail || draggedClick.current !== agent.id) onSelectAgent(agent.id)
                    draggedClick.current = null
                  }}>
                  <span className="agent-message-map-card-name">
                    <Icon className="agent-message-provider" data-kind={agent.kind} size={16} aria-hidden="true" />
                    <strong>{agent.role || agent.id}</strong>
                  </span>
                  <span className="agent-message-map-card-meta">
                    <AgentIdentityDot id={agent.id} />
                    {agent.role && agent.role !== agent.id && <small>{agent.id}</small>}
                    <span className="agent-message-map-card-status" data-status={status}><i />{label}</span>
                  </span>
                  {context && <span className="agent-message-map-card-folder">
                    <RiFolder3Line size={13} aria-hidden="true" /><span>{context}</span>
                    {location && <small>칸 {location.number}</small>}
                  </span>}
                </button>
                <div className="agent-message-map-card-actions">
                  <AgentIdentityAction id={agent.id} action="edit" onClick={() => onEditRole(agent.id)} />
                  {agent.active && location && <AgentIdentityAction id={agent.id} action="go" onClick={() => onGoToPane(agent.id)} />}
                </div>
              </div>
            )
          })}
        </div>
      )}
      <div className="agent-message-map-controls" role="toolbar" aria-label="관계도 보기">
        <button type="button" aria-label="축소" title="축소 (Ctrl+-)" disabled={current.zoom <= MIN_ZOOM} onClick={() => zoomTo(zoomStep(current.zoom, -1))}>
          <RiZoomOutLine size={15} aria-hidden="true" />
        </button>
        <button type="button" className="agent-message-map-zoom" aria-label={`배율 ${percent}%, 눌러서 100%로`} title="100%로" onClick={() => zoomTo(1)}>
          {percent}%
        </button>
        <button type="button" aria-label="확대" title="확대 (Ctrl+=)" disabled={current.zoom >= MAX_ZOOM} onClick={() => zoomTo(zoomStep(current.zoom, 1))}>
          <RiZoomInLine size={15} aria-hidden="true" />
        </button>
        <button type="button" aria-label="화면에 맞추기" title="화면에 맞추기 (Ctrl+0)" disabled={!bounds} onClick={fit}>
          <RiFocus3Line size={15} aria-hidden="true" />
        </button>
        <button type="button" aria-label="배치 초기화" title="옮긴 카드를 자동 배치로 되돌리기" disabled={!hasCustomPlaces} onClick={resetLayout}>
          <RiRefreshLine size={15} aria-hidden="true" />
        </button>
        <span className="agent-message-map-controls-sep" aria-hidden="true" />
        <button type="button" aria-label={detailLabel} title={detailLabel} onClick={onToggleDetail}>
          <DetailIcon size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
