import { describe, it, expect } from 'vitest'
import { APPROVAL_ARM_DELAY_MS, isApprovalArmed } from './approvalArming'

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
