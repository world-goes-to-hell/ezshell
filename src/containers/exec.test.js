import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { runCommand } from './exec.js'

function fakeConn(script) {
  return {
    exec(command, callback) {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = vi.fn(() => setImmediate(() => stream.emit('close')))
      setImmediate(() => {
        callback(null, stream)
        script(stream, command)
      })
      return stream
    }
  }
}

describe('runCommand', () => {
  it('collects output, error output and the exit code', async () => {
    const conn = fakeConn((stream) => {
      stream.emit('data', Buffer.from('one\n'))
      stream.stderr.emit('data', Buffer.from('warn\n'))
      stream.emit('data', Buffer.from('two\n'))
      stream.emit('exit', 3)
      stream.emit('close')
    })
    expect(await runCommand(conn, 'x')).toEqual({ ok: true, stdout: 'one\ntwo\n', stderr: 'warn\n', exitCode: 3, truncated: false })
  })

  it('closes the channel once the output passes the limit', async () => {
    let channel
    const conn = fakeConn((stream) => {
      channel = stream
      stream.emit('data', Buffer.alloc(60, 'a'))
      stream.emit('data', Buffer.alloc(60, 'b'))
      stream.emit('data', Buffer.alloc(60, 'c'))
    })
    const result = await runCommand(conn, 'x', { maxBytes: 100 })
    expect(result).toMatchObject({ ok: true, truncated: true })
    expect(result.stdout).toBe('a'.repeat(60))
    expect(channel.close).toHaveBeenCalled()
  })

  it('gives up and closes the channel when the command does not end in time', async () => {
    let channel
    const conn = fakeConn((stream) => { channel = stream })
    const result = await runCommand(conn, 'x', { timeoutMs: 20 })
    expect(result).toEqual({ ok: false, error: '서버가 제시간에 응답하지 않았습니다.' })
    expect(channel.close).toHaveBeenCalled()
  })

  it('reports a channel that could not be opened without leaking the reason', async () => {
    const conn = { exec: (command, callback) => setImmediate(() => callback(new Error('open failed on 10.0.0.5'))) }
    expect(await runCommand(conn, 'x')).toEqual({ ok: false, error: '서버에서 명령을 실행하지 못했습니다.' })
    const throwing = { exec: () => { throw new Error('not connected') } }
    expect(await runCommand(throwing, 'x')).toEqual({ ok: false, error: '서버에서 명령을 실행하지 못했습니다.' })
  })
})
