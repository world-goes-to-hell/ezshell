import { describe, expect, it } from 'vitest'
import { addMove, createEffectState, DESKTOP_TRAIL_CAP, MOVE_DISTANCE, type GhostCursor } from './pointerEffects'
import {
  addDesktopMove, createFillTrack, FILL_DIVISIONS, FILL_MAX_DISTANCE, FILL_MAX_GAP_MS, FILL_MAX_POINTS, fillPoints, resetFill,
  TRAIL_FILL_MAX_POINTS, TRAIL_SPACING
} from './pointerFill'

const arrow: GhostCursor = { image: { complete: true, naturalWidth: 32 } as HTMLImageElement, hotspot: [2, 2] }

/** The positions main reads, one every `gap` ms, then the particles of the effect window outside the app */
function desktop(effect: Parameters<typeof addDesktopMove>[2], points: [number, number][], gap = 16) {
  const state = createEffectState()
  const track = createFillTrack()
  points.forEach(([x, y], i) => addDesktopMove(state, track, effect, x, y, 1000 + i * gap, 1, '#4fd1a5', true, () => arrow))
  return state
}

/** The app's own pointermove: every few pixels along the same line */
function inApp(effect: Parameters<typeof addMove>[1], from: number, to: number, step = 2) {
  const state = createEffectState()
  for (let x = from; x <= to; x += step) addMove(state, effect, x, 100, 1000 + x, 1, '#4fd1a5', true, true, () => arrow)
  return state
}

describe('filling between the positions read outside the app', () => {
  it('adds about as many particles as the app does for the same sweep, at each effect distance', () => {
    for (const effect of Object.keys(MOVE_DISTANCE) as (keyof typeof MOVE_DISTANCE)[]) {
      const outside = desktop(effect, [[0, 100], [90, 100], [180, 100]]).move.length
      const app = inApp(effect, 0, 180).move.length
      // Without the fill, three positions give at most three particle groups
      expect(outside, effect).toBeGreaterThanOrEqual(Math.floor(app * 0.8))
      expect(outside, effect).toBeLessThanOrEqual(Math.ceil(app * 1.25))
    }
  })

  it('spaces the points by a part of the effect distance, and none for a step under it', () => {
    const track = createFillTrack()
    track.prev = { x: 0, y: 0, t: 1000 }
    const spacing = MOVE_DISTANCE.sparkle / FILL_DIVISIONS
    const points = fillPoints(track, 'sparkle', 30, 0, 1016)
    expect(points).toHaveLength(30 / spacing - 1)
    expect(points.map(point => Math.round(point.x))).toEqual([3, 6, 9, 12, 15, 18, 21, 24, 27])
    expect(points.every(point => point.t > 1000 && point.t < 1016)).toBe(true)
    expect(fillPoints(track, 'sparkle', spacing - 1, 0, 1016)).toEqual([])
    expect(fillPoints(track, 'spot', 60, 0, 1016)).toEqual([])
    expect(fillPoints(track, 'none', 60, 0, 1016)).toEqual([])
  })

  it('caps the points one position adds', () => {
    const track = createFillTrack()
    track.prev = { x: 0, y: 0, t: 1000 }
    expect(fillPoints(track, 'pixel', FILL_MAX_DISTANCE - 1, 0, 1016)).toHaveLength(FILL_MAX_POINTS)
    expect(fillPoints(track, 'rainbow', FILL_MAX_DISTANCE - 1, 0, 1016)).toHaveLength(TRAIL_FILL_MAX_POINTS)
    expect(fillPoints(track, 'comet', TRAIL_SPACING * 3, 0, 1016)).toHaveLength(2)
  })

  it('does not fill a jump, the first position, or the first position after leaving', () => {
    const track = createFillTrack()
    expect(fillPoints(track, 'sparkle', 100, 0, 1016)).toEqual([])
    track.prev = { x: 0, y: 0, t: 1000 }
    expect(fillPoints(track, 'sparkle', FILL_MAX_DISTANCE + 1, 0, 1016)).toEqual([])

    const state = createEffectState()
    addDesktopMove(state, track, 'sparkle', 10, 10, 1000, 1, '#4fd1a5', true)
    resetFill(track)
    state.lastX = state.lastY = -99
    addDesktopMove(state, track, 'sparkle', 300, 10, 1016, 1, '#4fd1a5', true)
    // One group at the new position only (level 1: one sparkle)
    expect(state.move.filter(particle => particle.t0 === 1016)).toHaveLength(1)
    expect(state.move.every(particle => particle.t0 === 1000 || particle.t0 === 1016)).toBe(true)
  })

  it('spreads the times over the last step only, however long the pointer rested', () => {
    const track = createFillTrack()
    track.prev = { x: 0, y: 0, t: 1000 }
    const points = fillPoints(track, 'sparkle', 60, 0, 6000)
    expect(Math.min(...points.map(point => point.t))).toBeGreaterThanOrEqual(6000 - FILL_MAX_GAP_MS)
    expect(points.map(point => point.t)).toEqual([...points.map(point => point.t)].sort((a, b) => a - b))
  })

  it('bends the trail through the turn instead of a sharp corner', () => {
    const track = createFillTrack()
    track.before = { x: 0, y: 0, t: 984 }
    track.prev = { x: 100, y: 0, t: 1000 }
    // Going right, then up: the points between curve out to the right of the straight chord
    const points = fillPoints(track, 'rainbow', 100, -100, 1016)
    expect(points.length).toBeGreaterThan(0)
    expect(points.some(point => point.x > 101)).toBe(true)
    // The straight-on direction is not kept from a position read long before
    track.before = { x: 0, y: 0, t: 500 }
    expect(fillPoints(track, 'rainbow', 100, -100, 1016).every(point => Math.abs(point.x - 100) < 0.001)).toBe(true)
  })

  it('keeps the trail of the effect windows under their limit', () => {
    const zigzag = Array.from({ length: 400 }, (_, i): [number, number] => [(i % 2) * 500, i])
    const state = desktop('comet', zigzag)
    expect(state.move.length).toBeLessThanOrEqual(DESKTOP_TRAIL_CAP)
    expect(state.move.length).toBeGreaterThan(44)
  })
})
