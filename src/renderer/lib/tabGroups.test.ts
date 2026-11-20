import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '../stores/terminalStore'
import { GENERAL_GROUP, groupOfTab, groupTabs, stepTab, type GroupProject } from './tabGroups'

const local = (id: string, cwd: string): TerminalInfo => ({ id, host: '이 PC', username: '', connected: true, local: { shell: 'PowerShell', cwd } })
const ssh = (id: string, saved: string | null): TerminalInfo => ({ id, host: 'h', username: 'u', connected: true, connectConfig: { host: 'h', port: 22, username: 'u', savedSessionId: saved } as TerminalInfo['connectConfig'] })
const db = (id: string, sshSessionId: string): TerminalInfo => ({ id, host: 'h', username: 'u', connected: true, db: { dbId: '1', sshSessionId } } as TerminalInfo)

const projects: GroupProject[] = [
  { key: 'd:/work/gsd', name: 'gsd', worktrees: ['D:\\work\\gsd', 'D:\\work\\gsd-feature'] },
  { key: 'd:/work/app', name: 'app', worktrees: ['D:\\work\\app'] }
]
const servers = { 'd:/work/gsd': ['home'], 'd:/work/app': ['shared'], 'd:/gone': ['web'] }

describe('tab groups', () => {
  const terminals = new Map<string, TerminalInfo>([
    ['local:1', local('local:1', 'D:\\work\\gsd\\src')],
    ['local:2', local('local:2', 'D:\\work\\gsd-feature')],
    ['local:3', local('local:3', 'D:\\work\\app')],
    ['local:4', local('local:4', 'C:\\Users\\me')],
    ['s1', ssh('s1', 'home')],
    ['s2', ssh('s2', null)],
    ['s3', ssh('s3', 'web')],
    ['db:1', db('db:1', 's1')]
  ])

  it('puts local tabs with the project of their folder, worktrees together', () => {
    expect(groupOfTab('local:1', terminals, projects, servers)).toBe('d:/work/gsd')
    expect(groupOfTab('local:2', terminals, projects, servers)).toBe('d:/work/gsd')
    expect(groupOfTab('local:3', terminals, projects, servers)).toBe('d:/work/app')
    // A folder no project covers: a group of its own, not with the SSH tabs in general (reported 2026-11-20)
    expect(groupOfTab('local:4', terminals, projects, servers)).toBe('folder:c:/users/me')
  })

  it('groups local tabs of an unregistered folder by that folder, named after it', () => {
    const tabs = new Map<string, TerminalInfo>([
      ['browser:0', { id: 'browser:0', host: '', username: '', connected: true, browser: { group: 'folder:d:/dev/ai-mokup-mcp' } }],
      ['local:1', local('local:1', 'D:\\DEV\\Ai-Mokup-MCP')],
      ['s1', ssh('s1', null)],
      ['local:2', local('local:2', 'D:\\DEV\\ai-mokup-mcp\\')],
      ['local:3', { id: 'local:3', host: '이 PC', username: '', connected: true, local: { shell: 'PowerShell' } }],
      ['browser:1', { id: 'browser:1', host: '', username: '', connected: true, browser: { group: 'folder:d:/dev/ai-mokup-mcp' } }]
    ])
    expect(groupTabs([...tabs.keys()], tabs, projects, servers)).toEqual([
      { key: 'folder:d:/dev/ai-mokup-mcp', label: 'Ai-Mokup-MCP', tabIds: ['browser:0', 'local:1', 'local:2', 'browser:1'] },
      { key: GENERAL_GROUP, label: '일반', tabIds: ['s1', 'local:3'] }
    ])
  })

  it('puts a linked session with its project, others and quick connects in general, a DB tab with its SSH tab', () => {
    expect(groupOfTab('s1', terminals, projects, servers)).toBe('d:/work/gsd')
    expect(groupOfTab('s2', terminals, projects, servers)).toBe(GENERAL_GROUP)
    // Linked to a project no longer registered
    expect(groupOfTab('s3', terminals, projects, servers)).toBe(GENERAL_GROUP)
    expect(groupOfTab('db:1', terminals, projects, servers)).toBe('d:/work/gsd')
  })

  it('prefers the group in front for a session linked to several projects', () => {
    const both = { 'd:/work/gsd': ['home'], 'd:/work/app': ['home'] }
    expect(groupOfTab('s1', terminals, projects, both)).toBe('d:/work/gsd')
    expect(groupOfTab('s1', terminals, projects, both, 'd:/work/app')).toBe('d:/work/app')
  })

  it('lists the groups in the order of their first tab', () => {
    expect(groupTabs(['s2', 'local:1', 'local:3', 's1'], terminals, projects, servers)).toEqual([
      { key: GENERAL_GROUP, label: '일반', tabIds: ['s2'] },
      { key: 'd:/work/gsd', label: 'gsd', tabIds: ['local:1', 's1'] },
      { key: 'd:/work/app', label: 'app', tabIds: ['local:3'] }
    ])
  })

  it('steps within the tabs shown, wrapping around', () => {
    expect(stepTab(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(stepTab(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(stepTab(['a', 'b'], 'x', 1)).toBe('a')
    expect(stepTab([], 'a', 1)).toBeNull()
  })
})
