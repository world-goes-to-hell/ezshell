import { useEffect } from 'react'
import { useUIStore } from '../stores/uiStore'
import { createWheelStepper, normalizeZoom, stepZoom, DEFAULT_ZOOM, type ZoomDirection } from '../lib/appZoom'

/**
 * The factor API is new in the preload script, which only reloads with the app.
 * Until then the old half-level zoom keeps working, just without a known percentage.
 */
export function supportsZoomFactor(): boolean {
  const api = window.electronAPI
  return typeof api?.setAppZoomFactor === 'function' && typeof api?.getAppZoomFactor === 'function'
}

export function zoomBy(direction: ZoomDirection): void {
  if (!supportsZoomFactor()) {
    if (direction > 0) window.electronAPI.appZoomIn?.()
    else window.electronAPI.appZoomOut?.()
    return
  }
  const { appZoom, setAppZoom } = useUIStore.getState()
  setAppZoom(stepZoom(appZoom, direction))
}

export function resetZoom(): void {
  if (!supportsZoomFactor()) {
    window.electronAPI.appZoomReset?.()
    return
  }
  useUIStore.getState().setAppZoom(DEFAULT_ZOOM)
}

/** Applies the stored UI zoom and handles Ctrl + mouse wheel. Mount once, at the app root. */
export function useAppZoom(): void {
  const appZoom = useUIStore(state => state.appZoom)

  // The store already adopted any zoom Chromium kept (see uiStore), so this only applies it
  useEffect(() => {
    if (!supportsZoomFactor()) return
    window.electronAPI.setAppZoomFactor!(normalizeZoom(appZoom))
  }, [appZoom])

  useEffect(() => {
    const toStep = createWheelStepper()
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const direction = toStep(e.deltaY)
      if (direction !== 0) zoomBy(direction)
    }
    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, [])
}
