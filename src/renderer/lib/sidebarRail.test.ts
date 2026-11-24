import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '../stores/terminalStore'
import { railCounts } from './sidebarRail'

const tab = (id: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, host: 'h', username: 'u', connected: true, ...extra })
const saved = (id: string, sessionId: string, connected = true) =>
  tab(id, { connected, connectConfig: { host: 'h', port: 22, username: 'u', savedSessionId: sessionId } as TerminalInfo['connectConfig'] })

describe('railCounts', () => {
  it('counts the tabs of a session tied to a local project under local work, not the session list', () => {
    const terminals = new Map([
      ['1', saved('1', 'home')],
      ['2', saved('2', 'web')],
      ['3', saved('3', 'home', false)],
      ['local:1', tab('local:1', { local: { shell: 'PowerShell' } })],
      ['db:1', tab('db:1', { db: { dbId: '1', sshSessionId: '2' } } as Partial<TerminalInfo>)]
    ])
    expect(railCounts(terminals, new Set(['1', '3']))).toEqual({
      sessions: { connected: 1, lost: 0 },
      local: { terminals: 1, connected: 1, lost: 1 }
    })
  })

  // 2026-11-24 user report: six browser tabs showed as seven connected sessions on the folded rail
  it('does not count browser tabs as sessions, in the list or under local work', () => {
    const terminals = new Map([
      ['1', saved('1', 'web')],
      ['browser:1', tab('browser:1', { browser: { group: null } })],
      ['browser:2', tab('browser:2', { browser: { group: 'project', cwd: 'D:\\work' } })]
    ])
    expect(railCounts(terminals, new Set(['browser:2']))).toEqual({
      sessions: { connected: 1, lost: 0 },
      local: { terminals: 0, connected: 0, lost: 0 }
    })
  })

  it('keeps quick connects and unlinked sessions in the session list', () => {
    const terminals = new Map([['1', tab('1')], ['2', saved('2', 'web', false)]])
    expect(railCounts(terminals, new Set())).toEqual({
      sessions: { connected: 1, lost: 1 },
      local: { terminals: 0, connected: 0, lost: 0 }
    })
  })
})
