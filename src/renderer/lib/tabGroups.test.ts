import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '../stores/terminalStore'
import { GENERAL_GROUP, groupOfTab, groupTabs, localFolderForGroup, localTerminalChoices, stepTab, workTabsByWorktree, type GroupProject } from './tabGroups'

const local = (id: string, cwd: string): TerminalInfo => ({ id, host: '이 PC', username: '', connected: true, local: { shell: 'PowerShell', cwd } })
const ssh = (id: string, saved: string | null): TerminalInfo => ({ id, host: 'h', username: 'u', connected: true, connectConfig: { host: 'h', port: 22, username: 'u', savedSessionId: saved } as TerminalInfo['connectConfig'] })
const db = (id: string, sshSessionId: string): TerminalInfo => ({ id, host: 'h', username: 'u', connected: true, db: { dbId: '1', sshSessionId } } as TerminalInfo)
/** An SSH tab opened from a work (its 서버 row or + menu) */
const inWork = (id: string, saved: string | null, workGroup: string): TerminalInfo => {
  const info = ssh(id, saved)
  return { ...info, connectConfig: { ...info.connectConfig!, workGroup } }
}

const projects: GroupProject[] = [
  { key: 'd:/work/gsd', name: 'gsd', worktrees: ['D:\\work\\gsd', 'D:\\work\\gsd-feature'] },
  { key: 'd:/work/app', name: 'app', worktrees: ['D:\\work\\app'] }
]

