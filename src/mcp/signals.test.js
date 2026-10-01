import { describe, it, expect } from 'vitest'
import signalsModule from './signals.js'

const { combineSignals } = signalsModule

describe('combineSignals', () => {
  it('aborts when any input aborts', () => {
    const a = new AbortController()
    const b = new AbortController()
    const combined = combineSignals([a.signal, null, b.signal])
    expect(combined.aborted).toBe(false)
    b.abort()
    expect(combined.aborted).toBe(true)
  })

  it('starts aborted when an input already is', () => {
    const a = new AbortController()
    a.abort()
    expect(combineSignals([a.signal]).aborted).toBe(true)
  })

  it('never aborts with no inputs', () => {
    expect(combineSignals([undefined]).aborted).toBe(false)
  })
})
