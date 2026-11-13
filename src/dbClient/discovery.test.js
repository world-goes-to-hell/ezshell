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
      { engine: 'oracle', label: 'Oracle', host: '10.0.0.5', port: 1521, isLocalOnly: false, isSupported: true, isConfirmed: false },
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

describe('parseDiscovery: ports that are not the usual ones', () => {
  const PS = 'systemd\ndockerd\ndocker-proxy\ntnslsnr\nmysqld'

  it('finds a database Docker publishes on another port, by the container\'s port', () => {
    const ss = [
      'LISTEN 0 4096 0.0.0.0:51521 0.0.0.0:* users:(("docker-proxy",pid=2211,fd=4))',
      'LISTEN 0 4096    [::]:51521    [::]:* users:(("docker-proxy",pid=2217,fd=4))',
      'LISTEN 0 4096 0.0.0.0:55901 0.0.0.0:* users:(("docker-proxy",pid=2230,fd=4))'
    ].join('\n')
    const docker = [
      '0.0.0.0:51521->1521/tcp, :::51521->1521/tcp, 0.0.0.0:55901->5901/tcp|oracle/database:12.2|neworacle',
      '127.0.0.1:13306->3306/tcp|mariadb:10.11|shop-db',
      '5432/tcp|postgres:16|not-published',
      '0.0.0.0:8000-8010->8000-8010/tcp|nginx|web'
    ].join('\n')
    expect(parseDiscovery(`${ss}\n---ezshell---\n${PS}\n---ezshell---\n${docker}`)).toEqual([
      { engine: 'mysql', label: 'MariaDB', host: '127.0.0.1', port: 13306, isLocalOnly: true, isSupported: true, isConfirmed: true, container: 'shop-db' },
      { engine: 'oracle', label: 'Oracle', host: '127.0.0.1', port: 51521, isLocalOnly: false, isSupported: true, isConfirmed: true, container: 'neworacle' }
    ])
  })

  it('finds a database on another port by the process that listens there', () => {
    const ss = [
      'LISTEN 0 151 127.0.0.1:13307 0.0.0.0:* users:(("mysqld",pid=901,fd=22))',
      'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=700,fd=3))',
      'LISTEN 0 128 0.0.0.0:8080 0.0.0.0:* users:(("java",pid=800,fd=9))'
    ].join('\n')
    expect(parseDiscovery(`${ss}\n---ezshell---\nmysqld\nsshd\njava`)).toEqual([
      { engine: 'mysql', label: 'MySQL', host: '127.0.0.1', port: 13307, isLocalOnly: true, isSupported: true, isConfirmed: true }
    ])
    const netstat = 'tcp        0      0 0.0.0.0:15432           0.0.0.0:*               LISTEN      1234/postgres'
    expect(parseDiscovery(`${netstat}\n---ezshell---\npostgres`)).toEqual([
      { engine: 'postgres', label: 'PostgreSQL', host: '127.0.0.1', port: 15432, isLocalOnly: false, isSupported: true, isConfirmed: true }
    ])
  })

  it('reads only lists: the command connects to nothing and gives docker a time limit', () => {
    expect(DISCOVERY_COMMAND).toContain('ss -ltnpH')
    expect(DISCOVERY_COMMAND).toContain('timeout 3 docker ps')
    expect(DISCOVERY_COMMAND).not.toMatch(/mysql |psql|sqlplus|nc |telnet|curl/)
  })
})
