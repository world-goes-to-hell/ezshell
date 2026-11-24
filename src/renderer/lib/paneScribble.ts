// Alt+drag that scrubs back and forth inside one pane closes it, like an eraser
// (docs/plan/2026-11-24-pane-scribble-close.md). A split is one straight line, so the two never meet.

export const SCRIBBLE_TURNS = 3
export const SCRIBBLE_LEG_PX = 30

type Point = { x: number; y: number }

/** How often the stroke turns back along one axis; each sweep must cover `SCRIBBLE_LEG_PX` */
function turnsAlong(values: number[]): number {
  let turns = 0
  let direction = 0
  let extreme = values[0]
  for (const value of values) {
    if (direction === 0) {
      if (Math.abs(value - extreme) >= SCRIBBLE_LEG_PX) {
        direction = Math.sign(value - extreme)
        extreme = value
      }
    } else if ((value - extreme) * direction > 0) {
      extreme = value
    } else if (Math.abs(value - extreme) >= SCRIBBLE_LEG_PX) {
      turns++
      direction = -direction
      extreme = value
    }
  }
  return turns
}

/** The turns along the axis that has more of them (a line drawn out and back to its start is one) */
export function scribbleTurns(points: readonly Point[]): number {
  if (points.length < 2) return 0
  return Math.max(turnsAlong(points.map(point => point.x)), turnsAlong(points.map(point => point.y)))
}

/** Three turns back and forth, sideways or up and down */
export const isScribble = (points: readonly Point[]): boolean => scribbleTurns(points) >= SCRIBBLE_TURNS
