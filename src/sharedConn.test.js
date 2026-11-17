import { describe, it, expect, vi } from 'vitest'
import { isShared, release, newSessionId } from './sharedConn.js'

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
