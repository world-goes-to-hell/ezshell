import { describe, it, expect } from 'vitest'
import { stepZoom, normalizeZoom, snapZoom, resolveInitialZoom, toZoomPercent, createWheelStepper, DEFAULT_ZOOM, ZOOM_STEPS } from './appZoom'

describe('stepZoom', () => {
  it('moves to the neighbouring preset', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(1.25, 1)).toBe(1.5)
  })

  it('stops at both ends', () => {
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1], 1)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1])
    expect(stepZoom(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0])
  })

  it('snaps an off-grid value to the next preset in the given direction', () => {
    // 1.2 ** 0.5, left behind by the old half-level zoom
    expect(stepZoom(1.0954, 1)).toBe(1.1)
    expect(stepZoom(1.0954, -1)).toBe(1)
  })

  it('treats float noise as the preset itself', () => {
    expect(stepZoom(1.1000000001, 1)).toBe(1.25)
    expect(stepZoom(0.6699999, -1)).toBe(0.5)
  })
})

describe('normalizeZoom', () => {
  it('keeps valid values and clamps out-of-range ones', () => {
    expect(normalizeZoom(1.25)).toBe(1.25)
    expect(normalizeZoom(9)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1])
    expect(normalizeZoom(0.1)).toBe(ZOOM_STEPS[0])
  })

  it('falls back to 100% for garbage', () => {
    expect(normalizeZoom(undefined)).toBe(DEFAULT_ZOOM)
    expect(normalizeZoom('1.5')).toBe(DEFAULT_ZOOM)
    expect(normalizeZoom(Number.NaN)).toBe(DEFAULT_ZOOM)
    expect(normalizeZoom(0)).toBe(DEFAULT_ZOOM)
  })
})

describe('snapZoom', () => {
  it('rounds to the nearest preset', () => {
    expect(snapZoom(1.7499999999999998)).toBe(1.75)
    expect(snapZoom(1.0954)).toBe(1.1)
    expect(snapZoom(1.9999999)).toBe(2)
  })

  it('cleans garbage and out-of-range values', () => {
    expect(snapZoom('abc')).toBe(DEFAULT_ZOOM)
    expect(snapZoom(7)).toBe(2)
  })
})

describe('resolveInitialZoom', () => {
  it('keeps any stored zoom, including an explicit 100%', () => {
    expect(resolveInitialZoom(1.25, 1)).toBe(1.25)
    expect(resolveInitialZoom(1.25, 1.5)).toBe(1.25)
    // Chromium's own record can lag behind after a crash; the user's choice wins
    expect(resolveInitialZoom(1, 1.25)).toBe(1)
  })

  it('adopts the zoom Chromium kept when nothing was stored yet', () => {
    expect(resolveInitialZoom(undefined, 1.0954)).toBe(1.1)
    expect(resolveInitialZoom(undefined, 1.2)).toBe(1.25)
  })

  it('falls back to 100% when the actual zoom is unknown', () => {
    expect(resolveInitialZoom(undefined, undefined)).toBe(DEFAULT_ZOOM)
  })
})

describe('toZoomPercent', () => {
  it('rounds to a whole percent', () => {
    expect(toZoomPercent(1)).toBe(100)
    expect(toZoomPercent(0.67)).toBe(67)
    expect(toZoomPercent(1.0954)).toBe(110)
  })
})

describe('createWheelStepper', () => {
  it('turns one mouse wheel notch into one step', () => {
    const step = createWheelStepper()
    expect(step(-100)).toBe(1)
    expect(step(100)).toBe(-1)
  })

  it('accumulates small touchpad deltas before stepping', () => {
    const step = createWheelStepper()
    expect(step(-20)).toBe(0)
    expect(step(-20)).toBe(0)
    expect(step(-20)).toBe(1)
    expect(step(-20)).toBe(0)
  })

  it('drops the accumulated delta when the direction flips', () => {
    const step = createWheelStepper()
    expect(step(-40)).toBe(0)
    expect(step(40)).toBe(0)
    expect(step(20)).toBe(-1)
  })

  it('forgets leftover deltas after a pause', () => {
    const step = createWheelStepper()
    expect(step(-40, 0)).toBe(0)
    expect(step(-20, 1000)).toBe(0)
    expect(step(-20, 1050)).toBe(0)
  })

  it('never jumps more than one step per event', () => {
    const step = createWheelStepper()
    expect(step(-500)).toBe(1)
    expect(step(-10)).toBe(0)
  })
})
