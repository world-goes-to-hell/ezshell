import { buildScreens } from './screenPanes'
import { describe, it, expect } from 'vitest'
import { buildRestoreRecord, readRestoreRecord, readTree, cdCommand, withoutVacants, reopenable, LOCAL_RESTORE_MAX_PANES, type RecordSource } from './restoreTabs'
import type { TerminalInfo, LayoutState } from '../stores/terminalStore'
import type { SplitNode } from './splitTree'

const pane = (id: string): SplitNode => ({ kind: 'pane', pane: id })
const row = (first: SplitNode, second: SplitNode): SplitNode => ({ kind: 'split', axis: 'row', ratio: 0.5, first, second })
const names = (count: number) => Array.from({ length: count }, (_, index) => index === 0 ? 'main' : `split-${index}`)
const balanced = (ids: string[]): SplitNode => {
  if (ids.length === 1) return pane(ids[0])
  const middle = Math.floor(ids.length / 2)
  return row(balanced(ids.slice(0, middle)), balanced(ids.slice(middle)))
}
const config = (extra: Record<string, unknown>) => ({ host: '10.0.0.5', port: 22, username: 'deploy', authType: 'password', password: 'secret-pw', ...extra }) as unknown as TerminalInfo['connectConfig']
const ssh = (id: string, saved: string | null, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, host: '10.0.0.5', username: 'deploy', connected: true, connectConfig: config({ savedSessionId: saved }), ...extra })
const single = (ids: string[]): LayoutState => buildScreens({ panes: [{ terminalIds: ids, activeTerminalId: ids[0] ?? null }] })
const source = (tabs: TerminalInfo[], extra: Partial<RecordSource> = {}): RecordSource => ({
  terminals: new Map(tabs.map(tab => [tab.id, tab])), layout: single(tabs.map(tab => tab.id)), activeId: tabs[0]?.id ?? null,
  sftpPathOf: () => null, detached: [], ...extra
})

describe('agents in local tabs', () => {
  const CLAUDE = 'abcdef12-1111-4222-8333-444455556666'
  const CODEX = '01a1ec18-9b8a-71c1-839d-2e31c010300f'
  const local = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, host: '이 PC', username: '', connected: true, local: { shell: 'PowerShell', cwd: 'D:\work\gsd' }, ...extra })

  it('keeps which agent session ran in each pane of a local tab', () => {
    const record = buildRestoreRecord(source([local('local:1', { splitTree: row(pane('main'), pane('split-1')), paneSeq: 1 })], {
      agentsOf: () => [{ pane: 'main', agent: 'codex', sessionId: CODEX }, { pane: 'split-1', agent: 'claude', sessionId: CLAUDE }]
    }))
    expect(record.tabs[0]).toMatchObject({ kind: 'local', agents: [{ pane: 'main', agent: 'codex', sessionId: CODEX }, { pane: 'split-1', agent: 'claude', sessionId: CLAUDE }] })
  })

  it('round-trips all panes and their agents up to the local layout limit', () => {
    const ids = names(LOCAL_RESTORE_MAX_PANES)
    const splitTree = balanced(ids)
    const agents = ids.map(pane => ({ pane, agent: 'codex' as const, sessionId: CODEX, chat: true as const }))
    const record = buildRestoreRecord(source([local('local:1', { splitTree, paneSeq: ids.length - 1 })], { agentsOf: () => agents }))
    expect(readRestoreRecord(JSON.parse(JSON.stringify(record)))?.tabs[0]).toMatchObject({ splitTree, agents })
  })

  it('reads back only well-formed agents of panes the tab has', () => {
    const back = readRestoreRecord({ version: 1, tabs: [{
      kind: 'local', cwd: 'D:\work', splitTree: row(pane('main'), pane('split-1')), paneSeq: 1,
      agents: [
        { pane: 'main', agent: 'codex', sessionId: CODEX },
        { pane: 'split-1', agent: 'claude', sessionId: 'x; rm -rf /' },
        { pane: 'split-9', agent: 'claude', sessionId: CLAUDE },
        { pane: 'split-1', agent: 'bash', sessionId: CLAUDE }
      ]
    }] })
    expect(back?.tabs[0]).toMatchObject({ agents: [{ pane: 'main', agent: 'codex', sessionId: CODEX }] })
  })

  it('keeps whether a pane was a chat, and only as true', () => {
    const back = readRestoreRecord({ version: 1, tabs: [{
      kind: 'local', cwd: 'D:\\work', splitTree: row(pane('main'), pane('split-1')), paneSeq: 1,
      agents: [{ pane: 'main', agent: 'codex', chat: true }, { pane: 'split-1', agent: 'claude', chat: 'yes' }]
    }] })
    expect(back?.tabs[0]).toMatchObject({ agents: [{ pane: 'main', agent: 'codex', chat: true }] })
  })

  it('keeps an agent that never had a conversation (no session id), so it starts again fresh', () => {
    const record = buildRestoreRecord(source([local('local:1')], { agentsOf: () => [{ pane: 'main', agent: 'codex' }] }))
    expect(record.tabs[0]).toMatchObject({ agents: [{ pane: 'main', agent: 'codex' }] })
    const back = readRestoreRecord({ version: 1, tabs: [{ kind: 'local', cwd: 'D:\work', agents: [{ pane: 'main', agent: 'claude' }, { pane: 'main', agent: 'codex', sessionId: 'bad id' }] }] })
    expect(back?.tabs[0]).toMatchObject({ agents: [{ pane: 'main', agent: 'claude' }] })
  })

  it('leaves agents out when none ran', () => {
    expect(buildRestoreRecord(source([local('local:1')])).tabs[0]).not.toHaveProperty('agents')
  })
})

