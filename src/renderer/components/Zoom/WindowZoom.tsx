import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_ZOOM, createWheelStepper, stepZoom } from '../../lib/appZoom'
import { readWindowZoom, writeWindowZoom, type ZoomWindowKind } from '../../lib/windowZoom'
import { ZoomBubble } from './ZoomHud'

/**
 * The UI zoom of a detached window: Ctrl + wheel anywhere in it changes this window only, and the
 * zoom is kept for the next window of the same kind (lib/windowZoom.ts). Shows the same bubble as
 * the main window. Mount once per detached window.
 */
export function WindowZoom({ kind }: { kind: ZoomWindowKind }) {
  const [zoom, setZoom] = useState(() => readWindowZoom(kind))

  useEffect(() => {
    window.electronAPI.setAppZoomFactor?.(zoom)
  }, [zoom])

  const change = useCallback((next: number) => {
    setZoom(next)
    writeWindowZoom(kind, next)
  }, [kind])

  const zoomBy = useCallback((direction: 1 | -1) => {
    setZoom(current => {
      const next = stepZoom(current, direction)
      writeWindowZoom(kind, next)
      return next
    })
  }, [kind])

  useEffect(() => {
    const toStep = createWheelStepper()
    // Capture phase: the editors and lists below must not scroll (or do anything else) on Ctrl + wheel
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      const direction = toStep(event.deltaY)
      if (direction !== 0) zoomBy(direction)
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [zoomBy])

  return <ZoomBubble zoom={zoom} onZoom={zoomBy} onReset={() => change(DEFAULT_ZOOM)} />
}
