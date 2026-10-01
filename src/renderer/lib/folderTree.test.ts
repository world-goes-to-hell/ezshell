import { describe, it, expect } from 'vitest'
import { groupFoldersByParent, ancestorIds } from './folderTree'

const folders = [
  { id: 'dev', name: '개발' },
  { id: 'ops', name: '운영' },
  { id: 'mbris', name: 'MBRIS', parentId: 'dev' },
  { id: 'portal', name: 'PORTAL', parentId: 'mbris' },
  { id: 'voucher', name: '바우처', parentId: 'dev' }
]

describe('groupFoldersByParent', () => {
  it('lists children per parent in stored order, top level under undefined', () => {
    const byParent = groupFoldersByParent(folders)

    expect(byParent.get(undefined)?.map(f => f.id)).toEqual(['dev', 'ops'])
    expect(byParent.get('dev')?.map(f => f.id)).toEqual(['mbris', 'voucher'])
    expect(byParent.get('mbris')?.map(f => f.id)).toEqual(['portal'])
    expect(byParent.get('portal')).toBeUndefined()
  })
})

describe('ancestorIds', () => {
  it('returns the parents of a folder so the tree can open down to it', () => {
    expect([...ancestorIds(folders, 'portal')].sort()).toEqual(['dev', 'mbris'])
    expect([...ancestorIds(folders, 'dev')]).toEqual([])
    expect([...ancestorIds(folders, undefined)]).toEqual([])
  })

  it('stops on a parent cycle in stored data', () => {
    const looped = [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }]

    expect([...ancestorIds(looped, 'a')].sort()).toEqual(['a', 'b'])
  })
})
