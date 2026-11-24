import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '../stores/terminalStore'
import { linkServer, parseProjectServers, projectKeyOf, projectsOfSession, sessionFromDrop, unlinkServer } from './localProjectServers'

const terminal = (over: Partial<TerminalInfo>): TerminalInfo => ({ id: 't', host: 'h', username: 'u', connected: true, ...over } as TerminalInfo)

describe('parseProjectServers', () => {
  it('keeps valid entries and drops broken ones', () => {
    expect(parseProjectServers(JSON.stringify({ 'd:/work/gsd': ['s1', 's1', 's2', 3, ''], bad: 'x', '': ['s3'] }))).toEqual({ 'd:/work/gsd': ['s1', 's2'] })
    expect(parseProjectServers('not json')).toEqual({})
    expect(parseProjectServers(JSON.stringify(['s1']))).toEqual({})
    expect(parseProjectServers(null)).toEqual({})
  })
})

describe('linking', () => {
  it('adds once, removes, and drops a project with nothing left', () => {
    const one = linkServer({}, 'p', 's1')
    expect(linkServer(one, 'p', 's1')).toEqual({ p: ['s1'] })
    const two = linkServer(one, 'p', 's2')
    expect(two).toEqual({ p: ['s1', 's2'] })
    expect(one).toEqual({ p: ['s1'] })
    expect(unlinkServer(two, 'p', 's1')).toEqual({ p: ['s2'] })
    expect(unlinkServer(one, 'p', 's1')).toEqual({})
  })

  it('finds the projects a session is linked to', () => {
    expect(projectsOfSession({ a: ['s1'], b: ['s2', 's1'] }, 's1')).toEqual(['a', 'b'])
  })
})

describe('projectKeyOf', () => {
  it('is the main checkout of the repository, compared without case or slash style on Windows', () => {
    expect(projectKeyOf({ worktrees: [{ path: 'D:\\work\\gsd-feature', isMain: false }, { path: 'D:\\work\\gsd', isMain: true }] }))
      .toBe(projectKeyOf({ worktrees: [{ path: 'd:/work/gsd/', isMain: true }] }))
  })
})

describe('sessionFromDrop', () => {
  const terminals = new Map<string, TerminalInfo>([
    ['ssh-1', terminal({ id: 'ssh-1', connectConfig: { savedSessionId: 's1' } as TerminalInfo['connectConfig'] })],
    ['quick-1', terminal({ id: 'quick-1', connectConfig: {} as TerminalInfo['connectConfig'] })],
    ['local:1', terminal({ id: 'local:1', local: { shell: 'PowerShell' } })],
    ['browser:1', terminal({ id: 'browser:1', browser: { group: null } })]
  ])
  const saved = new Set(['s1', 's2'])

  it('takes a saved session from a sidebar row or an SSH tab', () => {
    expect(sessionFromDrop('session:s2', terminals, saved)).toEqual({ sessionId: 's2' })
    expect(sessionFromDrop('ssh-1', terminals, saved)).toEqual({ sessionId: 's1' })
  })

  it('explains why a quick connect or a local tab cannot be linked', () => {
    expect(sessionFromDrop('quick-1', terminals, saved)).toMatchObject({ error: expect.stringContaining('저장한') })
    expect(sessionFromDrop('local:1', terminals, saved)).toMatchObject({ error: expect.stringContaining('SSH') })
    // A browser tab is not a quick connect to save first (2026-11-24)
    expect(sessionFromDrop('browser:1', terminals, saved)).toMatchObject({ error: expect.stringContaining('브라우저') })
  })

  it('ignores folders, unknown text and deleted sessions', () => {
    expect(sessionFromDrop('folder:f1', terminals, saved)).toBeNull()
    expect(sessionFromDrop('hello', terminals, saved)).toBeNull()
    expect(sessionFromDrop('session:gone', terminals, saved)).toBeNull()
  })
})
