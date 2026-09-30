import { describe, it, expect } from 'vitest'
import { reorderSession, getDropPosition } from './sessionOrder'

const s = (id: string, folderId?: string) => ({ id, folderId })
const ids = (list: Array<{ id: string }>) => list.map(x => x.id)

describe('reorderSession', () => {
  const list = [s('a', 'f1'), s('b', 'f1'), s('c', 'f1'), s('x', 'f2'), s('y', 'f2')]

  it('moves a session above another in the same folder', () => {
    expect(ids(reorderSession(list, 'c', 'a', 'before'))).toEqual(['c', 'a', 'b', 'x', 'y'])
  })

  it('moves a session below another in the same folder', () => {
    expect(ids(reorderSession(list, 'a', 'b', 'after'))).toEqual(['b', 'a', 'c', 'x', 'y'])
  })

  it('moves a session into the target folder at the drop position', () => {
    const result = reorderSession(list, 'b', 'y', 'before')
    expect(ids(result)).toEqual(['a', 'c', 'x', 'b', 'y'])
    expect(result.find(x => x.id === 'b')?.folderId).toBe('f2')
  })

  it('moves a folder session to the root level when dropped on a root session', () => {
    const withRoot = [s('r1'), s('a', 'f1'), s('r2')]
    const result = reorderSession(withRoot, 'a', 'r2', 'after')
    expect(ids(result)).toEqual(['r1', 'r2', 'a'])
    expect(result.find(x => x.id === 'a')?.folderId).toBeUndefined()
  })

  it('keeps sessions between the drag source and target in their relative order', () => {
    // dragging 'c' above 'a' must not disturb 'h'
    const withMiddle = [s('a', 'f1'), s('h', 'f1'), s('c', 'f1')]
    expect(ids(reorderSession(withMiddle, 'c', 'a', 'before'))).toEqual(['c', 'a', 'h'])
  })

  it('returns the same list when dropped on itself', () => {
    expect(reorderSession(list, 'a', 'a', 'before')).toBe(list)
  })

  it('returns the same list when an id is unknown', () => {
    expect(reorderSession(list, 'zz', 'a', 'before')).toBe(list)
    expect(reorderSession(list, 'a', 'zz', 'before')).toBe(list)
  })

  it('does not mutate the input', () => {
    const copy = list.map(x => ({ ...x }))
    reorderSession(list, 'b', 'y', 'after')
    expect(list).toEqual(copy)
  })

  it('keeps the other fields of the moved session', () => {
    const rich = [{ id: 'a', folderId: 'f1', name: 'A', port: 22 }, { id: 'b', folderId: 'f2', name: 'B', port: 2222 }]
    expect(reorderSession(rich, 'a', 'b', 'after')[1]).toEqual({ id: 'a', folderId: 'f2', name: 'A', port: 22 })
  })
})

describe('getDropPosition', () => {
  it('is before in the top half and after in the bottom half', () => {
    expect(getDropPosition({ top: 100, height: 30 }, 110)).toBe('before')
    expect(getDropPosition({ top: 100, height: 30 }, 120)).toBe('after')
  })
})
