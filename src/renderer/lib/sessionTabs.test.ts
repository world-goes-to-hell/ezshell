import { describe, it, expect } from 'vitest'
import { groupTabsBySession, findTabPane, badgeLabel, badgeHint } from './sessionTabs'
import type { TerminalInfo, LayoutState } from '../stores/terminalStore'

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
})

describe('findTabPane', () => {
  const split: LayoutState = {
    mode: 'split',
    direction: 'horizontal',
    primary: { terminalIds: ['1', '2'], activeTerminalId: '1' },
    secondary: { terminalIds: ['3'], activeTerminalId: '3' },
    activePaneType: 'primary'
  }

  it('finds a tab in the primary pane', () => {
    expect(findTabPane(split, '2')).toBe('primary')
  })

  it('finds a tab in the secondary pane', () => {
    expect(findTabPane(split, '3')).toBe('secondary')
  })

  it('returns null for a tab in neither pane', () => {
    expect(findTabPane(split, '9')).toBeNull()
  })

  it('returns null when the layout is not split', () => {
    const single: LayoutState = { ...split, mode: 'single', secondary: null, activePaneType: null }

    expect(findTabPane(single, '1')).toBeNull()
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
