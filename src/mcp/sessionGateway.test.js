import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import gatewayModule from './sessionGateway.js'

const { createSessionGateway } = gatewayModule

const HOME = '/home/app'
const MARKER = '__EZSHELL_CWD_MISSING__'
const guard = (quotedDir) => `cd -- ${quotedDir} || { echo '${MARKER}' >&2; exit 1; }`
const STDIN_OFF = 'exec </dev/null'
/** What `run` sends: the cwd guard, stdin closed inside the script, then the command */
const script = (quotedDir, command) => `${guard(quotedDir)}\n${STDIN_OFF}\n${command}`
const inHome = (command) => script("'/home/app'", command)
const session = { id: 's1', name: 'dev', host: 'dev.example', port: 22, username: 'app', authType: 'password', password: 'pw' }
const CANCELLED = '요청이 취소되었습니다.'
const DROPPED = '서버와의 연결이 끊겼습니다.'

/**
 * Fake ssh2 Client. `respond(command)` returns { stdout?, stderr?, code?, hang? }; `pwd` answers HOME by default.
 * Options: pwdReply (reply for pwd), holdConnect (never becomes ready until the test emits 'ready'),
 * holdOpen(command) (channel-open callback is parked in `opens`), openError, execThrows.
 */
function fakeSsh({ respond = () => ({}), failWith, pwdReply, holdConnect, holdOpen, openError, execThrows } = {}) {
  const created = []
  const commands = []
  const streams = []
  const opens = []
  const createClient = () => {
    const client = new EventEmitter()
    client.ended = false
    client.connect = (options) => {
      client.options = options
      if (holdConnect) return
      setImmediate(() => (failWith ? client.emit('error', failWith) : client.emit('ready')))
    }
    client.end = () => { client.ended = true; client.emit('close') }
    client.forwardOut = (srcIp, srcPort, host, port, cb) => setImmediate(() => cb(null, { tunnelTo: `${host}:${port}` }))
    client.exec = (command, cb) => {
      if (execThrows) throw new Error('Not connected')
      commands.push(command)
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.signals = []
      stream.endCalls = 0
      // Like ssh2's Channel: once stdin is ended (EOF sent) the channel drops every later signal.
      stream.signal = (name) => { if (stream.endCalls === 0) stream.signals.push(name) }
      stream.end = () => { stream.endCalls++ }
      stream.close = () => setImmediate(() => stream.emit('close', null, 'KILL'))
      streams.push({ command, stream })
      if (openError) { setImmediate(() => cb(new Error('channel open failed'))); return }
      const reply = command === 'pwd' ? (pwdReply || { stdout: `${HOME}\n` }) : respond(command)
      const open = () => {
        cb(null, stream)
        if (reply.hang) return
        setImmediate(() => {
          if (reply.stdout) stream.emit('data', Buffer.isBuffer(reply.stdout) ? reply.stdout : Buffer.from(reply.stdout))
          if (reply.stderr) stream.stderr.emit('data', Buffer.from(reply.stderr))
          stream.emit('close', reply.code ?? 0, undefined)
        })
      }
      if (holdOpen && holdOpen(command)) { opens.push(open); return }
      setImmediate(open)
    }
    created.push(client)
    return client
  }
  return { createClient, created, commands, streams, opens }
}

