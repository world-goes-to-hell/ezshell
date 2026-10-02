import { describe, it, expect, vi } from 'vitest'
import gatewayModule from './sessionGateway.js'
import fakeModule from './fakeSsh.testhelper.js'

const { createSessionGateway } = gatewayModule
const { fakeSsh, HOME } = fakeModule

const session = { id: 's1', name: 'dev', host: 'dev.example', port: 22, username: 'app', authType: 'password', password: 'pw' }
const PID_LINE = 'echo "__EZSHELL_JOB_PID__$$" >&2'
const isJob = (command) => command.startsWith(PID_LINE)
const isKill = (command) => command.startsWith('kill ')
const LIMIT = 60000
const KILL_4242 = 'kill -KILL -- -4242 2>/dev/null || kill -KILL 4242'

/** A gateway whose job commands stay open until the test closes them */
function setup({ respond, ...options } = {}) {
  const ssh = fakeSsh({ respond: (command) => (isJob(command) ? { hang: true } : (respond ? respond(command) : {})) })
  const gateway = createSessionGateway({ createClient: ssh.createClient, jobPidWaitMs: 20, ...options })
  const jobStream = (index = 0) => ssh.streams.filter(entry => isJob(entry.command))[index].stream
  const kills = () => ssh.commands.filter(isKill)
  return { ssh, gateway, jobStream, kills }
}

const sayPid = (stream, pid = 4242) => stream.stderr.emit('data', Buffer.from(`__EZSHELL_JOB_PID__${pid}\n`))