describe('tab groups', () => {
  const terminals = new Map<string, TerminalInfo>([
    ['local:1', local('local:1', 'D:\\work\\gsd\\src')],
    ['local:2', local('local:2', 'D:\\work\\gsd-feature')],
    ['local:3', local('local:3', 'D:\\work\\app')],
    ['local:4', local('local:4', 'C:\\Users\\me')],
    ['s1', inWork('s1', 'home', 'd:/work/gsd')],
    ['s2', ssh('s2', null)],
    ['s3', inWork('s3', 'web', 'd:/gone')],
    // A session linked to gsd but opened from the session list
    ['s4', ssh('s4', 'home')],
    ['db:1', db('db:1', 's1')]
  ])

  it('puts local tabs with the project of their folder, worktrees together', () => {
    expect(groupOfTab('local:1', terminals, projects)).toBe('d:/work/gsd')
    expect(groupOfTab('local:2', terminals, projects)).toBe('d:/work/gsd')
    expect(groupOfTab('local:3', terminals, projects)).toBe('d:/work/app')
    // A folder no project covers: a group of its own, not with the SSH tabs in general (reported 2026-11-20)
    expect(groupOfTab('local:4', terminals, projects)).toBe('folder:c:/users/me')
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
    expect(groupTabs([...tabs.keys()], tabs, projects)).toEqual([
      { key: 'folder:d:/dev/ai-mokup-mcp', label: 'Ai-Mokup-MCP', tabIds: ['browser:0', 'local:1', 'local:2', 'browser:1'] },
      { key: GENERAL_GROUP, label: '일반', tabIds: ['s1', 'local:3'] }
    ])
  })

  it('puts an SSH tab opened from a work in that work, a DB tab with its SSH tab, the rest in general', () => {
    expect(groupOfTab('s1', terminals, projects)).toBe('d:/work/gsd')
    expect(groupOfTab('db:1', terminals, projects)).toBe('d:/work/gsd')
    expect(groupOfTab('s2', terminals, projects)).toBe(GENERAL_GROUP)
    // Opened from a project no longer registered
    expect(groupOfTab('s3', terminals, projects)).toBe(GENERAL_GROUP)
  })

  it('keeps a session opened from the session list in general, even when it is linked to a project', () => {
    // 2026-11-20 user decision: the link (the work's 서버 row) does not pull such a tab into the work
    expect(groupOfTab('s4', terminals, projects)).toBe(GENERAL_GROUP)
  })

  it('keeps each SSH tab in the work it was opened from, including unsaved connections', () => {
    const tabs = new Map([
      ['original', ssh('original', 'home')],
      ['picked', inWork('picked', 'home', 'd:/work/app')],
      ['new', inWork('new', null, 'd:/work/app')],
      ['folder', inWork('folder', 'home', 'folder:d:/somewhere')],
      ['general', inWork('general', 'home', GENERAL_GROUP)],
      ['removed', inWork('removed', 'home', 'd:/removed')]
    ])
    expect(groupTabs([...tabs.keys()], tabs, projects).map(({ key, tabIds }) => [key, tabIds])).toEqual([
      [GENERAL_GROUP, ['original', 'general', 'removed']],
      ['d:/work/app', ['picked', 'new']],
      ['folder:d:/somewhere', ['folder']]
    ])
  })

  it('lists the groups in the order of their first tab', () => {
    expect(groupTabs(['s2', 'local:1', 'local:3', 's1'], terminals, projects)).toEqual([
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

describe('the tab strip’s local shell folder', () => {
  const root = 'D:\\work\\gsd'
  const feature = 'D:\\work\\gsd-feature'
  const work = 'd:/work/gsd'

  it('uses the front local tab’s launch folder before other folders of the group', () => {
    expect(localFolderForGroup(work, projects, `${feature}\\src`, root, [root])).toBe(`${feature}\\src`)
  })

  it('keeps using the last local folder while a browser or linked server is in front', () => {
    expect(localFolderForGroup(work, projects, undefined, feature, [root])).toBe(feature)
    expect(localFolderForGroup(work, projects, undefined, 'D:\\work\\app', [feature])).toBe(feature)
    expect(localFolderForGroup(work, projects, undefined, undefined, [])).toBe(root)
  })

  it('uses the original folder spelling for unregistered work when available', () => {
    expect(localFolderForGroup('folder:d:/work/other', projects, undefined, 'D:\\Work\\Other', [])).toBe('D:\\Work\\Other')
    expect(localFolderForGroup(GENERAL_GROUP, projects, undefined, undefined, [])).toBeUndefined()
  })
})

describe('the + menu’s local terminal', () => {
  it('opens in the work’s folder, and offers the front tab’s folder too when it is a folder below it', () => {
    const work = String.raw`D:\WORK\mbris-new`
    expect(localTerminalChoices(String.raw`D:\WORK\mbris-new\backend`, work)).toEqual({ root: work, here: String.raw`D:\WORK\mbris-new\backend` })
    expect(localTerminalChoices('d:/work/MBRIS-NEW/backend/src', work)).toEqual({ root: work, here: 'd:/work/MBRIS-NEW/backend/src' })
    expect(localTerminalChoices(work, work)).toEqual({ root: work })
    expect(localTerminalChoices(String.raw`D:\WORK\mbris-new\ `.trim(), work)).toEqual({ root: work })
    // A folder outside any registered worktree (a folder work): that folder only
    expect(localTerminalChoices(String.raw`D:\other\app`, undefined)).toEqual({ root: String.raw`D:\other\app` })
    expect(localTerminalChoices(String.raw`D:\WORK\mbris-new-old`, work)).toEqual({ root: work })
    expect(localTerminalChoices(undefined, work)).toEqual({})
  })
})

describe('the browser, SSH and DB tabs of a work in the sidebar tree', () => {
  const browser = (id: string, group: string | null, cwd?: string): TerminalInfo => ({ id, host: '', username: '', connected: true, browser: { group, cwd } })

  it('lists them under the worktree they belong to, in the order given', () => {
    const terminals = new Map<string, TerminalInfo>([
      ['local:1', local('local:1', 'D:\\work\\gsd')],
      ['browser:1', browser('browser:1', 'd:/work/gsd', 'D:\\work\\gsd-feature\\src')],
      ['ssh-1', inWork('ssh-1', 'home', 'd:/work/gsd')],
      ['db:1', db('db:1', 'ssh-1')],
      ['browser:2', browser('browser:2', 'd:/work/gsd')],
      ['browser:3', browser('browser:3', 'd:/work/app')]
    ])
    const byTree = workTabsByWorktree([...terminals.keys()], terminals, projects)
    // The browser opened from the feature worktree is listed there; the rest of gsd under its main checkout
    expect(byTree.get('D:\\work\\gsd-feature')).toEqual(['browser:1'])
    expect(byTree.get('D:\\work\\gsd')).toEqual(['ssh-1', 'db:1', 'browser:2'])
    expect(byTree.get('D:\\work\\app')).toEqual(['browser:3'])
  })

  it('leaves out local terminals and tabs of no project', () => {
    const terminals = new Map<string, TerminalInfo>([
      ['local:1', local('local:1', 'D:\\work\\gsd')],
      ['browser:1', browser('browser:1', GENERAL_GROUP)],
      ['ssh-2', ssh('ssh-2', 'unlinked')]
    ])
    expect(workTabsByWorktree([...terminals.keys()], terminals, projects).size).toBe(0)
  })
})
