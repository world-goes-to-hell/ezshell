import { buildScreens } from './screenPanes'
import { describe, it, expect } from 'vitest'
import { groupTabsBySession, findTabPane, badgeLabel, badgeHint, countSshTabs } from './sessionTabs'
import type { TerminalInfo, LayoutState } from '../stores/terminalStore'
import { singlePane, splitPane } from './splitTree'

const tab = (id: string, savedSessionId: string | undefined, overrides: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id,
  host: 'example.com',
  username: 'root',
  connected: true,
  connectConfig: { host: 'example.com', port: 22, username: 'root', authType: 'password', savedSessionId },
  ...overrides
})

const terminalsOf = (...tabs: TerminalInfo[]) => new Map(tabs.map(t => [t.id, t]))

const ids = (tabs: Array<{ id: string }>) => tabs.map(t => t.id)

describe('countSshTabs', () => {
  it('counts SSH connections and disconnections including quick connections', () => {
    const terminals = terminalsOf(
      tab('saved', 'web'),
      tab('quick', undefined),
      tab('retrying', 'web', { connected: false, reconnect: { attempt: 1, maxAttempts: 3 } }),
      tab('lost', 'web', { connected: false }),
      tab('local', undefined, { local: { shell: 'pwsh' } }),
      tab('db', undefined, { db: { dbId: 'db', sshSessionId: 'saved' } }),
      tab('browser', undefined, { browser: { group: null }, connected: false })
    )
    expect(countSshTabs(terminals)).toEqual({ connected: 2, reconnecting: 1, disconnected: 1 })
  })

  it('reports zero connected when every SSH tab is disconnected', () => {
    expect(countSshTabs(terminalsOf(tab('lost', undefined, { connected: false })))).toEqual({ connected: 0, reconnecting: 0, disconnected: 1 })
    expect(countSshTabs(new Map())).toEqual({ connected: 0, reconnecting: 0, disconnected: 0 })
  })
})

describe('groupTabsBySession', () => {
  it('returns an empty map when no tab is open', () => {
    expect(groupTabsBySession(new Map()).size).toBe(0)
  })

  it('groups tabs under the sidebar session they were opened from', () => {
    const groups = groupTabsBySession(terminalsOf(tab('1', 'web'), tab('2', 'db'), tab('3', 'web')))

    expect(ids(groups.get('web')!.connected)).toEqual(['1', '3'])
    expect(ids(groups.get('db')!.connected)).toEqual(['2'])
  })

  it('separates connected tabs from disconnected ones', () => {
    const groups = groupTabsBySession(terminalsOf(
      tab('1', 'web'),
      tab('2', 'web', { connected: false }),
      tab('3', 'web')
    ))

    expect(ids(groups.get('web')!.connected)).toEqual(['1', '3'])
    expect(ids(groups.get('web')!.disconnected)).toEqual(['2'])
  })

  it('ignores quick connects that are not tied to a sidebar session', () => {
    const groups = groupTabsBySession(terminalsOf(tab('1', undefined), tab('2', 'web', { connectConfig: undefined })))

    expect(groups.size).toBe(0)
  })

  it('labels a tab with its title, falling back to user@host', () => {
    const groups = groupTabsBySession(terminalsOf(tab('1', 'web', { title: '운영 웹' }), tab('2', 'web')))

    expect(groups.get('web')!.connected.map(t => t.label)).toEqual(['운영 웹', 'root@example.com'])
  })

  it('numbers tabs by their position among all open tabs', () => {
    const groups = groupTabsBySession(terminalsOf(tab('1', 'db'), tab('2', 'web'), tab('3', 'web')))

    expect(groups.get('web')!.connected.map(t => t.index)).toEqual([2, 3])
  })

  it('carries the current path so same-named tabs can be told apart', () => {
    const groups = groupTabsBySession(terminalsOf(tab('1', 'web', { currentPath: '/var/log' }), tab('2', 'web')))

    expect(groups.get('web')!.connected.map(t => t.path)).toEqual(['/var/log', undefined])
  })

  it('carries the layout of a split tab only (the list draws it)', () => {
    const split = splitPane(singlePane(), 'main', 'row', 'split-1')
    const groups = groupTabsBySession(terminalsOf(tab('1', 'web', { splitTree: split }), tab('2', 'web', { splitTree: singlePane() }), tab('3', 'web')))

    expect(groups.get('web')!.connected.map(t => t.splitTree)).toEqual([split, undefined, undefined])
  })
})

describe('findTabPane', () => {
  const split: LayoutState = buildScreens({
    panes: [{ terminalIds: ['1', '2'], activeTerminalId: '1' }, { terminalIds: ['3'], activeTerminalId: '3' }, { terminalIds: ['4'], activeTerminalId: '4' }],
    direction: 'horizontal'
  })

  it('finds the screen of a tab by its index', () => {
    expect(findTabPane(split, '2')).toBe(0)
    expect(findTabPane(split, '3')).toBe(1)
    expect(findTabPane(split, '4')).toBe(2)
  })

  it('returns null for a tab in no screen', () => {
    expect(findTabPane(split, '9')).toBeNull()
  })

  it('returns null when the layout is not split', () => {
    expect(findTabPane(buildScreens({ panes: [{ terminalIds: ['1'], activeTerminalId: '1' }] }), '1')).toBeNull()
  })
})

describe('badgeLabel', () => {
  it('describes connected tabs', () => {
    expect(badgeLabel('connected', 2)).toBe('연결된 탭 2개')
  })

  it('describes disconnected tabs', () => {
    expect(badgeLabel('disconnected', 1)).toBe('연결이 끊긴 탭 1개')
  })
})

describe('badgeHint', () => {
  it('says a single tab opens right away', () => {
    expect(badgeHint('connected', 1)).toBe('연결된 탭 1개 · 눌러서 이동')
  })

  it('says several tabs open a list', () => {
    expect(badgeHint('disconnected', 3)).toBe('연결이 끊긴 탭 3개 · 눌러서 선택')
  })
})