describe('createSessionGateway', () => {
  it('starts in the home directory and runs the command there', async () => {
    const ssh = fakeSsh({ respond: () => ({ stdout: 'a\nb\n' }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const result = await gateway.run(session, 'ls -al')
    expect(ssh.commands).toEqual(['pwd', inHome('ls -al')])
    expect(result).toMatchObject({ cwd: HOME, exitCode: 0, stdout: 'a\nb\n', stderr: '', truncated: false, timedOut: false })
    gateway.closeAll()
  })

  it('puts the cd guard on its own line so a failed cd never runs the rest of a command list', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await gateway.run(session, 'make; rm -rf dist')
    const lines = ssh.commands.at(-1).split('\n')
    expect(lines).toEqual([guard("'/home/app'"), STDIN_OFF, 'make; rm -rf dist'])
    gateway.closeAll()
  })

  it('reuses one connection for several commands', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await gateway.run(session, 'ls')
    await gateway.run(session, 'pwd')
    expect(ssh.created).toHaveLength(1)
    gateway.closeAll()
  })

  it('reports a non-zero exit code and stderr', async () => {
    const ssh = fakeSsh({ respond: () => ({ stderr: 'no such file\n', code: 2 }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    expect(await gateway.run(session, 'cat x')).toMatchObject({ exitCode: 2, stderr: 'no such file\n' })
    gateway.closeAll()
  })

  it('changes directory and uses it for later commands', async () => {
    const ssh = fakeSsh({ respond: (command) => (command.includes('cd --') ? { stdout: "/var/log/it's app\n" } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    expect(await gateway.changeDirectory(session, "it's app")).toEqual({ cwd: "/var/log/it's app" })
    expect(ssh.commands[1]).toBe(`${guard("'/home/app'")}\ncd -- 'it'\\''s app' && pwd`)
    await gateway.run(session, 'ls')
    expect(ssh.commands[2]).toBe(script("'/var/log/it'\\''s app'", 'ls'))
    expect(gateway.getCwd('s1')).toBe("/var/log/it's app")
    gateway.closeAll()
  })

  it('keeps the directory when cd fails', async () => {
    const ssh = fakeSsh({ respond: () => ({ stderr: 'bash: cd: nope: No such file or directory\n', code: 1 }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await expect(gateway.changeDirectory(session, 'nope')).rejects.toMatchObject({ userMessage: 'bash: cd: nope: No such file or directory' })
    expect(gateway.getCwd('s1')).toBe(HOME)
    gateway.closeAll()
  })

  it('does not store a cd result that is not an absolute path', async () => {
    const ssh = fakeSsh({ respond: () => ({ stdout: 'weird\n' }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await expect(gateway.changeDirectory(session, 'x')).rejects.toMatchObject({ userMessage: '디렉터리로 이동할 수 없습니다.' })
    expect(gateway.getCwd('s1')).toBe(HOME)
    gateway.closeAll()
  })

  it('reports a cd that takes too long', async () => {
    const ssh = fakeSsh({ respond: () => ({ hang: true }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient, execTimeoutMs: 30 })
    await expect(gateway.changeDirectory(session, 'x')).rejects.toMatchObject({ userMessage: '디렉터리 이동이 시간 제한을 넘었습니다.' })
    expect(gateway.getCwd('s1')).toBe(HOME)
    gateway.closeAll()
  })

  it('reports a cancelled cd', async () => {
    const ssh = fakeSsh({ respond: () => ({ hang: true }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const controller = new AbortController()
    const pending = gateway.changeDirectory(session, 'x', { signal: controller.signal })
    await vi.waitFor(() => expect(ssh.commands).toHaveLength(2))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ userMessage: CANCELLED })
    expect(gateway.getCwd('s1')).toBe(HOME)
    gateway.closeAll()
  })

  it('cuts long output and marks it truncated', async () => {
    const ssh = fakeSsh({ respond: () => ({ stdout: 'x'.repeat(50) }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient, maxOutputBytes: 10 })
    expect(await gateway.run(session, 'cat big')).toMatchObject({ stdout: 'x'.repeat(10), truncated: true })
    gateway.closeAll()
  })

  it('replaces invalid UTF-8 and strips terminal colors', async () => {
    const bytes = Buffer.concat([Buffer.from('\x1b[31m빨강\x1b[0m '), Buffer.from([0xff, 0xfe])])
    const ssh = fakeSsh({ respond: () => ({ stdout: bytes }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    expect((await gateway.run(session, 'cat bin')).stdout).toBe('빨강 ��')
    gateway.closeAll()
  })

  it('stops a command that runs too long', async () => {
    const ssh = fakeSsh({ respond: () => ({ hang: true }) })
    const gateway = createSessionGateway({ createClient: ssh.createClient, execTimeoutMs: 30 })
    const result = await gateway.run(session, 'sleep 100')
    expect(result).toMatchObject({ timedOut: true, exitCode: null })
    expect(ssh.streams.at(-1).stream.signals).toContain('KILL')
    gateway.closeAll()
  })

  it('runs commands of one session one after another', async () => {
    const ssh = fakeSsh({ respond: (command) => (command.endsWith('\nA') ? { hang: true } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const first = gateway.run(session, 'A')
    const second = gateway.run(session, 'B')
    await vi.waitFor(() => expect(ssh.commands).toContain(inHome('A')))
    expect(ssh.commands).not.toContain(inHome('B'))
    ssh.streams.find(entry => entry.command.endsWith('\nA')).stream.emit('close', 0)
    await first
    await second
    expect(ssh.commands.at(-1)).toBe(inHome('B'))
    gateway.closeAll()
  })

  it('reports connection failures in Korean and reconnects next time', async () => {
    const failWith = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), { code: 'ECONNREFUSED' })
    const ssh = fakeSsh({ failWith })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await expect(gateway.run(session, 'ls')).rejects.toMatchObject({ userMessage: '서버가 연결을 거부했습니다.' })
    await expect(gateway.run(session, 'ls')).rejects.toBeTruthy()
    expect(ssh.created).toHaveLength(2)
  })

  it('connects through a jump host', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await gateway.run({ ...session, useJumpHost: true, jumpHost: 'bastion', jumpUsername: 'jump', jumpAuthType: 'password', jumpPassword: 'j' }, 'ls')
    expect(ssh.created).toHaveLength(2)
    expect(ssh.created[0].options.host).toBe('bastion')
    expect(ssh.created[1].options.sock).toEqual({ tunnelTo: 'dev.example:22' })
    gateway.closeAll()
  })

  it('sends keepalives on the target and the jump host connection', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await gateway.run({ ...session, useJumpHost: true, jumpHost: 'bastion', jumpUsername: 'jump', jumpAuthType: 'password', jumpPassword: 'j' }, 'ls')
    for (const client of ssh.created) {
      expect(client.options).toMatchObject({ keepaliveInterval: 15000, keepaliveCountMax: 3 })
    }
    gateway.closeAll()
  })

  it('closes idle connections', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient, idleMs: 20 })
    await gateway.run(session, 'ls')
    await vi.waitFor(() => expect(ssh.created[0].ended).toBe(true))
    // The connection goes, the working directory stays (final fix C2a)
    expect(gateway.getCwd('s1')).toBe(HOME)
  })

  it('reconnects after the server closes the connection', async () => {
    const ssh = fakeSsh()
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    await gateway.run(session, 'ls')
    ssh.created[0].emit('close')
    await gateway.run(session, 'ls')
    expect(ssh.created).toHaveLength(2)
    gateway.closeAll()
  })

  it('does not run a queued command after closeAll', async () => {
    const ssh = fakeSsh({ respond: (command) => (command.includes('sleep') ? { hang: true } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const first = gateway.run(session, 'sleep 100')
    const second = gateway.run(session, 'ls')
    const settled = Promise.allSettled([first, second])
    await vi.waitFor(() => expect(ssh.commands).toHaveLength(2))
    gateway.closeAll()
    const [, secondResult] = await settled
    expect(secondResult.status).toBe('rejected')
    expect(secondResult.reason.userMessage).toBe('세션 연결이 닫혔습니다.')
    expect(ssh.commands.some(command => command.endsWith('ls'))).toBe(false)
  })

  describe('cancellation', () => {
    it('does not start a command for a cancelled request', async () => {
      const ssh = fakeSsh()
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const controller = new AbortController()
      controller.abort()
      await expect(gateway.run(session, 'ls', { signal: controller.signal })).rejects.toMatchObject({ userMessage: CANCELLED })
      expect(ssh.commands).toEqual([])
    })

    it('does not run anything when aborted while connecting', async () => {
      const ssh = fakeSsh({ holdConnect: true })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const controller = new AbortController()
      const pending = gateway.run(session, 'ls', { signal: controller.signal })
      await vi.waitFor(() => expect(ssh.created).toHaveLength(1))
      controller.abort()
      ssh.created[0].emit('ready')
      await expect(pending).rejects.toMatchObject({ userMessage: CANCELLED })
      expect(ssh.commands).toEqual([])
      gateway.closeAll()
    })

    it('does not run the command when aborted during the first pwd', async () => {
      const ssh = fakeSsh({ pwdReply: { hang: true } })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const controller = new AbortController()
      const pending = gateway.run(session, 'ls', { signal: controller.signal })
      await vi.waitFor(() => expect(ssh.commands).toEqual(['pwd']))
      controller.abort()
      await expect(pending).rejects.toMatchObject({ userMessage: CANCELLED })
      expect(ssh.commands).toEqual(['pwd'])
      expect(gateway.getCwd('s1')).toBeNull()
      gateway.closeAll()
    })

    it('stops a command that is already running', async () => {
      const ssh = fakeSsh({ respond: () => ({ hang: true }) })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const controller = new AbortController()
      const pending = gateway.run(session, 'sleep 100', { signal: controller.signal })
      await vi.waitFor(() => expect(ssh.commands).toHaveLength(2))
      controller.abort()
      expect(await pending).toMatchObject({ cancelled: true })
      expect(ssh.streams.at(-1).stream.signals).toContain('KILL')
      gateway.closeAll()
    })

    it('stops a command whose channel opens after the abort', async () => {
      const ssh = fakeSsh({ holdOpen: (command) => command.endsWith('\nsleep 100') })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const controller = new AbortController()
      const pending = gateway.run(session, 'sleep 100', { signal: controller.signal })
      await vi.waitFor(() => expect(ssh.opens).toHaveLength(1))
      controller.abort()
      ssh.opens[0]()
      expect(await pending).toMatchObject({ cancelled: true })
      expect(ssh.streams.at(-1).stream.signals).toContain('KILL')
      gateway.closeAll()
    })
  })

  describe('failures', () => {
    it('never falls back to / when pwd fails', async () => {
      const ssh = fakeSsh({ pwdReply: { code: 1 } })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await expect(gateway.run(session, 'ls')).rejects.toMatchObject({ userMessage: '홈 디렉터리를 확인하지 못했습니다.' })
      expect(ssh.commands).toEqual(['pwd'])
      expect(gateway.getCwd('s1')).toBeNull()
      gateway.closeAll()
    })

    it('rejects a pwd answer that is not an absolute path', async () => {
      const ssh = fakeSsh({ pwdReply: { stdout: 'oops\n' } })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await expect(gateway.run(session, 'ls')).rejects.toMatchObject({ userMessage: '홈 디렉터리를 확인하지 못했습니다.' })
      gateway.closeAll()
    })

    it('rejects when the connection drops during a command', async () => {
      const ssh = fakeSsh({ respond: () => ({ hang: true }) })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const pending = gateway.run(session, 'sleep 100')
      await vi.waitFor(() => expect(ssh.commands).toHaveLength(2))
      ssh.created[0].emit('close')
      await expect(pending).rejects.toMatchObject({ userMessage: DROPPED })
    })

    it('rejects when the channel closes without an exit status', async () => {
      const ssh = fakeSsh({ respond: () => ({ hang: true }) })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const pending = gateway.run(session, 'sleep 100')
      await vi.waitFor(() => expect(ssh.commands).toHaveLength(2))
      ssh.streams.at(-1).stream.emit('close', undefined, undefined)
      await expect(pending).rejects.toMatchObject({ userMessage: DROPPED })
      gateway.closeAll()
    })

    it('turns a synchronous exec throw on a dead client into a connection error', async () => {
      const ssh = fakeSsh({ execThrows: true })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await expect(gateway.run(session, 'ls')).rejects.toMatchObject({ userMessage: DROPPED, detail: 'Not connected' })
      gateway.closeAll()
    })

    it('reports a channel that cannot be opened', async () => {
      const ssh = fakeSsh({ openError: true })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await expect(gateway.run(session, 'ls')).rejects.toMatchObject({ userMessage: '명령을 실행할 채널을 열지 못했습니다.' })
      gateway.closeAll()
    })

    it('reports unreadable connection settings without creating a client', async () => {
      const ssh = fakeSsh()
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const broken = { ...session, authType: 'privateKey', password: undefined }
      await expect(gateway.run(broken, 'ls')).rejects.toMatchObject({ userMessage: 'Private Key 파일이 선택되지 않았습니다.' })
      expect(ssh.created).toHaveLength(0)
    })
  })
})

describe('final fix wave', () => {
  const jumpSession = { ...session, useJumpHost: true, jumpHost: 'bastion', jumpUsername: 'jump', jumpAuthType: 'password', jumpPassword: 'j' }

  describe('C1: saved sessions keep connectTimeout in seconds', () => {
    it.each([
      ['20 seconds', { connectTimeout: 20 }, 20000],
      ['a missing value', {}, 20000],
      ['a numeric string', { connectTimeout: '5' }, 5000],
      ['zero', { connectTimeout: 0 }, 20000]
    ])('gives ssh2 a readyTimeout in milliseconds for %s', async (label, extra, expected) => {
      const ssh = fakeSsh()
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const { connectTimeout, ...rest } = session
      await gateway.run({ ...rest, ...extra }, 'ls')
      expect(ssh.created[0].options.readyTimeout).toBe(expected)
      gateway.closeAll()
    })

    it('applies the same timeout to the jump host and the target', async () => {
      const ssh = fakeSsh()
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await gateway.run({ ...jumpSession, connectTimeout: 20 }, 'ls')
      expect(ssh.created.map(client => client.options.readyTimeout)).toEqual([20000, 20000])
      gateway.closeAll()
    })
  })

  describe('C2: the working directory outlives the connection', () => {
    const toLogs = (command) => (command.includes("cd -- 'logs'") ? { stdout: '/var/log\n' } : {})

    it('keeps the directory across closeAll and reconnects into it without probing home again', async () => {
      const ssh = fakeSsh({ respond: toLogs })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await gateway.changeDirectory(session, 'logs')
      gateway.closeAll()
      expect(gateway.getCwd('s1')).toBe('/var/log')
      const result = await gateway.run(session, 'ls')
      expect(ssh.created).toHaveLength(2)
      expect(ssh.commands.slice(2)).toEqual([script("'/var/log'", 'ls')])
      expect(result.cwd).toBe('/var/log')
      gateway.closeAll()
    })

    it('keeps the directory when an idle connection is closed', async () => {
      const ssh = fakeSsh({ respond: toLogs })
      const gateway = createSessionGateway({ createClient: ssh.createClient, idleMs: 20 })
      await gateway.changeDirectory(session, 'logs')
      await vi.waitFor(() => expect(ssh.created[0].ended).toBe(true))
      expect((await gateway.run(session, 'ls')).cwd).toBe('/var/log')
      expect(ssh.commands.at(-1)).toBe(script("'/var/log'", 'ls'))
      gateway.closeAll()
    })

    it('keeps the directory when the server drops the connection', async () => {
      const ssh = fakeSsh({ respond: toLogs })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await gateway.changeDirectory(session, 'logs')
      ssh.created[0].emit('close')
      expect((await gateway.run(session, 'ls')).cwd).toBe('/var/log')
      gateway.closeAll()
    })

    it('forgetCwds starts every session from its home directory again', async () => {
      const ssh = fakeSsh({ respond: toLogs })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await gateway.changeDirectory(session, 'logs')
      gateway.closeAll()
      gateway.forgetCwds()
      expect(gateway.getCwd('s1')).toBeNull()
      expect((await gateway.run(session, 'ls')).cwd).toBe(HOME)
      expect(ssh.commands.slice(-2)).toEqual(['pwd', inHome('ls')])
      gateway.closeAll()
    })

    it('does not store a home directory probed by a connection that closeAll already dropped', async () => {
      const ssh = fakeSsh({ pwdReply: { hang: true } })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const pending = gateway.resolveCwd(session)
      await vi.waitFor(() => expect(ssh.commands).toEqual(['pwd']))
      gateway.closeAll()
      gateway.forgetCwds()
      ssh.streams[0].stream.emit('data', Buffer.from(`${HOME}\n`))
      ssh.streams[0].stream.emit('close', 0)
      await expect(pending).rejects.toBeTruthy()
      expect(gateway.getCwd('s1')).toBeNull()
    })
  })

  describe('C2: approval is bound to the directory it showed', () => {
    const CHANGED = '작업 디렉터리가 바뀌어 실행하지 않았습니다. 다시 요청하세요.'

    it('resolveCwd connects, probes home once and returns it', async () => {
      const ssh = fakeSsh()
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      expect(await gateway.resolveCwd(session)).toBe(HOME)
      expect(await gateway.resolveCwd(session)).toBe(HOME)
      expect(ssh.commands).toEqual(['pwd'])
      expect(gateway.getCwd('s1')).toBe(HOME)
      gateway.closeAll()
    })

    it('resolveCwd reports a failed home probe', async () => {
      const ssh = fakeSsh({ pwdReply: { code: 1 } })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await expect(gateway.resolveCwd(session)).rejects.toMatchObject({ userMessage: '홈 디렉터리를 확인하지 못했습니다.' })
      gateway.closeAll()
    })

    it('resolveCwd honours a cancelled request', async () => {
      const ssh = fakeSsh()
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const controller = new AbortController()
      controller.abort()
      await expect(gateway.resolveCwd(session, { signal: controller.signal })).rejects.toMatchObject({ userMessage: CANCELLED })
      expect(ssh.commands).toEqual([])
    })

    it('runs when the directory still matches what the user approved', async () => {
      const ssh = fakeSsh()
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const cwd = await gateway.resolveCwd(session)
      expect(await gateway.run(session, 'rm app.log', { expectedCwd: cwd })).toMatchObject({ cwd: HOME, exitCode: 0 })
      expect(ssh.commands.at(-1)).toBe(inHome('rm app.log'))
      gateway.closeAll()
    })

    it('refuses to run in a directory other than the approved one', async () => {
      const ssh = fakeSsh()
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await expect(gateway.run(session, 'rm app.log', { expectedCwd: '/srv/other' })).rejects.toMatchObject({ userMessage: CHANGED })
      expect(ssh.commands).toEqual(['pwd'])
      gateway.closeAll()
    })

    it('refuses a cd whose starting directory changed after the approval', async () => {
      const ssh = fakeSsh()
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await expect(gateway.changeDirectory(session, '.ssh', { expectedCwd: '/srv/other' })).rejects.toMatchObject({ userMessage: CHANGED })
      expect(ssh.commands).toEqual(['pwd'])
      expect(gateway.getCwd('s1')).toBe(HOME)
      gateway.closeAll()
    })
  })

  describe('C2: a working directory that can no longer be entered', () => {
    const MISSING = '작업 디렉터리 /home/app 에 들어갈 수 없습니다. cd 로 다른 위치를 지정하세요.'

    it('turns the cd guard marker into a clear Korean error', async () => {
      const ssh = fakeSsh({ respond: () => ({ stderr: `bash: line 1: cd: /home/app: No such file or directory\n${MARKER}\n`, code: 1 }) })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      const error = await gateway.run(session, 'ls').catch(err => err)
      expect(error.userMessage).toBe(MISSING)
      expect(error.detail).not.toContain(MARKER)
      gateway.closeAll()
    })

    it('gives the same message for a relative cd from a directory that is gone, and keeps the directory', async () => {
      const ssh = fakeSsh({ respond: () => ({ stderr: `cd: /home/app: No such file or directory\n${MARKER}\n`, code: 1 }) })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await expect(gateway.changeDirectory(session, 'logs')).rejects.toMatchObject({ userMessage: MISSING })
      expect(gateway.getCwd('s1')).toBe(HOME)
      gateway.closeAll()
    })

    it('does not mistake a command that merely prints the marker for a failed guard', async () => {
      const ssh = fakeSsh({ respond: () => ({ stderr: `${MARKER}\nmore\n`, code: 0 }) })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      expect(await gateway.run(session, 'x')).toMatchObject({ exitCode: 0 })
      gateway.closeAll()
    })

    it('lets an absolute or home cd leave a directory that is gone', async () => {
      const ssh = fakeSsh({ respond: (command) => (command.endsWith('&& pwd') ? { stdout: '/tmp\n' } : {}) })
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      expect(await gateway.changeDirectory(session, '/tmp')).toEqual({ cwd: '/tmp' })
      expect(ssh.commands.at(-1)).toBe("cd -- '/tmp' && pwd")
      await gateway.changeDirectory(session, '~/x')
      expect(ssh.commands.at(-1)).toBe("cd -- ~/'x' && pwd")
      gateway.closeAll()
    })
  })

  describe('M1: commands never wait for input', () => {
    it('reads stdin from /dev/null inside the script, so the channel can still be killed', async () => {
      const ssh = fakeSsh()
      const gateway = createSessionGateway({ createClient: ssh.createClient })
      await gateway.run(session, 'cat')
      expect(ssh.commands.at(-1)).toBe(inHome('cat'))
      expect(ssh.commands.at(-1).split('\n')[1]).toBe(STDIN_OFF)
      // Ending the channel's stdin would make ssh2 drop the KILL signal on stop and timeout.
      expect(ssh.streams.map(entry => entry.stream.endCalls)).toEqual([0, 0])
      gateway.closeAll()
    })
  })
})
