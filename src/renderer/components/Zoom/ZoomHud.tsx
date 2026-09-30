import { useEffect, useRef, useState } from 'react'
import { RiSubtractLine, RiAddLine } from 'react-icons/ri'
import { useUIStore } from '../../stores/uiStore'
import { isDefaultZoom, toZoomPercent, ZOOM_STEPS } from '../../lib/appZoom'
import { resetZoom, zoomBy } from '../../hooks/useAppZoom'
import './Zoom.css'

const VISIBLE_MS = 1500
const MIN_ZOOM = ZOOM_STEPS[0]
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]

/**
 * Short-lived "UI 배율 125%" panel shown whenever the zoom changes,
 * like a browser's zoom bubble. Stays open while hovered.
 */
export function ZoomHud() {
  const appZoom = useUIStore(state => state.appZoom)
  const [isVisible, setIsVisible] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const previousZoom = useRef(appZoom)

  useEffect(() => {
    // Only react to changes, not to the value restored at startup
    if (previousZoom.current === appZoom) return
    previousZoom.current = appZoom
    setIsVisible(true)
  }, [appZoom])

  useEffect(() => {
    if (!isVisible || isHovered) return
    const timer = setTimeout(() => setIsVisible(false), VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [isVisible, isHovered, appZoom])

  if (!isVisible) return null

  const percent = toZoomPercent(appZoom)

  return (
    <div
      className="zoom-hud"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <span className="zoom-hud-label">UI 배율</span>
      <span className="zoom-hud-value">{percent}%</span>
      <div className="zoom-hud-actions">
        <button type="button" onClick={() => zoomBy(-1)} disabled={appZoom <= MIN_ZOOM} aria-label="축소" title="축소 (Ctrl+휠 아래)">
          <RiSubtractLine size={14} />
        </button>
        <button type="button" onClick={() => zoomBy(1)} disabled={appZoom >= MAX_ZOOM} aria-label="확대" title="확대 (Ctrl+휠 위)">
          <RiAddLine size={14} />
        </button>
        <button type="button" className="zoom-hud-reset" onClick={resetZoom} disabled={isDefaultZoom(appZoom)}>
          100%
        </button>
      </div>
    </div>
  )
}