describe('buildRestoreRecord', () => {
  it('round-trips local tabs beyond the restore limit for other tabs', () => {
    const remote = Array.from({ length: 51 }, (_, index) => ssh(`ssh:${index}`, `session-${index}`))
    const local = Array.from({ length: 55 }, (_, index): TerminalInfo => ({
      id: `local:${index}`, host: '이 PC', username: '', connected: true, title: `셸 ${index}`, local: { shell: 'PowerShell' }
    }))
    const record = buildRestoreRecord(source([...remote, ...local], { activeId: local[54].id }))
    expect(record.tabs).toHaveLength(105)
    expect(record.active).toBe(104)

    // The reader may receive a record that still contains the extra remote tab.
    const raw = { ...record, tabs: [...record.tabs.slice(0, 50), { kind: 'ssh', savedSessionId: 'extra' }, ...record.tabs.slice(50)], active: 105 }
    const restored = readRestoreRecord(raw)
    expect(restored?.tabs.filter(tab => tab.kind === 'ssh')).toHaveLength(50)
    expect(restored?.tabs.filter(tab => tab.kind === 'local')).toHaveLength(55)
    expect(restored?.active).toBe(104)
    expect(restored?.tabs[104]?.title).toBe('셸 54')
  })

  it('keeps saved sessions, their layout and folders, never a password', () => {
    const record = buildRestoreRecord(source([
      ssh('1', 's1', { title: '운영 웹', color: '#ff0000', currentPath: '/var/log', splitTree: row(pane('main'), pane('split-1')), paneSeq: 1 }),
      ssh('2', 's2')
    ], { sftpPathOf: id => (id === '1' ? '/etc/nginx' : null), activeId: '2' }))
    expect(record.tabs).toEqual([
      { kind: 'ssh', savedSessionId: 's1', title: '운영 웹', color: '#ff0000', splitTree: row(pane('main'), pane('split-1')), paneSeq: 1, currentPath: '/var/log', sftpPath: '/etc/nginx' },
      { kind: 'ssh', savedSessionId: 's2', title: undefined, color: undefined, splitTree: undefined, paneSeq: undefined, currentPath: undefined, sftpPath: undefined }
    ])
    expect(record.active).toBe(1)
    expect(JSON.stringify(record)).not.toContain('secret-pw')
  })

  it('keeps a quick connect\'s login without its password', () => {
    const record = buildRestoreRecord(source([ssh('1', null)]))
    expect(record.tabs[0]).toEqual({ kind: 'quick', title: undefined, host: '10.0.0.5', port: 22, username: 'deploy', authType: 'password', privateKeyPath: undefined })
    expect(JSON.stringify(record)).not.toContain('secret-pw')
  })

  it('round-trips the work of saved, unsaved, and detached connections', () => {
    const record = buildRestoreRecord(source([
      ssh('1', 's1', { connectConfig: config({ savedSessionId: 's1', workGroup: 'd:/work/app' }) }),
      ssh('2', null, { connectConfig: config({ workGroup: 'folder:d:/work/other' }) })
    ], { detached: [{ connectConfig: config({ savedSessionId: 's3', workGroup: 'general' }) }] }))
    expect(readRestoreRecord(JSON.parse(JSON.stringify(record)))?.tabs).toMatchObject([
      { kind: 'ssh', savedSessionId: 's1', workGroup: 'd:/work/app' },
      { kind: 'quick', workGroup: 'folder:d:/work/other' },
      { kind: 'ssh', savedSessionId: 's3', workGroup: 'general' }
    ])
  })

  it('adds popped-out tabs, local terminals, and DB tabs after the tab they use', () => {
    const db: TerminalInfo = { id: 'db:9', host: 'db', username: 'reader', connected: true, title: 'MySQL', db: { dbId: '9', sshSessionId: '1', savedAccountId: 'acc-1' } }
    const unsavedDb: TerminalInfo = { id: 'db:10', host: 'db', username: 'x', connected: true, db: { dbId: '10', sshSessionId: '1' } }
    const local: TerminalInfo = { id: 'local:1', host: '이 PC', username: '', connected: true, title: 'PowerShell', local: { shell: 'PowerShell' } }
    const record = buildRestoreRecord(source([db, ssh('1', 's1'), unsavedDb, local], { detached: [{ connectConfig: config({ savedSessionId: 's3' }) }] }))
    expect(record.tabs.map(tab => tab.kind)).toEqual(['ssh', 'local', 'ssh', 'db'])
    expect(record.tabs[3]).toEqual({ kind: 'db', parent: 0, savedAccountId: 'acc-1', title: 'MySQL' })
  })

  it('keeps the two sides of a divided screen', () => {
    const layout: LayoutState = buildScreens({ panes: [{ terminalIds: ['1'], activeTerminalId: '1' }, { terminalIds: ['2', '3'], activeTerminalId: '3' }], activePane: 1, direction: 'vertical' })
    const record = buildRestoreRecord(source([ssh('1', 's1'), ssh('2', 's2'), ssh('3', 's3')], { layout }))
    expect(record.split).toEqual({
      direction: 'vertical', primary: [0], secondary: [1, 2], primaryActive: 0, secondaryActive: 2, focus: 'secondary',
      panes: [[0], [1, 2]], actives: [0, 2], sizes: [0.5, 0.5], focusPane: 1
    })
  })

  it('keeps three screens with their shares and reads them back', () => {
    const layout: LayoutState = buildScreens({
      panes: [{ terminalIds: ['1'], activeTerminalId: '1' }, { terminalIds: ['2'], activeTerminalId: '2' }, { terminalIds: ['3'], activeTerminalId: '3' }],
      sizes: [0.5, 0.25, 0.25], activePane: 2, direction: 'horizontal'
    })
    const record = buildRestoreRecord(source([ssh('1', 's1'), ssh('2', 's2'), ssh('3', 's3')], { layout }))
    expect(record.split).toMatchObject({ panes: [[0], [1], [2]], sizes: [0.5, 0.25, 0.25], focusPane: 2 })
    expect(readRestoreRecord(JSON.parse(JSON.stringify(record)))?.split).toMatchObject({ panes: [[0], [1], [2]], actives: [0, 1, 2], sizes: [0.5, 0.25, 0.25], focusPane: 2 })
  })
})

