import { describe, it, expect } from 'vitest'
import { toCell, createCollector } from './results.js'

describe('toCell', () => {
  it('keeps plain values and turns the rest into text', () => {
    expect(toCell(null)).toBe(null)
    expect(toCell(undefined)).toBe(null)
    expect(toCell(3)).toBe(3)
    expect(toCell(true)).toBe(true)
    expect(toCell(12345678901234567890n)).toBe('12345678901234567890')
    expect(toCell({ a: 1 })).toBe('{"a":1}')
    expect(toCell(new Date('2026-11-09T01:02:03Z'))).toBe('2026-11-09T01:02:03.000Z')
  })

  it('shows binary as hex, cut after 256 bytes', () => {
    expect(toCell(Buffer.from([0, 255]))).toBe('0x00ff')
    const long = toCell(Buffer.alloc(300))
    expect(long).toMatch(/^0x0{512}… \(300 bytes\)$/)
  })

  it('cuts a very long cell and says so', () => {
    expect(toCell('abcdef', 3)).toBe('abc… (6자 중 일부)')
  })
})

describe('createCollector', () => {
  it('stops at the row limit', () => {
    const collector = createCollector({ maxRows: 2 })
    expect(collector.add([1])).toBe(true)
    expect(collector.add([2])).toBe(true)
    expect(collector.add([3])).toBe(false)
    expect(collector.rows).toEqual([[1], [2]])
    expect(collector.truncatedBy).toBe('rows')
  })

  it('stops at the size limit without keeping the row that went over', () => {
    const collector = createCollector({ maxBytes: 100 })
    expect(collector.add(['x'.repeat(10)])).toBe(true)
    expect(collector.add(['x'.repeat(40)])).toBe(false)
    expect(collector.rows.length).toBe(1)
    expect(collector.truncatedBy).toBe('bytes')
  })
})
