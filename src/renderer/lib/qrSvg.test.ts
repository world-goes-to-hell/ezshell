import { describe, it, expect } from 'vitest'
import { qrPath, remainingLabel } from './qrSvg'

describe('qrPath', () => {
  it('joins runs of dark cells in a row and leaves the quiet zone', () => {
    // 1 1 0
    // 0 0 1
    // 0 0 0
    expect(qrPath({ size: 3, cells: [1, 1, 0, 0, 0, 1, 0, 0, 0] })).toBe('M4 4h2v1h-2zM6 5h1v1h-1z')
  })

  it('draws nothing for a matrix whose size does not match its cells', () => {
    expect(qrPath({ size: 3, cells: [1, 1] })).toBe('')
    expect(qrPath({ size: 0, cells: [] })).toBe('')
  })
})

describe('remainingLabel', () => {
  it('shows minutes and seconds, never below zero', () => {
    expect(remainingLabel(125_000, 0)).toBe('2:05')
    expect(remainingLabel(1_000, 500)).toBe('0:01')
    expect(remainingLabel(1_000, 9_000)).toBe('0:00')
  })
})
