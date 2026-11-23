// Zoom and pan of the agent message map. The map draws in its own coordinates (cards' centers);
// on screen a point is `map * zoom + offset`, inside the map's viewport.
import { clampZoom, MAX_ZOOM, MIN_ZOOM } from './agentMapLayout'
import { MAP_CARD_HEIGHT, MAP_CARD_WIDTH, type MapPoint } from './agentMessageMap'

export interface MapView { zoom: number; x: number; y: number }
export interface MapBounds { left: number; top: number; right: number; bottom: number }
export interface Size { width: number; height: number }

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const
const FIT_PADDING = 24
/** Fitting never blows the cards up past their own size */
const FIT_MAX_ZOOM = 1
/** A pan cannot leave less than this much of the cards in view */
const KEEP_VISIBLE = 48

/** The next step up (+1) or down (-1) from a zoom that may sit between steps */
export function zoomStep(zoom: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find(step => step > zoom + 0.001) ?? MAX_ZOOM
  return [...ZOOM_STEPS].reverse().find(step => step < zoom - 0.001) ?? MIN_ZOOM
}

/** Zooms keeping the map point under `anchor` (viewport pixels) where it is */
export function zoomAround(view: MapView, zoom: number, anchor: MapPoint): MapView {
  const next = clampZoom(zoom)
  const mapX = (anchor.x - view.x) / view.zoom
  const mapY = (anchor.y - view.y) / view.zoom
  return { zoom: next, x: anchor.x - mapX * next, y: anchor.y - mapY * next }
}

/** The area the cards cover (their centers plus half a card) */
export function cardBounds(points: Iterable<MapPoint>): MapBounds | null {
  let bounds: MapBounds | null = null
  for (const { x, y } of points) {
    const box = { left: x - MAP_CARD_WIDTH / 2, top: y - MAP_CARD_HEIGHT / 2, right: x + MAP_CARD_WIDTH / 2, bottom: y + MAP_CARD_HEIGHT / 2 }
    bounds = bounds ? {
      left: Math.min(bounds.left, box.left), top: Math.min(bounds.top, box.top),
      right: Math.max(bounds.right, box.right), bottom: Math.max(bounds.bottom, box.bottom)
    } : box
  }
  return bounds
}

/** Centers the bounds at a zoom */
export function centerView(bounds: MapBounds, viewport: Size, zoom: number): MapView {
  const z = clampZoom(zoom)
  return {
    zoom: z,
    x: viewport.width / 2 - (bounds.left + bounds.right) / 2 * z,
    y: viewport.height / 2 - (bounds.top + bounds.bottom) / 2 * z
  }
}

/** 화면에 맞추기: every card in view, at most at 100% */
export function fitView(bounds: MapBounds, viewport: Size): MapView {
  const width = Math.max(1, bounds.right - bounds.left)
  const height = Math.max(1, bounds.bottom - bounds.top)
  const zoom = Math.min(FIT_MAX_ZOOM, (viewport.width - FIT_PADDING * 2) / width, (viewport.height - FIT_PADDING * 2) / height)
  return centerView(bounds, viewport, zoom)
}

/** Keeps some of the cards in view however far the map is dragged */
export function clampPan(view: MapView, bounds: MapBounds | null, viewport: Size): MapView {
  if (!bounds) return view
  const keepX = Math.min(KEEP_VISIBLE, (bounds.right - bounds.left) * view.zoom)
  const keepY = Math.min(KEEP_VISIBLE, (bounds.bottom - bounds.top) * view.zoom)
  const x = Math.min(viewport.width - keepX - bounds.left * view.zoom, Math.max(keepX - bounds.right * view.zoom, view.x))
  const y = Math.min(viewport.height - keepY - bounds.top * view.zoom, Math.max(keepY - bounds.bottom * view.zoom, view.y))
  return { ...view, x, y }
}
