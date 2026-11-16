import { describe, it, expect } from 'vitest'
import { effectiveColor } from './toolShared.js'

describe('effectiveColor (the colour the approval dialog shows for a session)', () => {
  const folders = [
    { id: 'root', name: '운영', backgroundColor: '#2f6fed' },
    { id: 'mid', name: '서버', parentId: 'root' },
    { id: 'plain', name: '기타' }
  ]

  it('uses the session\'s own colour when it has one', () => {
    expect(effectiveColor({ backgroundColor: '#3fb950', folderId: 'root' }, folders)).toBe('#3fb950')
  })

  it('falls back to the folder colour when the session has none', () => {
    expect(effectiveColor({ folderId: 'root' }, folders)).toBe('#2f6fed')
  })

  it('inherits the colour from an ancestor folder', () => {
    // mid has no colour, but its parent root does
    expect(effectiveColor({ folderId: 'mid' }, folders)).toBe('#2f6fed')
  })

  it('is null when neither the session nor any ancestor has a colour', () => {
    expect(effectiveColor({ folderId: 'plain' }, folders)).toBeNull()
    expect(effectiveColor({ }, folders)).toBeNull()
    expect(effectiveColor({ folderId: 'gone' }, folders)).toBeNull()
  })

  it('does not loop on a folder cycle', () => {
    const cyclic = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' }
    ]
    expect(effectiveColor({ folderId: 'a' }, cyclic)).toBeNull()
  })
})
