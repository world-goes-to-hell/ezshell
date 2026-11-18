import { describe, it, expect } from 'vitest'
import { isSameSession, mergeBlock, mergeChoices, mergeAxis } from './tabMerge'
import type { TerminalInfo } from '../stores/terminalStore'
import type { SplitNode } from './splitTree'

const ssh = (id: string, saved: string | undefined, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id, host: '10.0.0.5', username: 'deploy', connected: true, title: 'web',
  connectConfig: { host: '10.0.0.5', port: 22, username: 'deploy', savedSessionId: saved } as TerminalInfo['connectConfig'],
  ...extra
})
const local = (id: string): TerminalInfo => ({ id, host: '이 PC', username: '', connected: true, local: { shell: 'PowerShell' } as TerminalInfo['local'] })
const tabsOf = (...tabs: TerminalInfo[]) => new Map(tabs.map(tab => [tab.id, tab]))
const pane = (id: string): SplitNode => ({ kind: 'pane', pane: id })
const split = (first: SplitNode, second: SplitNode): SplitNode => ({ kind: 'split', axis: 'row', ratio: 0.5, first, second })

describe('isSameSession', () => {
  it('is the same saved session', () => {
    expect(isSameSession(ssh('a', 's1'), ssh('b', 's1'))).toBe(true)
    expect(isSameSession(ssh('a', 's1'), ssh('b', 's2'))).toBe(false)
  })

  it('does not match a saved session with a quick connect to the same server', () => {
    expect(isSameSession(ssh('a', 's1'), ssh('b', undefined))).toBe(false)
  })

  it('matches quick connects by server and account', () => {
    expect(isSameSession(ssh('a', undefined), ssh('b', undefined))).toBe(true)
    expect(isSameSession(ssh('a', undefined), ssh('b', undefined, { connectConfig: { host: '10.0.0.5', port: 22, username: 'root' } as TerminalInfo['connectConfig'] }))).toBe(false)
  })

  it('matches terminals of this PC only with each other', () => {
    expect(isSameSession(local('local:1'), local('local:2'))).toBe(true)
    expect(isSameSession(local('local:1'), ssh('a', 's1'))).toBe(false)
  })
})

describe('mergeBlock', () => {
  it('allows two connected tabs of one session', () => {
    expect(mergeBlock(tabsOf(ssh('a', 's1'), ssh('b', 's1')), 'a', 'b')).toBeNull()
  })

  it('tells that a tab of another session cannot be merged', () => {
    expect(mergeBlock(tabsOf(ssh('a', 's1'), ssh('b', 's2')), 'a', 'b')).toMatch('다른 세션의 탭은 병합할 수 없습니다')
  })

  it('refuses a tab onto itself, a missing tab and a DB tab', () => {
    const tabs = tabsOf(ssh('a', 's1'), { ...ssh('db:1', 's1'), db: { dbId: '1', sshSessionId: 'x' } as TerminalInfo['db'] })
    expect(mergeBlock(tabs, 'a', 'a')).toMatch('같은 탭')
    expect(mergeBlock(tabs, 'a', 'nope')).toMatch('찾지 못했습니다')
    expect(mergeBlock(tabs, 'a', 'db:1')).toMatch('DB 탭')
  })

  it('refuses a disconnected tab on either side', () => {
    expect(mergeBlock(tabsOf(ssh('a', 's1', { connected: false }), ssh('b', 's1')), 'a', 'b')).toMatch('연결된 탭끼리만')
    expect(mergeBlock(tabsOf(ssh('a', 's1'), ssh('b', 's1', { connected: false })), 'a', 'b')).toMatch('연결된 탭끼리만')
  })

  it('refuses a source tab that is divided into panes', () => {
    const divided = ssh('a', 's1', { splitTree: split(pane('main'), pane('split-1')) })
    expect(mergeBlock(tabsOf(divided, ssh('b', 's1')), 'a', 'b')).toMatch('칸을 나눈 탭')
  })

  it('refuses a full target, unless it has an empty place', () => {
    const six = split(split(pane('main'), pane('split-1')), split(split(pane('split-2'), pane('split-3')), split(pane('split-4'), pane('split-5'))))
    expect(mergeBlock(tabsOf(ssh('a', 's1'), ssh('b', 's1', { splitTree: six })), 'a', 'b')).toMatch('6칸까지')
    const withVacant = split(split(pane('main'), pane('split-1')), split(split(pane('split-2'), pane('split-3')), split(pane('split-4'), { kind: 'vacant', pane: 'split-5' })))
    expect(mergeBlock(tabsOf(ssh('a', 's1'), ssh('b', 's1', { splitTree: withVacant })), 'a', 'b')).toBeNull()
  })

  it('refuses a source whose connection a DB tab or a port forward uses', () => {
    const dbTab: TerminalInfo = { id: 'db:1', host: '', username: '', connected: true, db: { dbId: '1', sshSessionId: 'a' } as TerminalInfo['db'] }
    expect(mergeBlock(tabsOf(ssh('a', 's1'), ssh('b', 's1'), dbTab), 'a', 'b')).toMatch('DB 탭이 있어')
    expect(mergeBlock(tabsOf(ssh('a', 's1'), ssh('b', 's1')), 'a', 'b', true)).toMatch('포트 포워딩')
  })
})

describe('mergeChoices', () => {
  it('lists the other tabs of the same session with their place in the tab strip', () => {
    const tabs = tabsOf(ssh('a', 's1'), ssh('x', 's2'), ssh('b', 's1'), ssh('c', 's1', { connected: false }))
    const choices = mergeChoices(tabs, 'a')
    expect(choices.map(choice => choice.id)).toEqual(['b', 'c'])
    expect(choices[0]).toMatchObject({ label: 'web (3번째 탭)', blocked: null })
    expect(choices[1].blocked).toMatch('연결된 탭끼리만')
  })

  it('is empty for a tab alone in its session', () => {
    expect(mergeChoices(tabsOf(ssh('a', 's1'), ssh('x', 's2')), 'a')).toEqual([])
  })
})

describe('mergeAxis', () => {
  it('puts the new pane beside a wide pane and below a tall one', () => {
    expect(mergeAxis(1200, 600)).toBe('row')
    expect(mergeAxis(500, 900)).toBe('col')
  })

  it('uses the direction that still fits, or none', () => {
    expect(mergeAxis(300, 400)).toBe('col')
    expect(mergeAxis(600, 150)).toBe('row')
    expect(mergeAxis(300, 150)).toBeNull()
  })
})
