import { describe, it, expect, vi } from 'vitest'
import { isShared, release, newSessionId, addGuest, releaseGuest, sameServer } from './sharedConn.js'

const session = (conn, extra = {}) => ({ conn, stream: { close: vi.fn() }, ...extra })
const connection = () => ({ end: vi.fn() })

describe('shared SSH connection (a split shell moved out to a tab)', () => {
  it('knows when another session uses the same connection', () => {
    const conn = connection()
    const sessions = new Map([['a', session(conn)], ['b', session(conn)], ['c', session(connection())]])
    expect(isShared(sessions, conn, 'a')).toBe(true)
    expect(isShared(sessions, sessions.get('c').conn, 'c')).toBe(false)
    expect(isShared(sessions, null, 'a')).toBe(false)
  })

  it('closes only the channel while the connection is shared', () => {
    const conn = connection()
    const leaving = session(conn)
    const sessions = new Map([['b', session(conn)]])
    expect(release(sessions, 'a', leaving)).toBe('channel')
    expect(leaving.stream.close).toHaveBeenCalledTimes(1)
    expect(conn.end).not.toHaveBeenCalled()
  })

  it('ends the connection and its jump host with the last session', () => {
    const conn = connection()
    const jumpConn = connection()
    const last = session(conn, { jumpConn })
    expect(release(new Map([['other', session(connection())]]), 'a', last)).toBe('connection')
    expect(conn.end).toHaveBeenCalledTimes(1)
    expect(jumpConn.end).toHaveBeenCalledTimes(1)
    expect(last.stream.close).not.toHaveBeenCalled()
  })

  it('does not count the asking session when it is still on the list', () => {
    const conn = connection()
    const only = session(conn)
    expect(release(new Map([['a', only]]), 'a', only)).toBe('connection')
  })

  it('survives a channel or connection that is already closed', () => {
    const conn = { end: () => { throw new Error('closed') } }
    expect(release(new Map(), 'a', { conn, stream: null, jumpConn: { end: () => { throw new Error('closed') } } })).toBe('connection')
    const shared = connection()
    const broken = { conn: shared, stream: { close: () => { throw new Error('closed') } } }
    expect(release(new Map([['b', session(shared)]]), 'a', broken)).toBe('channel')
  })

  it('gives a session id that is not in use', () => {
    expect(newSessionId(new Map(), 1000)).toBe('1000')
    expect(newSessionId(new Map([['1000', {}], ['1001', {}]]), 1000)).toBe('1002')
  })
})

describe('guest shells (a tab merged into another tab on a different connection)', () => {
  it('keeps the connection while the guest shell is open, and ends it with the shell', () => {
    const conn = connection()
    const jumpConn = connection()
    const stream = {}
    addGuest(stream, conn, jumpConn)
    // No tab session holds the connection, yet it counts as in use
    expect(isShared(new Map(), conn, 'a')).toBe(true)
    expect(releaseGuest(new Map(), stream)).toBe('connection')
    expect(conn.end).toHaveBeenCalledTimes(1)
    expect(jumpConn.end).toHaveBeenCalledTimes(1)
    expect(isShared(new Map(), conn, 'a')).toBe(false)
  })

  it('leaves a connection that a tab or another guest still uses', () => {
    const conn = connection()
    const first = {}
    const second = {}
    addGuest(first, conn)
    addGuest(second, conn)
    expect(releaseGuest(new Map(), first)).toBe('kept')
    expect(releaseGuest(new Map([['tab', session(conn)]]), second)).toBe('kept')
    expect(conn.end).not.toHaveBeenCalled()
  })

  it('a closing tab closes only its channel while a guest shares its connection', () => {
    const conn = connection()
    const stream = {}
    addGuest(stream, conn)
    const closing = session(conn)
    expect(release(new Map(), 'a', closing)).toBe('channel')
    expect(conn.end).not.toHaveBeenCalled()
    expect(releaseGuest(new Map(), stream)).toBe('connection')
  })

  it('closes both correctly when a tab keeps its transport but promotes a shell on another one', () => {
    const original = connection()
    const actual = connection()
    const promoted = session(original)
    addGuest(promoted.stream, actual)
    const connections = new Map([['other', session(actual)]])
    expect(release(connections, 'main', promoted)).toBe('connection')
    expect(promoted.stream.close).toHaveBeenCalledTimes(1)
    expect(original.end).toHaveBeenCalledTimes(1)
    expect(releaseGuest(connections, promoted.stream)).toBe('kept')
    expect(actual.end).not.toHaveBeenCalled()
  })

  it('ignores a shell that is not a guest', () => {
    expect(releaseGuest(new Map(), {})).toBe('none')
  })
})

describe('sameServer', () => {
  const login = { host: '10.0.0.5', port: 22, username: 'deploy' }

  it('is the same account on the same server', () => {
    expect(sameServer(login, { ...login })).toBe(true)
    expect(sameServer(login, { host: '10.0.0.5', username: 'deploy' })).toBe(true) // default port
    expect(sameServer(login, { ...login, port: '22' })).toBe(true)
  })

  it('differs by host, port, account or jump host', () => {
    expect(sameServer(login, { ...login, host: '10.0.0.6' })).toBe(false)
    expect(sameServer(login, { ...login, port: 2222 })).toBe(false)
    expect(sameServer(login, { ...login, username: 'root' })).toBe(false)
    expect(sameServer(login, { ...login, useJumpHost: true, jumpHost: 'gw', jumpPort: 22 })).toBe(false)
    expect(sameServer({ ...login, useJumpHost: true, jumpHost: 'gw' }, { ...login, useJumpHost: true, jumpHost: ' gw ', jumpPort: 22 })).toBe(true)
  })

  it('is false without a login', () => {
    expect(sameServer(undefined, login)).toBe(false)
    expect(sameServer({}, {})).toBe(false)
  })
})
