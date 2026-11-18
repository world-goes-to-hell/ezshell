import { describe, it, expect } from 'vitest'
import { createWheelStepper } from './logWheel'

const wheel = (deltaY: number, timeStamp: number, extra: Partial<{ deltaX: number; deltaMode: number }> = {}) =>
  ({ deltaX: 0, deltaY, deltaMode: 0, timeStamp, ...extra })

describe('wheel steps', () => {
  it('one notch is one step, in the direction of the wheel', () => {
    const step = createWheelStepper()
    expect(step(wheel(100, 0))).toBe(1)
    expect(step(wheel(100, 50))).toBe(1)
    expect(step(wheel(-100, 100))).toBe(-1)
  })

  it('adds up small touchpad movements', () => {
    const step = createWheelStepper()
    expect([step(wheel(30, 0)), step(wheel(30, 16)), step(wheel(30, 32)), step(wheel(30, 48))]).toEqual([0, 0, 0, 1])
  })

  it('forgets a half notch after a pause or a change of direction', () => {
    const step = createWheelStepper()
    expect(step(wheel(60, 0))).toBe(0)
    expect(step(wheel(60, 1000))).toBe(0)
    expect(step(wheel(-60, 1010))).toBe(0)
    expect(step(wheel(-60, 1020))).toBe(-1)
  })

  it('reads sideways movement (Shift held) and line units', () => {
    const step = createWheelStepper()
    expect(step(wheel(0, 0, { deltaX: -100 }))).toBe(-1)
    expect(step(wheel(3, 10, { deltaMode: 1 }))).toBe(0)
    expect(step(wheel(3, 20, { deltaMode: 1 }))).toBe(1)
  })
})
