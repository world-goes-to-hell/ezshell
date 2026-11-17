import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createContainerLogs, logCommand, readLog, isStamp, FIRST_LINES, LOOK_LINES } from './logs.js'

const T1 = '2026-11-17T03:21:45.100000000Z'
const T2 = '2026-11-17T03:21:45.200000000Z'
const T3 = '2026-11-17T03:21:46.000000001Z'

describe('logCommand', () => {
  it('asks for the last lines first, then from the last stamp seen', () => {
    expect(logCommand({ name: 'web', tail: FIRST_LINES })).toBe(`sh -c "timeout 5 docker logs --timestamps --tail ${FIRST_LINES} web 2>&1"`)
    expect(logCommand({ name: 'web', since: T1, tail: LOOK_LINES })).toBe(`sh -c "timeout 5 docker logs --timestamps --tail ${LOOK_LINES} --since ${T1} web 2>&1"`)
  })

  it('refuses a name or stamp that would add to the command line', () => {
    expect(() => logCommand({ name: 'web; reboot', tail: 10 })).toThrow()
    expect(() => logCommand({ name: 'web', since: '2026-11-17 || reboot', tail: 10 })).toThrow()
    expect(() => logCommand({ name: 'web', since: '$(id)', tail: 10 })).toThrow()
    expect(isStamp(T1)).toBe(true)
    expect(isStamp('2026-11-17T03:21:45+09:00')).toBe(true)
    expect(isStamp('yesterday')).toBe(false)
  })

  it('keeps the line count inside its limit', () => {
    expect(logCommand({ name: 'web', tail: 999999 })).toContain(`--tail ${LOOK_LINES} `)
    expect(logCommand({ name: 'web', tail: 'x' })).toContain(`--tail ${FIRST_LINES} `)
  })
})

describe('readLog', () => {
  it('takes the stamps off and remembers the newest', () => {
    expect(readLog(`${T1} first\n${T2} second\n`)).toEqual({ text: 'first\nsecond\n', last: T2, lines: 2 })
  })

  it('drops what was shown already (docker includes the instant it is asked from)', () => {
    const result = readLog(`${T1} first\n${T2} second\n${T3} third\n`, { after: T2 })
    expect(result).toEqual({ text: 'third\n', last: T3, lines: 1 })
  })

  it('answers with nothing new, keeping the place', () => {
    expect(readLog(`${T2} second\n`, { after: T2 })).toEqual({ text: '', last: T2, lines: 0 })
    expect(readLog('', { after: T2 })).toEqual({ text: '', last: T2, lines: 0 })
  })

  it('compares stamps with different fraction lengths by time', () => {
    const short = '2026-11-17T03:21:45.2Z'
    expect(readLog(`${short} same instant\n`, { after: T2 }).lines).toBe(0)
    expect(readLog(`2026-11-17T03:21:45.21Z later\n`, { after: T2 }).lines).toBe(1)
  })

  it('keeps an unstamped line with the stamped line before it', () => {
    expect(readLog(`${T1} Traceback\n  at frame one\n${T2} next\n`).text).toBe('Traceback\n  at frame one\nnext\n')
    expect(readLog(`${T1} old\n  its tail\n${T3} new\n`, { after: T2 }).text).toBe('new\n')
  })

  it('leaves out the half line of output that was cut at the size limit', () => {
    const result = readLog(`${T1} whole\n${T2} cut in the mid`, { isCut: true })
    expect(result).toEqual({ text: 'whole\n', last: T1, lines: 1 })
  })

  it('keeps empty log lines and Windows line ends', () => {
    expect(readLog(`${T1} \n${T2} done\r\n`).text).toBe('\ndone\n')
  })
})

describe('createContainerLogs', () => {
  const connWith = (stdout, exitCode = 0) => ({
    exec: vi.fn((command, callback) => {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = vi.fn()
      setImmediate(() => {
        callback(null, stream)
        stream.emit('data', Buffer.from(stdout))
        stream.emit('exit', exitCode)
        stream.emit('close')
      })
    })
  })

  it('reads the last lines, then only what is new', async () => {
    const conn = connWith(`${T1} first\n${T2} second\n`)
    const logs = createContainerLogs({ connectionOf: () => conn })
    expect(await logs.read('tab', 'web')).toEqual({ ok: true, text: 'first\nsecond\n', last: T2, lines: 2 })
    expect(conn.exec.mock.calls[0][0]).toContain(`--tail ${FIRST_LINES} web`)
    expect(await logs.read('tab', 'web', { since: T2 })).toEqual({ ok: true, text: '', last: T2, lines: 0 })
    expect(conn.exec.mock.calls[1][0]).toContain(`--since ${T2} web`)
  })

  it('says why a look failed, without the server\'s own text', async () => {
    const gone = createContainerLogs({ connectionOf: () => connWith('Error response from daemon: No such container: web\n', 1) })
    expect(await gone.read('tab', 'web')).toEqual({ ok: false, error: '컨테이너가 없어졌습니다.' })
    const slow = createContainerLogs({ connectionOf: () => connWith('', 124) })
    expect(await slow.read('tab', 'web')).toEqual({ ok: false, error: '도커가 5초 안에 응답하지 않았습니다.' })
    const other = createContainerLogs({ connectionOf: () => connWith('something about /var/lib/docker\n', 1) })
    expect(await other.read('tab', 'web')).toEqual({ ok: false, error: '컨테이너 로그를 읽지 못했습니다.' })
  })

  it('refuses without a connection or with a bad name, running nothing', async () => {
    const conn = connWith('')
    expect(await createContainerLogs({ connectionOf: () => null }).read('tab', 'web')).toEqual({ ok: false, error: '탭의 연결이 끊겼습니다.' })
    expect(await createContainerLogs({ connectionOf: () => conn }).read('tab', 'web;id')).toEqual({ ok: false, error: '컨테이너 로그를 읽지 못했습니다.' })
    expect(conn.exec).not.toHaveBeenCalled()
  })
})
