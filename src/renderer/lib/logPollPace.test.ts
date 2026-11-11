import { describe, it, expect } from 'vitest'
import { INITIAL_PACE, nextPace, waitFor, POLL_ACTIVE_MS, POLL_IDLE_MS, POLL_HIDDEN_MS } from './logPollPace'

describe('logPollPace', () => {
  it('starts at the idle pace', () => {
    expect(waitFor(INITIAL_PACE, false)).toBe(POLL_IDLE_MS)
  })

  it('looks again quickly while lines arrive', () => {
    const active = nextPace(INITIAL_PACE, true)
    expect(active.waitMs).toBe(POLL_ACTIVE_MS)
    expect(nextPace(active, true).waitMs).toBe(POLL_ACTIVE_MS)
  })

  it('backs off step by step when the log goes quiet, up to the idle pace', () => {
    let pace = nextPace(INITIAL_PACE, true)
    const waits = []
    for (let i = 0; i < 5; i++) {
      pace = nextPace(pace, false)
      waits.push(pace.waitMs)
    }
    expect(waits).toEqual([400, 800, 1000, 1000, 1000])
  })

  it('keeps the slow pace for a hidden window', () => {
    expect(waitFor(nextPace(INITIAL_PACE, true), true)).toBe(POLL_HIDDEN_MS)
  })
})
