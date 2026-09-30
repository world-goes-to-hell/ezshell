/** Same presets as Chromium's page zoom, so the percentages look familiar */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const
export const DEFAULT_ZOOM = 1

const MIN_ZOOM = ZOOM_STEPS[0]
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]
/** Factors read back from Chromium carry float noise (1.1000000001) */
const EPSILON = 0.001
/** A mouse wheel notch is 100; precision touchpads send many small deltas */
const WHEEL_STEP_THRESHOLD = 50
/** Leftover deltas from an earlier gesture must not complete a later one */
const WHEEL_IDLE_RESET_MS = 250

export type ZoomDirection = 1 | -1

/** Next preset above (1) or below (-1) `current`; off-grid values snap to the next preset. */
export function stepZoom(current: number, direction: ZoomDirection): number {
  if (direction > 0) {
    return ZOOM_STEPS.find(step => step > current + EPSILON) ?? MAX_ZOOM
  }
  return [...ZOOM_STEPS].reverse().find(step => step < current - EPSILON) ?? MIN_ZOOM
}

/** A usable zoom factor from stored data, clamped to the supported range. */
export function normalizeZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

/** Nearest preset, so stored values never carry float noise or old off-grid factors. */
export function snapZoom(value: unknown): number {
  const factor = normalizeZoom(value)
  return ZOOM_STEPS.reduce<number>(
    (nearest, step) => (Math.abs(step - factor) < Math.abs(nearest - factor) ? step : nearest),
    DEFAULT_ZOOM
  )
}

/**
 * Zoom to start with: the stored value, or, before anything was ever stored,
 * the zoom Chromium kept from the old implementation (`actual`, if known).
 */
export function resolveInitialZoom(stored: unknown, actual: number | undefined): number {
  if (stored !== undefined || actual === undefined) return snapZoom(stored)
  return snapZoom(actual)
}

export function toZoomPercent(factor: number): number {
  return Math.round(factor * 100)
}

export function isDefaultZoom(factor: number): boolean {
  return Math.abs(factor - DEFAULT_ZOOM) < EPSILON
}

/**
 * Converts wheel deltas into zoom steps: 1 (in), -1 (out) or 0 (keep accumulating).
 * At most one step per event, so a fast flick cannot skip presets.
 */
export function createWheelStepper(
  threshold: number = WHEEL_STEP_THRESHOLD
): (deltaY: number, now?: number) => ZoomDirection | 0 {
  let accumulated = 0
  let lastEventAt = Number.NEGATIVE_INFINITY
  return (deltaY, now = Date.now()) => {
    if (deltaY === 0) return 0
    if (now - lastEventAt > WHEEL_IDLE_RESET_MS) accumulated = 0
    lastEventAt = now
    // Scrolling up (negative deltaY) zooms in, like browsers
    const sameDirection = Math.sign(deltaY) === Math.sign(accumulated)
    accumulated = sameDirection ? accumulated + deltaY : deltaY
    if (Math.abs(accumulated) < threshold) return 0
    const direction: ZoomDirection = accumulated < 0 ? 1 : -1
    accumulated = 0
    return direction
  }
}
