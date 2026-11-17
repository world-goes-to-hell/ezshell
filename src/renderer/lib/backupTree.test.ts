import { describe, it, expect } from 'vitest'
import { buildBackupRows, checkState, toggleMany } from './backupTree'

const folders = [
  { id: 'dev', name: '개발' },
  { id: 'dev-db', name: 'DB', parentId: 'dev' },
  { id: 'prod', name: '운영' }
]
const sessions = [
  { id: 's1', folderId: 'dev' },
  { id: 's2', folderId: 'dev-db' },
  { id: 's3', folderId: 'prod' },
  { id: 's4' },
  { id: 's5', folderId: 'deleted-folder' }
]

const shape = (rows: ReturnType<typeof buildBackupRows>) => rows.map(row => `${'  '.repeat(row.depth)}${row.kind}:${row.id}`)

describe('buildBackupRows', () => {
  it('lists folders, their subfolders, then their sessions; loose sessions last', () => {
    expect(shape(buildBackupRows(folders, sessions))).toEqual([
      'folder:dev', '  folder:dev-db', '    session:s2', '  session:s1',
      'folder:prod', '  session:s3',
      'session:s4', 'session:s5'
    ])
  })

  it('gives a folder every session under it, at any depth', () => {
    const rows = buildBackupRows(folders, sessions)
    const dev = rows.find(row => row.id === 'dev')
    expect(dev?.kind === 'folder' && dev.sessionIds).toEqual(['s2', 's1'])
  })

  it('hides what is under a collapsed folder but still counts its sessions', () => {
    const rows = buildBackupRows(folders, sessions, new Set(['dev']))
    expect(shape(rows)).toEqual(['folder:dev', 'folder:prod', '  session:s3', 'session:s4', 'session:s5'])
    const dev = rows[0]
    expect(dev.kind === 'folder' && dev.sessionIds).toEqual(['s2', 's1'])
  })

  it('does not lose folders caught in a parent cycle', () => {
    const cyclic = [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }]
    const rows = buildBackupRows(cyclic, [{ id: 'x', folderId: 'b' }])
    expect(rows.filter(row => row.kind === 'folder').map(row => row.id).sort()).toEqual(['a', 'b'])
    expect(rows.some(row => row.kind === 'session' && row.id === 'x')).toBe(true)
  })
})

describe('checkState and toggleMany', () => {
  it('reports all, some or none', () => {
    expect(checkState(['a', 'b'], new Set(['a', 'b']))).toBe('all')
    expect(checkState(['a', 'b'], new Set(['a']))).toBe('some')
    expect(checkState(['a', 'b'], new Set())).toBe('none')
    expect(checkState([], new Set(['a']))).toBe('none')
  })

  it('selects the rest of a partly selected folder, and clears a fully selected one', () => {
    expect([...toggleMany(['a', 'b'], new Set(['a', 'z']))].sort()).toEqual(['a', 'b', 'z'])
    expect([...toggleMany(['a', 'b'], new Set(['a', 'b', 'z']))]).toEqual(['z'])
  })
})
