// Wheel turns into steps: with a key held, one notch of the wheel moves to the next error or marker
// of the log view. A mouse wheel sends one event of about 100 per notch; a touchpad sends many small
// ones, which are added up until they make a notch.

const NOTCH = 100
/** A pause this long starts a new gesture (a half-collected notch is forgotten) */
const GESTURE_GAP_MS = 250
/** Lines to pixels, for wheels that report lines */
const LINE_PIXELS = 33

export interface WheelInput {
  deltaX: number
  deltaY: number
  /** 0 pixels, 1 lines, 2 pages (WheelEvent.deltaMode) */
  deltaMode: number
  timeStamp: number
}

/** Returns a function that takes wheel events and answers 1 (down), -1 (up) or 0 (not a step yet). */
export function createWheelStepper(): (input: WheelInput) => 1 | -1 | 0 {
  let collected = 0
  let lastTime = Number.NEGATIVE_INFINITY
  return ({ deltaX, deltaY, deltaMode, timeStamp }) => {
    // With Shift held the wheel reports sideways movement on some systems
    const raw = deltaY !== 0 ? deltaY : deltaX
    const delta = deltaMode === 0 ? raw : raw * LINE_PIXELS
    if (timeStamp - lastTime > GESTURE_GAP_MS || Math.sign(delta) !== Math.sign(collected)) collected = 0
    lastTime = timeStamp
    collected += delta
    if (Math.abs(collected) < NOTCH) return 0
    const step = collected > 0 ? 1 : -1
    collected = 0
    return step
  }
}
