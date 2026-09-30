import { RiZoomInLine } from 'react-icons/ri'
import { useUIStore } from '../../stores/uiStore'
import { isDefaultZoom, toZoomPercent } from '../../lib/appZoom'
import { resetZoom, supportsZoomFactor } from '../../hooks/useAppZoom'
import './Zoom.css'

/** Current UI zoom in the status bar; highlighted when not 100%, click to reset. */
export function ZoomStatus() {
  const appZoom = useUIStore(state => state.appZoom)
  // Without the new preload API the real factor is unknown, so showing a number would mislead
  if (!supportsZoomFactor()) return null

  const percent = toZoomPercent(appZoom)
  const isDefault = isDefaultZoom(appZoom)
  const title = isDefault
    ? 'UI 배율 100% · Ctrl+마우스 휠로 조정'
    : `UI 배율 ${percent}% · 클릭하면 100%로 되돌립니다`

  return (
    <button
      type="button"
      className={`zoom-status ${isDefault ? '' : 'changed'}`}
      onClick={isDefault ? undefined : resetZoom}
      aria-disabled={isDefault}
      title={title}
      aria-label={title}
    >
      <RiZoomInLine size={14} />
      <span>{percent}%</span>
    </button>
  )
}
