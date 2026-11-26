// The effect windows outside the app (pointer-effects.ts) only get the positions main reads about every
// 16ms (src/globalPointerEffects.js), where the app gets every pointermove. A fast pointer then left its
// particles in clumps at those positions and bent the trails into straight pieces. The points between two
// positions are filled here, on a curve that keeps the direction the pointer came from, and handed to the
// same addMove the app uses: its distance rules still decide what is added. The app does not use this.
import { addMove, DESKTOP_TRAIL_CAP, MOVE_DISTANCE, type EffectState, type GhostCursor } from './pointerEffects'
import type { EffectLevel, MoveEffect } from './pointerPrefs'

/** Further than this between two positions is a jump (moved by a program, another monitor): not filled */
export const FILL_MAX_DISTANCE = 600
/** The most points one position adds between itself and the one before */
export const FILL_MAX_POINTS = 32
/** The trails add every point, and their limit is the number of points: fewer, further apart */
export const TRAIL_FILL_MAX_POINTS = 8
export const TRAIL_SPACING = 10
/** The filled points take times from at most this long before the new position (the pointer may have rested) */
export const FILL_MAX_GAP_MS = 40
/** The direction the pointer came from counts only when the position before was read this recently */
const TURN_MAX_GAP_MS = 100

export interface FillSample { x: number; y: number; t: number }
export interface FillTrack { prev: FillSample | null; before: FillSample | null }

export const createFillTrack = (): FillTrack => ({ prev: null, before: null })

/** After leave, clear or new settings: the next position starts fresh */
export function resetFill(track: FillTrack): void {
  track.prev = track.before = null
}

const isTrail = (effect: MoveEffect) => effect === 'rainbow' || effect === 'comet'

/**
 * A quarter of the effect distance: addMove adds when the distance since its last particles passes it, so
 * the particles come about every 1.25 distances, near the app's pointermove a few pixels apart
 */
export const FILL_DIVISIONS = 4

function spacing(effect: MoveEffect): number {
  if (isTrail(effect)) return TRAIL_SPACING
  return effect in MOVE_DISTANCE ? MOVE_DISTANCE[effect as keyof typeof MOVE_DISTANCE] / FILL_DIVISIONS : 0
}

/**
 * The points strictly between the last position and (x, y), with times spread before `now`. Cubic
 * Hermite: it leaves the last position along the direction from the one before it (only if that was
 * read just before) and arrives along the straight step, so a turn becomes a bend, not a corner.
 */
export function fillPoints(track: FillTrack, effect: MoveEffect | 'none', x: number, y: number, now: number): FillSample[] {
  const { prev, before } = track
  if (!prev || effect === 'none') return []
  const step = spacing(effect)
  const dx = x - prev.x
  const dy = y - prev.y
  const distance = Math.hypot(dx, dy)
  if (!step || distance > FILL_MAX_DISTANCE) return []
  const count = Math.min(isTrail(effect) ? TRAIL_FILL_MAX_POINTS : FILL_MAX_POINTS, Math.ceil(distance / step) - 1)
  if (count <= 0) return []
  // The leaving direction, as long as the step itself so the curve cannot swing far out
  let mx = dx
  let my = dy
  if (before && prev.t - before.t <= TURN_MAX_GAP_MS) {
    const tx = x - before.x
    const ty = y - before.y
    const length = Math.hypot(tx, ty)
    if (length > 0) { mx = tx / length * distance; my = ty / length * distance }
  }
  const gap = Math.max(0, Math.min(now - prev.t, FILL_MAX_GAP_MS))
  const points: FillSample[] = []
  for (let i = 1; i <= count; i++) {
    const s = i / (count + 1)
    const s2 = s * s
    const s3 = s2 * s
    const h00 = 2 * s3 - 3 * s2 + 1
    const h10 = s3 - 2 * s2 + s
    const h01 = -2 * s3 + 3 * s2
    const h11 = s3 - s2
    points.push({
      x: h00 * prev.x + h10 * mx + h01 * x + h11 * dx,
      y: h00 * prev.y + h10 * my + h01 * y + h11 * dy,
      t: now - gap * (1 - s)
    })
  }
  return points
}

/** One position read outside the app: the points before it, then the position itself */
export function addDesktopMove(S: EffectState, track: FillTrack, effect: MoveEffect | 'none', x: number, y: number, now: number,
  level: EffectLevel, ink: string, dark: boolean, ghost?: () => GhostCursor | null): void {
  if (effect !== 'none') {
    for (const point of fillPoints(track, effect, x, y, now)) {
      addMove(S, effect, point.x, point.y, point.t, level, ink, dark, true, ghost, DESKTOP_TRAIL_CAP)
    }
    addMove(S, effect, x, y, now, level, ink, dark, true, ghost, DESKTOP_TRAIL_CAP)
  }
  track.before = track.prev
  track.prev = { x, y, t: now }
}
