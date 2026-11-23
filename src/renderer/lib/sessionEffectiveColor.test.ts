import { describe, expect, it } from 'vitest'
import { effectiveSessionColor } from './sessionEffectiveColor'

const folders = [
  { id: 'ops', backgroundColor: '#ef4444' },
  { id: 'mbris', parentId: 'ops' },
  { id: 'loop-a', parentId: 'loop-b' },
  { id: 'loop-b', parentId: 'loop-a' }
]

describe('the color a session shows in the local work tree', () => {
  it('is its own color first', () => {
    expect(effectiveSessionColor({ backgroundColor: '#3b82f6', folderId: 'mbris' }, folders)).toBe('#3b82f6')
  })

  it('else the nearest folder color up the chain', () => {
    expect(effectiveSessionColor({ folderId: 'mbris' }, folders)).toBe('#ef4444')
  })

  it('is none without a color, a session or with a broken folder chain', () => {
    expect(effectiveSessionColor({}, folders)).toBeUndefined()
    expect(effectiveSessionColor(undefined, folders)).toBeUndefined()
    expect(effectiveSessionColor({ folderId: 'loop-a' }, folders)).toBeUndefined()
  })
})
