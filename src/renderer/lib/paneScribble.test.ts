import { describe, expect, it } from 'vitest'
import { isScribble, scribbleTurns, SCRIBBLE_LEG_PX } from './paneScribble'

type Point = { x: number; y: number }

/** A stroke through these corners, sampled every 5px as pointer moves would be */
function stroke(...corners: Point[]): Point[] {
  const points: Point[] = [corners[0]]
  for (let index = 1; index < corners.length; index++) {
    const from = corners[index - 1]
    const to = corners[index]
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 5))
    for (let step = 1; step <= steps; step++) {
      points.push({ x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps })
    }
  }
  return points
}

describe('scribble over a pane (Alt+drag to close it)', () => {
  it('reads three turns back and forth as a scribble, sideways or up and down', () => {
    expect(isScribble(stroke({ x: 100, y: 100 }, { x: 180, y: 110 }, { x: 100, y: 120 }, { x: 180, y: 130 }, { x: 100, y: 140 }))).toBe(true)
    expect(isScribble(stroke({ x: 100, y: 100 }, { x: 110, y: 180 }, { x: 120, y: 100 }, { x: 130, y: 180 }, { x: 140, y: 100 }))).toBe(true)
  })

  it('is not a scribble with only two turns', () => {
    expect(isScribble(stroke({ x: 100, y: 100 }, { x: 180, y: 110 }, { x: 100, y: 120 }, { x: 180, y: 130 }))).toBe(false)
  })

  it('leaves a straight split line and a shaky one alone', () => {
    expect(isScribble(stroke({ x: 100, y: 20 }, { x: 102, y: 300 }))).toBe(false)
    const shaky = stroke({ x: 100, y: 20 }, { x: 108, y: 80 }, { x: 96, y: 140 }, { x: 108, y: 200 }, { x: 96, y: 260 }, { x: 104, y: 300 })
    expect(isScribble(shaky)).toBe(false)
  })

  it('needs each sweep to be long enough', () => {
    const short = SCRIBBLE_LEG_PX - 4
    const corners = Array.from({ length: 9 }, (_, index) => ({ x: 100 + (index % 2) * short, y: 100 + index * 4 }))
    expect(isScribble(stroke(...corners))).toBe(false)
  })

  it('counts a split line drawn out and back to its start (the cancel) as one turn', () => {
    expect(scribbleTurns(stroke({ x: 100, y: 20 }, { x: 100, y: 200 }, { x: 100, y: 22 }))).toBe(1)
  })

  it('is not a scribble for too few points', () => {
    expect(isScribble([])).toBe(false)
    expect(isScribble([{ x: 0, y: 0 }])).toBe(false)
  })
})
