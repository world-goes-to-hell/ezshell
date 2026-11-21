import { describe, it, expect } from 'vitest'
import { getFolderPath, buildPickerItems, buildPickerTree, filterPickerItems, moveSelection } from './sessionPicker'
import type { Session, Folder } from '../stores/sessionStore'

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  name: id,
  host: `${id}.example.com`,
  port: 22,
  username: 'root',
  authType: 'password',
  ...overrides
})

const folders: Folder[] = [
  { id: 'prod', name: '운영' },
  { id: 'prod-db', name: 'DB', parentId: 'prod' },
  { id: 'dev', name: '개발' }
]

const names = (items: Array<{ session: Session }>) => items.map(i => i.session.name)

describe('getFolderPath', () => {
  it('returns an empty string for sessions without a folder', () => {
    expect(getFolderPath(undefined, folders)).toBe('')
  })

  it('joins nested folder names from root to leaf', () => {
    expect(getFolderPath('prod-db', folders)).toBe('운영 / DB')
  })

  it('returns an empty string for an unknown folder id', () => {
    expect(getFolderPath('missing', folders)).toBe('')
  })

  it('stops on a parent cycle instead of looping forever', () => {
    const cyclic: Folder[] = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' }
    ]
    expect(getFolderPath('a', cyclic)).toBe('B / A')
  })
})

describe('buildPickerItems', () => {
  it('attaches the folder path and open state to each session in order', () => {
    const items = buildPickerItems(
      [session('web', { folderId: 'prod' }), session('mysql', { folderId: 'prod-db' }), session('local')],
      folders,
      new Set(['mysql'])
    )
    expect(items.map(i => [i.session.id, i.folderPath, i.isOpen])).toEqual([
      ['web', '운영', false],
      ['mysql', '운영 / DB', true],
      ['local', '', false]
    ])
  })
})

describe('filterPickerItems', () => {
  const items = buildPickerItems(
    [
      session('web-01', { folderId: 'prod', host: '10.0.0.1' }),
      session('mysql', { folderId: 'prod-db', host: 'db.internal' }),
      session('sandbox', { folderId: 'dev', username: 'deploy' })
    ],
    folders,
    new Set()
  )

  it('returns every item in the original order for a blank query', () => {
    expect(names(filterPickerItems(items, '   '))).toEqual(['web-01', 'mysql', 'sandbox'])
  })

  it('matches by session name', () => {
    expect(names(filterPickerItems(items, 'mysql'))[0]).toBe('mysql')
  })

  it('matches by host', () => {
    expect(names(filterPickerItems(items, '10.0.0.1'))).toEqual(['web-01'])
  })

  it('matches by username', () => {
    expect(names(filterPickerItems(items, 'deploy'))).toEqual(['sandbox'])
  })

  it('matches by folder name', () => {
    expect(names(filterPickerItems(items, '개발'))).toEqual(['sandbox'])
  })

  it('returns nothing when no field matches', () => {
    expect(filterPickerItems(items, 'zzzzzz')).toEqual([])
  })
})

describe('buildPickerTree', () => {
  const items = buildPickerItems([
    session('local'), session('web', { folderId: 'prod' }), session('sandbox', { folderId: 'dev' }),
    session('mysql', { folderId: 'prod-db' }), session('unfiled', { folderId: 'removed' })
  ], folders, new Set(['mysql']))

  it('shows nested folders in sidebar order, then sessions without a folder', () => {
    const tree = buildPickerTree(items, folders)
    expect(tree.folders.map(node => node.folder.id)).toEqual(['prod', 'dev'])
    expect(tree.folders[0].folders[0]).toMatchObject({ folder: { id: 'prod-db' }, items: [{ isOpen: true }] })
    expect(names(tree.items)).toEqual(['local', 'unfiled'])
    expect(names(tree.ordered)).toEqual(['mysql', 'web', 'sandbox', 'local', 'unfiled'])
  })

  it('keeps every ancestor of a matching session and hides branches with no matches', () => {
    const tree = buildPickerTree(filterPickerItems(items, 'mysql'), folders)
    expect(tree.folders.map(node => node.folder.id)).toEqual(['prod'])
    expect(tree.folders[0].folders.map(node => node.folder.id)).toEqual(['prod-db'])
    expect(names(tree.ordered)).toEqual(['mysql'])
  })

  it('shows sessions from orphaned or cyclic folder data once', () => {
    const unusual: Folder[] = [
      { id: 'orphan', name: 'Orphan', parentId: 'missing' },
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' }
    ]
    const sessions = unusual.map(folder => session(folder.name, { folderId: folder.id }))
    const tree = buildPickerTree(buildPickerItems(sessions, unusual, new Set()), unusual)
    expect(tree.folders.map(node => node.folder.id)).toEqual(['orphan', 'a'])
    expect(names(tree.ordered)).toEqual(['Orphan', 'B', 'A'])
  })
})

describe('moveSelection', () => {
  it('moves down and wraps to the first item', () => {
    expect(moveSelection(0, 1, 3)).toBe(1)
    expect(moveSelection(2, 1, 3)).toBe(0)
  })

  it('moves up and wraps to the last item', () => {
    expect(moveSelection(0, -1, 3)).toBe(2)
  })

  it('stays at 0 for an empty list', () => {
    expect(moveSelection(0, 1, 0)).toBe(0)
  })
})
