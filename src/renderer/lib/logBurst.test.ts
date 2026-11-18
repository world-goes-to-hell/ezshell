import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trackLogBurst } from './logBurst'

describe('trackLogBurst', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts when rapid reads cross the threshold and coalesces further updates', () => {
    const publish = vi.fn()
    const burst = trackLogBurst(publish)
    burst.add(60)
    vi.advanceTimersByTime(400)
    expect(publish).not.toHaveBeenCalled()
    burst.add(40)
    expect(publish.mock.calls).toEqual([[100]])

    vi.advanceTimersByTime(100)
    burst.add(120)
    vi.advanceTimersByTime(100)
    burst.add(30)
    expect(publish.mock.calls).toEqual([[100]])
    vi.advanceTimersByTime(100)
    expect(publish.mock.calls).toEqual([[100], [250]])
    vi.advanceTimersByTime(1700)
    expect(publish.mock.calls).toEqual([[100], [250], [0]])
  })

  it('lets the notice disappear when the surge settles even if a trickle continues', () => {
    const publish = vi.fn()
    const burst = trackLogBurst(publish)
    burst.add(100)
    vi.advanceTimersByTime(1200)
    burst.add(3)
    vi.advanceTimersByTime(600)
    expect(publish.mock.calls).toEqual([[100], [103], [0]])

    burst.add(60)
    vi.advanceTimersByTime(1100)
    burst.add(60)
    expect(publish).toHaveBeenLastCalledWith(0)
  })

  it('cancels both pending updates and dismissal when following stops', () => {
    const publish = vi.fn()
    const burst = trackLogBurst(publish)
    burst.add(105)
    burst.add(10)
    burst.reset()
    vi.runAllTimers()
    expect(publish.mock.calls).toEqual([[105]])
  })
})
