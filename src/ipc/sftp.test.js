import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { registerSftpIpc } from './sftp.js'

function fakeConnection() {
  const opening = []
  const conn = { sftp: vi.fn(callback => opening.push(callback)) }
  const finish = (index) => {
    const channel = Object.assign(new EventEmitter(), { end: vi.fn() })
    opening[index](null, channel)
    return channel
  }
  return { conn, finish }
}

function setup() {
  const handlers = new Map()
  const ssh = fakeConnection()
  const sessionId = 'tab-1'
  const sshConnections = new Map([[sessionId, { conn: ssh.conn }]])
  registerSftpIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, sshConnections })
  const open = () => handlers.get('sftp-open')({}, { sessionId })
  const close = () => handlers.get('sftp-close')({}, { sessionId })
  return { open, close, ssh, sshConnections, sessionId }
}

describe('SFTP channel lifecycle', () => {
  it('uses one channel when several file lookups open SFTP together', async () => {
    const { open, close, ssh } = setup()
    const first = open()
    const parallel = Array.from({ length: 4 }, open)
    expect(ssh.conn.sftp).toHaveBeenCalledTimes(1)
    const channel = ssh.finish(0)
    expect(await first).toEqual({ success: true })
    for (const opened of await Promise.all(parallel)) expect(opened).toEqual({ success: true, alreadyOpen: true })
    await close()
    expect(channel.end).toHaveBeenCalledOnce()
  })

  it('closes a late channel when its open was cancelled, leaving the next channel in place', async () => {
    const { open, close, ssh } = setup()
    const cancelled = expect(open()).rejects.toThrow('SFTP 세션이 닫혔습니다')
    await close()
    const next = open()
    const stale = ssh.finish(0)
    const active = ssh.finish(1)
    await cancelled
    await expect(next).resolves.toEqual({ success: true })
    expect(stale.end).toHaveBeenCalledOnce()
    expect(active.end).not.toHaveBeenCalled()
    await expect(open()).resolves.toEqual({ success: true, alreadyOpen: true })
  })

  it('reuses the channel across shell promotion, and closes it when the transport changes', async () => {
    const { open, ssh, sshConnections, sessionId } = setup()
    const first = open()
    const channel = ssh.finish(0)
    await first
    sshConnections.set(sessionId, { conn: ssh.conn, stream: {} })
    await expect(open()).resolves.toEqual({ success: true, alreadyOpen: true })

    const reconnected = fakeConnection()
    sshConnections.set(sessionId, { conn: reconnected.conn })
    const next = open()
    expect(channel.end).toHaveBeenCalledOnce()
    const active = reconnected.finish(0)
    await next
    // A delayed close from the old channel must not forget the new one.
    channel.emit('close')
    await expect(open()).resolves.toEqual({ success: true, alreadyOpen: true })
    active.emit('close')
    const reopened = open()
    reconnected.finish(1)
    await expect(reopened).resolves.toEqual({ success: true })
  })
})