describe('startJob', () => {
  it('runs the command in the working directory and reports where', async () => {
    const { ssh, gateway, jobStream } = setup()
    const job = await gateway.startJob(session, 'make all', { limitMs: LIMIT })
    expect(job.cwd).toBe(HOME)
    const lines = ssh.commands.at(-1).split('\n')
    expect(lines[0]).toBe(PID_LINE)
    expect(lines[1]).toContain("cd -- '/home/app' ||")
    expect(lines.slice(2)).toEqual(['exec </dev/null', 'make all'])
    jobStream().emit('close', 3)
    expect(await job.done).toEqual({ exitCode: 3, signal: null, timedOut: false, cancelled: false, dropped: false, overflow: false, unconfirmed: false })
    gateway.closeAll()
  })

  it('passes the output on as it arrives, without the pid line and without colors', async () => {
    const { gateway, jobStream } = setup()
    const output = []
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT, onOutput: (stream, text) => output.push([stream, text]) })
    const stream = jobStream()
    stream.emit('data', Buffer.from('\x1b[32mbuilding\x1b[0m\n'))
    stream.stderr.emit('data', Buffer.from('__EZSHELL_JOB_'))
    stream.stderr.emit('data', Buffer.from('PID__4242\nwarning: x\n'))
    stream.stderr.emit('data', Buffer.from('__EZSHELL_JOB_PID__7\n'))
    stream.emit('close', 0)
    await job.done
    expect(output).toEqual([['stdout', 'building\n'], ['stderr', 'warning: x\n__EZSHELL_JOB_PID__7\n']])
    gateway.closeAll()
  })

  it('finds the pid line after what the login scripts print', async () => {
    const { gateway, jobStream, kills } = setup()
    const output = []
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT, onOutput: (stream, text) => output.push(text) })
    jobStream().stderr.emit('data', Buffer.from('stty: not a tty\n__EZSHELL_JOB_PID__4242\n'))
    job.stop()
    await job.done
    expect(output.join('')).toBe('stty: not a tty\n')
    expect(kills()).toEqual([KILL_4242])
    gateway.closeAll()
  })

  it('does not hold the queue: other commands of the session run while the job does', async () => {
    const { ssh, gateway, jobStream } = setup({ respond: () => ({ stdout: 'ok\n' }) })
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    expect((await gateway.run(session, 'ls')).stdout).toBe('ok\n')
    expect(ssh.created).toHaveLength(1)
    jobStream().emit('close', 0)
    await job.done
    gateway.closeAll()
  })

  it('stopping sends KILL to the channel and kills the process group', async () => {
    const { gateway, jobStream, kills } = setup()
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    sayPid(jobStream())
    job.stop()
    job.stop()
    expect(await job.done).toMatchObject({ cancelled: true, timedOut: false, signal: 'KILL', exitCode: null })
    expect(jobStream().signals).toEqual(['KILL'])
    expect(kills()).toEqual([KILL_4242])
    gateway.closeAll()
  })

  it('kills the process group once the pid arrives when the stop came first', async () => {
    const ssh = fakeSsh({ respond: (command) => (isJob(command) ? { hang: true } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    const { stream } = ssh.streams.find(entry => isJob(entry.command))
    // A server that ignores the close request: the channel stays open
    stream.close = () => {}
    job.stop()
    expect(ssh.commands.filter(isKill)).toEqual([])
    sayPid(stream)
    expect(ssh.commands.filter(isKill)).toEqual([KILL_4242])
    stream.emit('close', null, 'KILL')
    await job.done
    gateway.closeAll()
  })

  it.each([['1'], ['0'], ['-5'], ['12a'], ['99999999999']])('never sends a kill for the pid "%s"', async (pid) => {
    const { gateway, jobStream, kills } = setup()
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    sayPid(jobStream(), pid)
    job.stop()
    await job.done
    expect(kills()).toEqual([])
    gateway.closeAll()
  })

  it('keeps the channel open for the pid line when the stop comes first, then kills and closes', async () => {
    const ssh = fakeSsh({ respond: (command) => (isJob(command) ? { hang: true } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient, jobPidWaitMs: 5000 })
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    const { stream } = ssh.streams.find(entry => isJob(entry.command))
    let closes = 0
    const close = stream.close
    stream.close = () => { closes += 1; close() }
    job.stop()
    expect(stream.signals).toEqual(['KILL'])
    expect(closes).toBe(0)
    sayPid(stream)
    expect(closes).toBe(1)
    expect(ssh.commands.filter(isKill)).toEqual([KILL_4242])
    expect(await job.done).toMatchObject({ cancelled: true, unconfirmed: false })
    gateway.closeAll()
  })

  it('closes the channel after a short wait when no pid line comes', async () => {
    const { gateway, jobStream, kills } = setup()
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    job.stop()
    expect(await job.done).toMatchObject({ cancelled: true, signal: 'KILL', unconfirmed: false })
    expect(kills()).toEqual([])
    expect(jobStream().signals).toEqual(['KILL'])
    gateway.closeAll()
  })

  it('says so when a stopped job could neither be killed by pid nor reported as ended', async () => {
    const ssh = fakeSsh({ respond: (command) => (isJob(command) ? { hang: true } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient, jobPidWaitMs: 20 })
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    // A server that ignores both the KILL request and the close
    ssh.streams.find(entry => isJob(entry.command)).stream.close = () => {}
    job.stop()
    expect(await job.done).toMatchObject({ cancelled: true, exitCode: null, signal: null, unconfirmed: true })
    gateway.closeAll()
  })

  it('hands on output that comes a byte at a time in a few pieces', async () => {
    const { gateway, jobStream } = setup()
    const output = []
    const job = await gateway.startJob(session, 'noisy', { limitMs: LIMIT, onOutput: (stream, text) => output.push([stream, text]) })
    const stream = jobStream()
    // After the pid line, stderr is passed on as it comes (before it, a line without its end is held back)
    sayPid(stream)
    for (let i = 0; i < 500; i++) {
      stream.emit('data', Buffer.from('a'))
      stream.emit('data', Buffer.from('b'))
    }
    for (let i = 0; i < 100; i++) {
      stream.emit('data', Buffer.from('o'))
      stream.stderr.emit('data', Buffer.from('e'))
    }
    expect(output).toEqual([])
    stream.emit('close', 0)
    await job.done
    expect(output.length).toBeLessThanOrEqual(64)
    expect(output[0]).toEqual(['stdout', 'ab'.repeat(500) + 'o'])
    expect(output.map(part => part[1]).join('')).toBe('ab'.repeat(500) + 'oe'.repeat(100))
    gateway.closeAll()
  })

  it('reports the end only after the kill command has run, so closing the connection cannot lose it', async () => {
    const ssh = fakeSsh({ respond: (command) => (isJob(command) || isKill(command) ? { hang: true } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    const { stream } = ssh.streams.find(entry => isJob(entry.command))
    sayPid(stream)
    let ended = false
    job.done.then(() => { ended = true })
    job.stop()
    // The job's channel reports closed (the fake does so at once), the kill command has not finished
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(ended).toBe(false)
    ssh.streams.find(entry => isKill(entry.command)).stream.emit('close', 0)
    expect(await job.done).toMatchObject({ cancelled: true, signal: 'KILL' })
    gateway.closeAll()
  })

  it('does not wait for the kill command when the connection is gone', async () => {
    const ssh = fakeSsh({ respond: (command) => (isJob(command) || isKill(command) ? { hang: true } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    sayPid(ssh.streams.find(entry => isJob(entry.command)).stream)
    job.stop()
    ssh.created[0].emit('close')
    expect(await job.done).toMatchObject({ cancelled: true, dropped: true })
  })

  it('stops a job that runs past its time limit', async () => {
    const { gateway, jobStream, kills } = setup()
    const job = await gateway.startJob(session, 'sleep 999', { limitMs: 30 })
    sayPid(jobStream())
    expect(await job.done).toMatchObject({ timedOut: true, cancelled: false })
    expect(jobStream().signals).toEqual(['KILL'])
    expect(kills()).toEqual([KILL_4242])
    gateway.closeAll()
  })

  it('sends no kill for a job that already ended', async () => {
    const { gateway, jobStream, kills } = setup()
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    sayPid(jobStream())
    jobStream().emit('close', 0)
    await job.done
    job.stop()
    expect(kills()).toEqual([])
    expect(jobStream().signals).toEqual([])
    gateway.closeAll()
  })

  it('stops a job that prints more than the output limit', async () => {
    const { gateway, jobStream } = setup({ maxJobOutputBytes: 10 })
    const output = []
    const job = await gateway.startJob(session, 'yes', { limitMs: LIMIT, onOutput: (stream, text) => output.push(text) })
    jobStream().emit('data', Buffer.from('12345678'))
    jobStream().emit('data', Buffer.from('abcdefgh'))
    jobStream().emit('data', Buffer.from('more'))
    expect(await job.done).toMatchObject({ overflow: true, cancelled: false, timedOut: false })
    expect(output.join('')).toBe('12345678')
    expect(jobStream().signals).toEqual(['KILL'])
    gateway.closeAll()
  })

  it('reports a dropped connection', async () => {
    const { ssh, gateway } = setup()
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    ssh.created[0].emit('close')
    expect(await job.done).toMatchObject({ dropped: true, exitCode: null })
  })

  it('refuses to start when the working directory is not the approved one', async () => {
    const { ssh, gateway } = setup()
    await expect(gateway.startJob(session, 'make', { limitMs: LIMIT, expectedCwd: '/etc' })).rejects.toMatchObject({ userMessage: expect.stringContaining('작업 디렉터리가 바뀌어') })
    expect(ssh.commands.filter(isJob)).toEqual([])
    gateway.closeAll()
  })

  it('reports a channel that cannot be opened', async () => {
    const ssh = fakeSsh({ holdOpen: isJob })
    const gateway = createSessionGateway({ createClient: ssh.createClient, execTimeoutMs: 30 })
    await expect(gateway.startJob(session, 'make', { limitMs: LIMIT })).rejects.toMatchObject({ userMessage: expect.stringContaining('채널을 열지 못했습니다') })
    // The session is usable again
    expect((await gateway.run(session, 'ls')).exitCode).toBe(0)
    gateway.closeAll()
  })

  it('stops a channel that opens after the request was cancelled', async () => {
    const ssh = fakeSsh({ holdOpen: isJob, respond: (command) => (isJob(command) ? { hang: true } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient })
    const controller = new AbortController()
    const pending = gateway.startJob(session, 'make', { limitMs: LIMIT, signal: controller.signal })
    await vi.waitFor(() => expect(ssh.opens).toHaveLength(1))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ userMessage: '요청이 취소되었습니다.' })
    ssh.opens[0]()
    const { stream } = ssh.streams.find(entry => isJob(entry.command))
    expect(stream.signals).toEqual(['KILL'])
    gateway.closeAll()
  })

  it('keeps the connection open past the idle time while a job runs', async () => {
    const { ssh, gateway, jobStream } = setup({ idleMs: 30 })
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(ssh.created[0].ended).toBe(false)
    jobStream().emit('close', 0)
    await job.done
    await vi.waitFor(() => expect(ssh.created[0].ended).toBe(true))
  })
})

describe('retireAll', () => {
  it('closes a connection without jobs at once', async () => {
    const { ssh, gateway } = setup()
    await gateway.run(session, 'ls')
    gateway.retireAll()
    await vi.waitFor(() => expect(ssh.created[0].ended).toBe(true))
  })

  it('keeps a connection with a running job until the job ends, and gives new requests a new connection', async () => {
    const { ssh, gateway, jobStream } = setup()
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    gateway.retireAll()
    await gateway.run(session, 'ls')
    expect(ssh.created).toHaveLength(2)
    expect(ssh.created[0].ended).toBe(false)
    jobStream().emit('close', 0)
    await job.done
    await vi.waitFor(() => expect(ssh.created[0].ended).toBe(true))
    expect(ssh.created[1].ended).toBe(false)
    gateway.closeAll()
  })

  it('closes a connection whose job does not end within the grace time', async () => {
    const { ssh, gateway } = setup()
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    gateway.retireAll({ graceMs: 30 })
    expect(ssh.created[0].ended).toBe(false)
    expect(await job.done).toMatchObject({ dropped: true })
    expect(ssh.created[0].ended).toBe(true)
  })

  it('keeps a connection retired while a job channel is opening, so the job can still be stopped', async () => {
    const ssh = fakeSsh({ holdOpen: isJob, respond: (command) => (isJob(command) ? { hang: true } : {}) })
    const gateway = createSessionGateway({ createClient: ssh.createClient, jobPidWaitMs: 20 })
    const pending = gateway.startJob(session, 'make', { limitMs: LIMIT })
    await vi.waitFor(() => expect(ssh.opens).toHaveLength(1))
    gateway.retireAll({ graceMs: 5000 })
    expect(ssh.created[0].ended).toBe(false)
    expect(gateway.hasLingering()).toBe(true)
    ssh.opens[0]()
    const job = await pending
    const { stream } = ssh.streams.find(entry => isJob(entry.command))
    sayPid(stream)
    job.stop()
    await job.done
    expect(ssh.commands.filter(isKill)).toEqual([KILL_4242])
    await vi.waitFor(() => expect(ssh.created[0].ended).toBe(true))
    expect(gateway.hasLingering()).toBe(false)
  })

  it('tells when the retired connections are gone', async () => {
    const { gateway, jobStream } = setup()
    await gateway.whenSettled()
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    gateway.retireAll()
    let settled = false
    const waiting = gateway.whenSettled().then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    jobStream().emit('close', 0)
    await job.done
    await waiting
    expect(settled).toBe(true)
  })

  it('closeAll still closes a connection with a running job at once', async () => {
    const { ssh, gateway } = setup()
    const job = await gateway.startJob(session, 'make', { limitMs: LIMIT })
    gateway.closeAll()
    await vi.waitFor(() => expect(ssh.created[0].ended).toBe(true))
    expect(await job.done).toMatchObject({ dropped: true })
  })
})
