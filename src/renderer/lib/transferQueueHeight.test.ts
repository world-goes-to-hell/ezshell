import { describe, it, expect } from 'vitest'
import { clampQueueHeight, maxQueueHeight, parseQueueHeight, DEFAULT_QUEUE_HEIGHT, MIN_QUEUE_HEIGHT, LISTS_MIN_HEIGHT } from './transferQueueHeight'

describe('clampQueueHeight', () => {
  it('keeps a height that fits', () => {
    expect(clampQueueHeight(180, 600)).toBe(180)
  })

  it('stays between one row and what the lists above can spare', () => {
    expect(clampQueueHeight(5, 600)).toBe(MIN_QUEUE_HEIGHT)
    expect(clampQueueHeight(900, 600)).toBe(600 - LISTS_MIN_HEIGHT)
    expect(maxQueueHeight(600)).toBe(470)
  })

  it('never goes under the minimum, even in a tiny area', () => {
    expect(clampQueueHeight(300, 50)).toBe(MIN_QUEUE_HEIGHT)
    expect(clampQueueHeight(Number.NaN, 600)).toBe(DEFAULT_QUEUE_HEIGHT)
  })
})

describe('parseQueueHeight', () => {
  it('reads a stored height', () => {
    expect(parseQueueHeight('210')).toBe(210)
    expect(parseQueueHeight('210.6')).toBe(211)
  })

  it('falls back to the default', () => {
    for (const raw of [null, undefined, '', 'abc', '10', '-40', '999999']) {
      expect(parseQueueHeight(raw)).toBe(DEFAULT_QUEUE_HEIGHT)
    }
  })
})
