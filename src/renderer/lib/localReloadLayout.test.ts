import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '../stores/terminalStore'
import { paneIds, type SplitNode } from './splitTree'
import { planReloadedTabs, readReloadLayout, snapshotLocalTabs, type ReloadTab } from './localReloadLayout'
import type { LiveLocalShell } from './localShellAdopt'
import { LOCAL_RESTORE_MAX_PANES, readRestoreRecord } from './restoreTabs'

const pane = (id: string): SplitNode => ({ kind: 'pane', pane: id })
const row = (first: SplitNode, second: SplitNode): SplitNode => ({ kind: 'split', axis: 'row', ratio: 0.5, first, second })
const shell = (id: string, over: Partial<LiveLocalShell> = {}): LiveLocalShell => ({ id, name: 'PowerShell', exited: false, cwd: null, agent: null, ...over })
const tree3 = row(pane('main'), row(pane('split-1'), pane('split-2')))

const saved = (over: Partial<ReloadTab> = {}): ReloadTab => ({
  tabId: 'local:1', mainShellId: 'local:1', title: 'gsd', shell: 'PowerShell', cwd: 'D:\\work\\gsd', workspaceLabel: 'gsd',
  splitTree: tree3, paneSeq: 2, panes: { 'split-1': 'local:2', 'split-2': 'local:3' }, ...over
})

describe('snapshotLocalTabs', () => {
  it('keeps each local tab with its tree and the shell of each pane, in tab order', () => {
    const terminals = new Map<string, TerminalInfo>([
      ['ssh-1', { id: 'ssh-1', host: 'h', username: 'u', connected: true }],
      ['local:1', { id: 'local:1', host: '이 PC', username: '', connected: true, title: 'gsd', isSplit: true, splitTree: tree3, paneSeq: 2,
        local: { shell: 'PowerShell', cwd: 'D:\\work\\gsd', workspaceLabel: 'gsd' } }],
      ['local:4', { id: 'local:4', host: '이 PC', username: '', connected: true, title: 'PowerShell', local: { shell: 'PowerShell', shellId: 'local:9' } }]
    ])
    const shells: Record<string, string> = { 'local:1\nsplit-1': 'local:2', 'local:1\nsplit-2': 'local:3' }
    const tabs = snapshotLocalTabs(terminals, (tabId, id) => shells[`${tabId}\n${id}`])
    expect(tabs).toEqual([
      saved(),
      { tabId: 'local:4', mainShellId: 'local:9', title: 'PowerShell', shell: 'PowerShell', panes: {} }
    ])
  })
})

describe('chat panes', () => {
  it('records the panes that show their agent as a chat, the main pane included', () => {
    const terminals = new Map<string, TerminalInfo>([
      ['local:1', { id: 'local:1', host: '이 PC', username: '', connected: true, title: 'gsd', isSplit: true, splitTree: tree3, paneSeq: 2, local: { shell: 'PowerShell' } }]
    ])
    const shells: Record<string, string> = { 'split-1': 'local:2', 'split-2': 'local:3' }
    const [tab] = snapshotLocalTabs(terminals, (_tab, id) => shells[id], shell => shell === 'local:1' || shell === 'local:3')
    expect(tab.chats).toEqual(['main', 'split-2'])
  })

  it('reads back only pane names, and keeps chats only of panes that came back', () => {
    const [read] = readReloadLayout([{ ...saved(), chats: ['main', 'split-2', '../x', 3, 'main'] }])
    expect(read.chats).toEqual(['main', 'split-2'])
    const [tab] = planReloadedTabs([shell('local:1'), shell('local:2')], [read]).tabs
    expect(tab.chats).toEqual(['main'])
  })
})

