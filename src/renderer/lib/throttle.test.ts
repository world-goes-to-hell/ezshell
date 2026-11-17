import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { throttle } from './throttle'

describe('throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the first call at once', () => {
    const fn = vi.fn()
    throttle(fn, 80)('a')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenLastCalledWith('a')
  })

  it('runs at most once per interval during a burst, and once more with the latest value', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 80)
    throttled(1)
    for (let i = 2; i <= 10; i++) {
      vi.advanceTimersByTime(10)
      throttled(i)
    }
    // 90ms of calls: the first at once, then the latest one waiting when the 80ms interval ended
    // (the timer fires before the call made at that same instant)
    expect(fn.mock.calls.map(call => call[0])).toEqual([1, 8])
    vi.advanceTimersByTime(200)
    expect(fn.mock.calls.map(call => call[0])).toEqual([1, 8, 10])
  })

  it('runs again at once after a quiet period', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 80)
    throttled('a')
    vi.advanceTimersByTime(500)
    throttled('b')
    expect(fn.mock.calls.map(call => call[0])).toEqual(['a', 'b'])
  })

  it('drops the pending call on cancel', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 80)
    throttled(1)
    throttled(2)
    throttled.cancel()
    vi.advanceTimersByTime(500)
    expect(fn.mock.calls.map(call => call[0])).toEqual([1])
  })
})