describe('withoutVacants', () => {
  it('drops empty places, and the division when one pane is left', () => {
    expect(withoutVacants(row(pane('main'), { kind: 'vacant', pane: 'split-1' }))).toBeUndefined()
    const tree = row(pane('main'), row(pane('split-2'), { kind: 'vacant', pane: 'split-1' }))
    expect(withoutVacants(tree)).toEqual(row(pane('main'), pane('split-2')))
  })
})

describe('readRestoreRecord', () => {
  const good = { version: 1, tabs: [
    { kind: 'ssh', savedSessionId: 's1', splitTree: row(pane('main'), pane('split-1')), paneSeq: 1, currentPath: '/srv' },
    { kind: 'db', parent: 0, savedAccountId: 'acc-1' },
    { kind: 'quick', host: 'h', port: 2222, username: 'u' }
  ], active: 2 }

  it('reads back a record it wrote', () => {
    const record = readRestoreRecord(good)!
    expect(record.tabs).toHaveLength(3)
    expect(record.active).toBe(2)
    expect(reopenable(record)).toHaveLength(2)
  })

  it('leaves out tabs it cannot read and keeps the others pointing at the right tabs', () => {
    // As written: the DB tab names the SSH tab by its place in this list (1)
    const record = readRestoreRecord({ version: 1, tabs: [{ kind: 'nope' }, good.tabs[0], { ...good.tabs[1], parent: 1 }, good.tabs[2]], active: 3 })!
    expect(record.tabs.map(tab => tab.kind)).toEqual(['ssh', 'db', 'quick'])
    expect(record.tabs[1]).toMatchObject({ parent: 0 })
    expect(record.active).toBe(2)
  })

  it('refuses bad trees, paths with line breaks and DB tabs without their SSH tab', () => {
    const record = readRestoreRecord({ version: 1, tabs: [
      { kind: 'ssh', savedSessionId: 's1', splitTree: row(pane('split-1'), pane('split-2')), currentPath: '/srv\nrm -rf /' },
      { kind: 'ssh', savedSessionId: 's2', splitTree: row(pane('main'), pane('main')) },
      { kind: 'db', parent: 5, savedAccountId: 'a' },
      { kind: 'quick', host: 'h\u0007', username: 'u' }
    ] })!
    expect(record.tabs).toHaveLength(2)
    expect(record.tabs[0]).toMatchObject({ splitTree: undefined, currentPath: undefined })
    expect(record.tabs[1]).toMatchObject({ splitTree: undefined })
  })

  it('keeps six SSH panes and seven local panes, but skips an oversized local layout', () => {
    const six = balanced(names(6))
    const seven = balanced(names(7))
    const oversized = balanced(names(LOCAL_RESTORE_MAX_PANES + 1))
    const record = readRestoreRecord({ version: 1, tabs: [
      { kind: 'ssh', savedSessionId: 's1', splitTree: six },
      { kind: 'ssh', savedSessionId: 's2', splitTree: seven },
      { kind: 'local', splitTree: seven },
      { kind: 'local', splitTree: oversized }
    ] })!
    expect(record.tabs.map(tab => 'splitTree' in tab ? tab.splitTree : undefined)).toEqual([six, undefined, seven, undefined])
  })

  it('rejects a local tree too deep to reach its first pane safely', () => {
    const deep = names(LOCAL_RESTORE_MAX_PANES + 1).slice(1)
      .reduce((tree, id) => row(tree, pane(id)), pane('main'))
    expect(readTree(deep, 'local')).toBeUndefined()
  })

  it('is null for something that is not a record', () => {
    expect(readRestoreRecord(null)).toBeNull()
    expect(readRestoreRecord({ version: 2, tabs: [] })).toBeNull()
    expect(readRestoreRecord({ version: 1, tabs: [{ kind: 'nope' }] })).toBeNull()
  })
})

describe('cdCommand', () => {
  it('quotes the folder and leaves ~ for the shell to expand', () => {
    expect(cdCommand('/var/log')).toBe(`cd -- '/var/log'\r`)
    expect(cdCommand("/srv/it's here")).toBe(`cd -- '/srv/it'\\''s here'\r`)
    expect(cdCommand('~')).toBe('cd ~\r')
    expect(cdCommand('~/app/logs')).toBe(`cd -- ~/'app/logs'\r`)
  })

  it('sends nothing for an unknown, relative or unsafe folder', () => {
    expect(cdCommand(undefined)).toBeNull()
    expect(cdCommand('logs')).toBeNull()
    expect(cdCommand('/srv\nreboot')).toBeNull()
    expect(cdCommand('/srv x')).toBeNull()
  })
})