describe('readReloadLayout', () => {
  it('reads what was written', () => {
    expect(readReloadLayout(JSON.parse(JSON.stringify([saved()])))).toEqual([saved()])
  })

  it('keeps six-digit pane IDs and sequence numbers through reload and restart', () => {
    const id = 'split-123456'
    const splitTree = row(pane('main'), pane(id))
    const paneSeq = 999_999
    const reload = saved({ splitTree, paneSeq, panes: { [id]: 'local:2' }, chats: [id] })
    const agents = [{ pane: id, agent: 'codex', chat: true }]
    const restart = { kind: 'local', splitTree, paneSeq, agents }

    expect(readReloadLayout([reload])[0]).toEqual(reload)
    expect(readRestoreRecord({ version: 1, tabs: [restart] })?.tabs[0]).toMatchObject(restart)
    expect(readReloadLayout([{ ...reload, paneSeq: paneSeq + 1 }])[0].paneSeq).toBeUndefined()
    expect(readRestoreRecord({ version: 1, tabs: [{ ...restart, splitTree: row(pane('main'), pane('split-1000000')) }] })?.tabs[0])
      .toMatchObject({ splitTree: undefined, paneSeq: undefined })
  })

  it('puts eight running shells and chat views back into their original panes', () => {
    let splitTree = pane('main')
    for (let index = 1; index < 8; index++) splitTree = row(splitTree, pane(`split-${index}`))
    const chats = paneIds(splitTree)
    const panes = Object.fromEntries(chats.slice(1).map((id, index) => [id, `local:${index + 2}`]))
    const [read] = readReloadLayout([saved({ splitTree, paneSeq: 7, panes: { ...panes, 'split-99': 'local:99' }, chats: [...chats, 'split-99'] })])
    const shells = ['local:1', ...Object.values(panes), 'local:99'].map(id => shell(id))
    const result = planReloadedTabs(shells, [read])
    expect(result.tabs[0]).toMatchObject({ splitTree, paneSeq: 7, panes, chats })
    expect(result.loose.map(item => item.id)).toEqual(['local:99'])
  })

  it('leaves shells from a layout beyond the saved limit available as separate tabs', () => {
    let splitTree = pane('main')
    for (let index = 1; index <= LOCAL_RESTORE_MAX_PANES; index++) splitTree = row(splitTree, pane(`split-${index}`))
    const read = readReloadLayout([saved({ splitTree, chats: ['main', 'split-1'] })])
    const result = planReloadedTabs([shell('local:1'), shell('local:2')], read)
    expect(result.tabs[0]).toMatchObject({ panes: {}, chats: ['main'] })
    expect(result.tabs[0].splitTree).toBeUndefined()
    expect(result.loose.map(item => item.id)).toEqual(['local:2'])
  })

  it('drops entries with bad ids, trees or text instead of trusting them', () => {
    const bad = [
      saved({ tabId: 'ssh-1' }),
      saved({ mainShellId: 'local:x' }),
      { ...saved(), panes: { 'split-1': '../etc' } },
      { ...saved(), title: 'a\nb' }
    ]
    const read = readReloadLayout(bad)
    expect(read).toHaveLength(2)
    expect(read[0].panes).toEqual({})
    expect(read[1].title).toBeUndefined()
    expect(readReloadLayout('nope')).toEqual([])
    expect(readReloadLayout([{ ...saved(), splitTree: { kind: 'split', axis: 'row', first: pane('split-1'), second: pane('split-2') } }])[0].splitTree).toBeUndefined()
  })
})

describe('planReloadedTabs', () => {
  it('restores an open run preset log while keeping unseen preset shells in the background', () => {
    const development = { taskId: 'preset:fixture', runPreset: true, name: 'Fixture', label: 'Fixture',
      status: 'running', exitCode: null, url: null } as const
    const background = shell('local:4', { development })
    const openedLog = shell('local:1', { exited: true, development: { ...development, status: 'exited', exitCode: 1 } })
    const regular = shell('local:5')
    const layout = saved({ splitTree: undefined, paneSeq: undefined, panes: {} })
    expect(planReloadedTabs([background, openedLog, regular], [layout])).toEqual({ tabs: [layout], loose: [regular] })
    expect(planReloadedTabs([background, openedLog, regular], [])).toEqual({ tabs: [], loose: [regular] })
  })

  it('puts the pane shells back into their tab', () => {
    const { tabs, loose } = planReloadedTabs([shell('local:1'), shell('local:2'), shell('local:3')], [saved()])
    expect(loose).toEqual([])
    expect(tabs).toHaveLength(1)
    expect(tabs[0].splitTree).toEqual(tree3)
    expect(tabs[0].panes).toEqual({ 'split-1': 'local:2', 'split-2': 'local:3' })
  })

  it('closes up a pane whose shell is gone, and drops the tree when one pane is left', () => {
    const one = planReloadedTabs([shell('local:1'), shell('local:3')], [saved()]).tabs[0]
    expect(one.splitTree).toEqual(row(pane('main'), pane('split-2')))
    expect(one.panes).toEqual({ 'split-2': 'local:3' })
    const alone = planReloadedTabs([shell('local:1')], [saved()]).tabs[0]
    expect(alone.splitTree).toBeUndefined()
    expect(alone.paneSeq).toBeUndefined()
  })

  it('without the main shell the tab is not rebuilt: its shells come back as tabs of their own', () => {
    const { tabs, loose } = planReloadedTabs([shell('local:2'), shell('local:3')], [saved()])
    expect(tabs).toEqual([])
    expect(loose.map(s => s.id)).toEqual(['local:2', 'local:3'])
  })

  it('gives a shell to one pane only, and leaves unknown shells as tabs', () => {
    const twice = saved({ tabId: 'local:5', mainShellId: 'local:5', panes: { 'split-1': 'local:2', 'split-2': 'local:9' } })
    const { tabs, loose } = planReloadedTabs([shell('local:1'), shell('local:2'), shell('local:3'), shell('local:5'), shell('local:7')], [saved(), twice])
    expect(tabs[0].panes).toEqual({ 'split-1': 'local:2', 'split-2': 'local:3' })
    expect(tabs[1].splitTree).toBeUndefined()
    expect(loose.map(s => s.id)).toEqual(['local:7'])
  })
})
