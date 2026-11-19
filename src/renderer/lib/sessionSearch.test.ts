import { describe, it, expect } from 'vitest'
import { sessionSearchTerms, sessionMatches, sessionsInTreeOrder, searchSessions, stepMatch } from './sessionSearch'
import type { Session, Folder } from '../stores/sessionStore'

const session = (id: string, name: string, host: string, folderId?: string, username = 'root'): Session =>
  ({ id, name, host, port: 22, username, folderId } as Session)

const folders: Folder[] = [
  { id: 'prod', name: '운영' },
  { id: 'prod-db', name: 'DB', parentId: 'prod' },
  { id: 'dev', name: '개발' }
]
const sessions: Session[] = [
  session('s1', 'web-01', '10.0.0.1', 'prod'),
  session('s2', 'db-main', '10.0.0.2', 'prod-db'),
  session('s3', 'db-dev', '10.1.0.2', 'dev', 'deploy'),
  session('s4', 'bastion', 'gw.example.com')
]

describe('sessionSearchTerms', () => {
  it('splits at spaces, without case, each word once', () => {
    expect(sessionSearchTerms('  운영  DB db ')).toEqual(['운영', 'db'])
    expect(sessionSearchTerms('   ')).toEqual([])
  })
})

describe('sessionMatches', () => {
  it('needs every word somewhere in the name, host, account or folder names', () => {
    expect(sessionMatches(sessions[1], '운영 / DB', ['운영', 'main'])).toBe(true)
    expect(sessionMatches(sessions[1], '운영 / DB', ['운영', 'dev'])).toBe(false)
    expect(sessionMatches(sessions[2], '개발', ['deploy'])).toBe(true)
    expect(sessionMatches(sessions[3], '', ['example'])).toBe(true)
  })

  it('matches nothing without a word', () => {
    expect(sessionMatches(sessions[0], '운영', [])).toBe(false)
  })
})

describe('sessionsInTreeOrder', () => {
  it('follows the sidebar: sub-folders before a folder\'s sessions, root sessions last', () => {
    expect(sessionsInTreeOrder(sessions, folders).map(s => s.id)).toEqual(['s2', 's1', 's3', 's4'])
  })
})

describe('searchSessions', () => {
  it('lists the matches in tree order and opens the folders above them', () => {
    const result = searchSessions(sessions, folders, ['db'])
    expect(result.matchIds).toEqual(['s2', 's3'])
    expect([...result.openFolderIds].sort()).toEqual(['dev', 'prod', 'prod-db'])
  })

  it('matches every session under a folder whose name is searched', () => {
    expect(searchSessions(sessions, folders, ['운영']).matchIds).toEqual(['s2', 's1'])
  })

  it('finds nothing and opens nothing without a word', () => {
    const result = searchSessions(sessions, folders, [])
    expect(result.matchIds).toEqual([])
    expect(result.openFolderIds.size).toBe(0)
  })

  it('survives a folder cycle in stored data', () => {
    const looped: Folder[] = [{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }]
    const result = searchSessions([session('x', 'x', 'h', 'a')], looped, ['x'])
    expect(result.matchIds).toEqual([])
  })
})

describe('stepMatch', () => {
  it('wraps at both ends', () => {
    expect(stepMatch(2, 1, 3)).toBe(0)
    expect(stepMatch(0, -1, 3)).toBe(2)
    expect(stepMatch(0, 1, 0)).toBe(0)
  })
})
