import { RiZoomInLine } from 'react-icons/ri'
import { useUIStore } from '../../stores/uiStore'
import { ZOOM_STEPS, toZoomPercent } from '../../lib/appZoom'
import { resetZoom, supportsZoomFactor } from '../../hooks/useAppZoom'
import { StatusRange } from '../Footer/StatusRange'

const presetPercent = (index: number) => toZoomPercent(ZOOM_STEPS[index])

export function ZoomStatus({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const appZoom = useUIStore(state => state.appZoom)
  const setAppZoom = useUIStore(state => state.setAppZoom)
  // Without the new preload API the real factor is unknown, so showing a number would mislead
  if (!supportsZoomFactor()) return null

  return (
    <StatusRange label="UI 배율" icon={<RiZoomInLine size={14} aria-hidden="true" />}
      open={open} onOpenChange={onOpenChange} value={ZOOM_STEPS.findIndex(step => step === appZoom)}
      min={0} max={ZOOM_STEPS.length - 1} toPercent={presetPercent} commitOnRelease
      onValueChange={index => setAppZoom(ZOOM_STEPS[index])} onReset={resetZoom} />
  )
}
