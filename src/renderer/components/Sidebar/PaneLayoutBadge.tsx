import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { layoutOf, type PaneId, type SplitNode } from '../../lib/splitTree'
import { placeTooltip } from '../../lib/tooltipPosition'
import { cellStyle } from '../../lib/paneFocus'
import './PaneMap.css'

const OPEN_DELAY_MS = 150
const CLOSE_DELAY_MS = 220
const MAP_WIDTH = 208
const MAP_HEIGHT = 128

interface PaneLayoutBadgeProps {
  tabName: string
  tree: SplitNode
  /** The pane that has the keyboard now, if this tab is the one in view */
  currentPane: () => PaneId | null
  onPick: (pane: PaneId) => void
}

/**
 * "3세션" on a split tab's row. Pointing at it (or pressing it) shows a small map of how the tab is
 * divided; pressing a pane of the map goes to that pane. Replaces one list row per pane, which said
 * nothing about where each pane is.
 */
export function PaneLayoutBadge({ tabName, tree, currentPane, onPick }: PaneLayoutBadgeProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const [current, setCurrent] = useState<PaneId | null>(null)
  const badgeRef = useRef<HTMLButtonElement>(null)
  const mapRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)

  const layout = layoutOf(tree)
  const count = layout.panes.length

  const openSoon = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setIsOpen(true), OPEN_DELAY_MS)
  }, [])
  const closeSoon = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setIsOpen(false), CLOSE_DELAY_MS)
  }, [])
  const stay = useCallback(() => window.clearTimeout(timer.current), [])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Where the map goes: under the badge, or above it when there is no room (same rule as tooltips)
  useLayoutEffect(() => {
    if (!isOpen || !badgeRef.current || !mapRef.current) return
    setCurrent(currentPane())
    const anchor = badgeRef.current.getBoundingClientRect()
    const size = { width: mapRef.current.offsetWidth, height: mapRef.current.offsetHeight }
    const at = placeTooltip(anchor, size, { width: window.innerWidth, height: window.innerHeight })
    setPlace({ left: at.left, top: at.top })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, tree])

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setIsOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen])

  const pick = (pane: PaneId) => {
    window.clearTimeout(timer.current)
    setIsOpen(false)
    onPick(pane)
  }

  return (
    <>
      <button
        ref={badgeRef}
        type="button"
        className="local-terms-panes"
        aria-expanded={isOpen}
        aria-label={`${tabName}: 분할된 세션 ${count}개, 배치 보기`}
        onPointerEnter={openSoon}
        onPointerLeave={closeSoon}
        onClick={event => { event.stopPropagation(); window.clearTimeout(timer.current); setIsOpen(open => !open) }}
      >
        {count}세션
      </button>
      {isOpen && createPortal(
        // .sidebar-popover: the folded sidebar stays open while this is shown (useSidebarPeek)
        <div
          ref={mapRef}
          className="pane-map sidebar-popover"
          role="dialog"
          aria-label={`${tabName} 의 분할 배치`}
          style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}
          onPointerEnter={stay}
          onPointerLeave={closeSoon}
        >
          <div className="pane-map-title">{tabName} · {count}세션</div>
          <div className="pane-map-area" style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}>
            {layout.vacants.map(({ pane, rect }) => (
              <div
                key={`vacant-${pane}`}
                className="pane-map-cell is-vacant"
                style={cellStyle(rect)}
                aria-hidden="true"
              />
            ))}
            {layout.panes.map(({ pane, rect }, index) => (
              <button
                key={pane}
                type="button"
                className={`pane-map-cell ${pane === current ? 'is-current' : ''}`}
                style={cellStyle(rect)}
                onClick={() => pick(pane)}
                aria-label={`세션 ${index + 1}로 이동${pane === current ? ' (지금 입력 중)' : ''}`}
              >
                <span>{index + 1}</span>
              </button>
            ))}
          </div>
          <div className="pane-map-hint">칸을 누르면 그 세션으로 이동합니다</div>
        </div>,
        document.body
      )}
    </>
  )
}
