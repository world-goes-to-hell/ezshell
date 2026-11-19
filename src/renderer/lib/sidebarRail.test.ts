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
    expect(railCounts(terminals, new Set(['home']))).toEqual({
      sessions: { connected: 1, lost: 0 },
      local: { terminals: 1, connected: 1, lost: 1 }
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
