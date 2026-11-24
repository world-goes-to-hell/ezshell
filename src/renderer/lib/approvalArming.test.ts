import { describe, it, expect } from 'vitest'
import { APPROVAL_ARM_DELAY_MS, isApprovalArmed, isApprovalEndVisible } from './approvalArming'

const DELAY = APPROVAL_ARM_DELAY_MS

describe('isApprovalArmed', () => {
  it('stays off for a moment after the dialog appears in a focused window', () => {
    expect(isApprovalArmed({ shownAt: 1000, focusedAt: 1000, hasFocus: true, now: 1000 + DELAY - 1 })).toBe(false)
    expect(isApprovalArmed({ shownAt: 1000, focusedAt: 1000, hasFocus: true, now: 1000 + DELAY })).toBe(true)
  })

  it('stays off while the app window does not have focus, however long ago it appeared', () => {
    expect(isApprovalArmed({ shownAt: 0, focusedAt: null, hasFocus: false, now: 60000 })).toBe(false)
  })

  it('counts the moment from when the window got focus, so the click that activates it does not answer', () => {
    expect(isApprovalArmed({ shownAt: 0, focusedAt: 30000, hasFocus: true, now: 30000 + DELAY - 1 })).toBe(false)
    expect(isApprovalArmed({ shownAt: 0, focusedAt: 30000, hasFocus: true, now: 30000 + DELAY })).toBe(true)
  })

  it('starts over when the window loses focus and gets it back', () => {
    expect(isApprovalArmed({ shownAt: 0, focusedAt: 5000, hasFocus: true, now: 5100 })).toBe(false)
  })
})

describe('isApprovalEndVisible', () => {
  it('allows a command or diff whose end is already visible without scrolling', () => {
    expect(isApprovalEndVisible({ isIntersecting: true, intersectionRatio: 1 })).toBe(true)
  })

  it('blocks an end that fits inside the inner box but is clipped by the dialog body', () => {
    expect(isApprovalEndVisible({ isIntersecting: false, intersectionRatio: 0 })).toBe(false)
    expect(isApprovalEndVisible({ isIntersecting: true, intersectionRatio: 0.49 })).toBe(false)
    expect(isApprovalEndVisible({ isIntersecting: true, intersectionRatio: 1 })).toBe(true)
  })

  it('allows the end when at least half of the marker is visible at fractional zoom', () => {
    expect(isApprovalEndVisible({ isIntersecting: true, intersectionRatio: 0.5 })).toBe(true)
    expect(isApprovalEndVisible({ isIntersecting: true, intersectionRatio: 0.8 })).toBe(true)
  })

  it('keeps the approval blocked if only the marker edge touches the visible area', () => {
    expect(isApprovalEndVisible({ isIntersecting: true, intersectionRatio: 0 })).toBe(false)
  })
})
