import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { parseDiscovery, runDiscoveryCommand, createDiscoveryCache, DISCOVERY_COMMAND } from './discovery.js'

const SS = [
  'LISTEN 0      151        127.0.0.1:3306       0.0.0.0:*',
  'LISTEN 0      244          0.0.0.0:5432       0.0.0.0:*',
  'LISTEN 0      244             [::]:5432          [::]:*',
  'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*',
  'LISTEN 0      511        10.0.0.5:1521        0.0.0.0:*'
].join('\n')

describe('parseDiscovery', () => {
  it('finds database ports in ss output and names them by process', () => {
    const found = parseDiscovery(`${SS}\n---ezshell---\nsystemd\nmysqld\npostgres\npostgres\n`)
    expect(found).toEqual([
      { engine: 'mysql', label: 'MySQL', host: '127.0.0.1', port: 3306, isLocalOnly: true, isSupported: true, isConfirmed: true },
      { engine: 'oracle', label: 'Oracle', host: '10.0.0.5', port: 1521, isLocalOnly: false, isSupported: false, isConfirmed: false },
      { engine: 'postgres', label: 'PostgreSQL', host: '127.0.0.1', port: 5432, isLocalOnly: false, isSupported: true, isConfirmed: true }
    ].sort((a, b) => a.port - b.port))
  })

  it('reads netstat output, IPv6 forms and an ss interface suffix', () => {
    const netstat = [
      'Active Internet connections (only servers)',
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State',
      'tcp        0      0 0.0.0.0:3307            0.0.0.0:*               LISTEN',
      'tcp6       0      0 :::5433                 :::*                    LISTEN',
      'LISTEN 0 80 127.0.0.1%lo:3306 0.0.0.0:*'
    ].join('\n')
    const found = parseDiscovery(`${netstat}\n---ezshell---\nmariadbd\n`)
    expect(found.map((d) => [d.port, d.host, d.label])).toEqual([
      [3306, '127.0.0.1', 'MariaDB'],
      [3307, '127.0.0.1', 'MariaDB'],
      [5433, '127.0.0.1', 'PostgreSQL']
    ])
    expect(found[2].isConfirmed).toBe(false)
  })

  it('says MySQL/MariaDB when no process name confirms it', () => {
    const [found] = parseDiscovery('LISTEN 0 80 *:3306 *:*\n---ezshell---\n')
    expect(found.label).toBe('MySQL/MariaDB')
    expect(found.isConfirmed).toBe(false)
  })

  it('returns nothing for empty or unexpected output', () => {
    expect(parseDiscovery('')).toEqual([])
    expect(parseDiscovery(undefined)).toEqual([])
    expect(parseDiscovery('command not found\n---ezshell---\n')).toEqual([])
  })
})

function fakeConn({ output = '', fail = null, hang = false } = {}) {
  const conn = { exec: vi.fn(), closed: 0 }
  conn.exec.mockImplementation((command, cb) => {
    if (fail) return cb(fail)
    const stream = new EventEmitter()
    stream.stderr = new EventEmitter()
    stream.close = () => { conn.closed++ }
    cb(null, stream)
    if (hang) return
    setImmediate(() => {
      stream.emit('data', Buffer.from(output))
      stream.emit('close')
    })
  })
  return conn
}

describe('runDiscoveryCommand', () => {
  it('runs the one discovery command and returns its output', async () => {
    const conn = fakeConn({ output: SS })
    await expect(runDiscoveryCommand(conn)).resolves.toBe(SS)
    expect(conn.exec).toHaveBeenCalledWith(DISCOVERY_COMMAND, expect.any(Function))
  })

  it('gives up and closes the channel when the server does not answer', async () => {
    const conn = fakeConn({ hang: true })
    await expect(runDiscoveryCommand(conn, { timeoutMs: 20 })).rejects.toThrow('timed out')
    expect(conn.closed).toBe(1)
  })
})

describe('createDiscoveryCache', () => {
  it('runs once per connection and treats a failure as nothing found', async () => {
    const run = vi.fn().mockResolvedValueOnce(`${SS}\n---ezshell---\nmysqld\n`).mockRejectedValueOnce(new Error('exec refused'))
    const cache = createDiscoveryCache({ run })
    const first = {}
    const second = {}
    expect((await cache.discover(first)).length).toBe(3)
    expect((await cache.discover(first)).length).toBe(3)
    expect(await cache.discover(second)).toEqual([])
    expect(run).toHaveBeenCalledTimes(2)
  })
})
