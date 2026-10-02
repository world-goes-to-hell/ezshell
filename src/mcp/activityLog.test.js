import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import activityModule from './activityLog.js'

const { createActivityLog } = activityModule

function setup(max) {
  const emitted = []
  let clock = 1000
  const log = createActivityLog({ emit: (item) => emitted.push(item), now: () => clock, ...(max ? { max } : {}) })
  return { log, emitted, tick: (ms) => { clock += ms } }
}

const base = (id, state = 'running') => ({ id, time: 't', sessionId: 's1', sessionName: 'dev', command: 'ls', level: 'low', reasons: [], state })

describe('createActivityLog', () => {
  it('records a request and publishes it', () => {
    const { log, emitted } = setup()
    log.begin(base('r1'))
    expect(log.list()).toEqual([{ ...base('r1'), startedAt: 1000, finishedAt: null }])
    expect(emitted).toHaveLength(1)
  })

  it('updates a request and stamps the finish time once', () => {
    const { log, emitted, tick } = setup()
    log.begin(base('r1', 'waiting'))
    log.update('r1', { state: 'running' })
    tick(500)
    log.update('r1', { state: 'done', exitCode: 0, output: 'ok' })
    tick(500)
    log.update('r1', { output: 'ok!' })
    expect(log.list()[0]).toMatchObject({ state: 'done', exitCode: 0, output: 'ok!', startedAt: 1000, finishedAt: 1500 })
    expect(emitted.map(item => item.state)).toEqual(['waiting', 'running', 'done', 'done'])
  })

  it('stamps the finish time for a request that starts finished', () => {
    const { log } = setup()
    log.begin(base('r1', 'blocked'))
    expect(log.list()[0].finishedAt).toBe(1000)
  })

  it('keeps the newest entries up to the limit', () => {
    const { log } = setup(2)
    log.begin(base('r1'))
    log.begin(base('r2'))
    log.begin(base('r3'))
    expect(log.list().map(item => item.id)).toEqual(['r3', 'r2'])
  })

  it('cancels only active requests, once', () => {
    const { log } = setup()
    let stops = 0
    log.begin(base('r1'), { cancel: () => { stops++ } })
    expect(log.cancel('r1')).toBe(true)
    expect(log.cancel('r1')).toBe(false)
    expect(stops).toBe(1)
    log.begin(base('r2'), { cancel: () => { stops++ } })
    log.update('r2', { state: 'done' })
    expect(log.cancel('r2')).toBe(false)
    expect(log.cancel('nope')).toBe(false)
  })

  it('ignores updates for unknown requests', () => {
    const { log, emitted } = setup()
    log.update('nope', { state: 'done' })
    expect(emitted).toHaveLength(0)
  })

  it('clear() forgets every request and its stop button without publishing anything', () => {
    const { log, emitted } = setup()
    let stops = 0
    log.begin(base('r1'), { cancel: () => { stops++ } })
    log.begin(base('r2', 'done'))
    emitted.length = 0
    log.clear()
    expect(log.list()).toEqual([])
    expect(log.cancel('r1')).toBe(false)
    expect(stops).toBe(0)
    log.update('r1', { state: 'done' })
    expect(log.list()).toEqual([])
    expect(emitted).toHaveLength(0)
  })

  it('keeps working when publishing fails', () => {
    const log = createActivityLog({ emit: () => { throw new Error('window gone') } })
    expect(() => log.begin(base('r1'))).not.toThrow()
    expect(log.list()).toHaveLength(1)
  })
})

describe('createActivityLog: live output', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function live() {
    const emitted = []
    const outputs = []
    const log = createActivityLog({ emit: (item) => emitted.push(item), emitOutput: (payload) => outputs.push(payload) })
    return { log, emitted, outputs }
  }
  const out = (text) => ({ stream: 'stdout', text })
  const err = (text) => ({ stream: 'stderr', text })

  it('collects output in arrival order and joins neighbours of the same stream', () => {
    const { log } = live()
    log.begin(base('r1'))
    log.appendOutput('r1', 'stdout', 'a')
    log.appendOutput('r1', 'stdout', 'b')
    log.appendOutput('r1', 'stderr', 'e')
    log.appendOutput('r1', 'stdout', 'c')
    expect(log.list()[0].outputParts).toEqual([out('ab'), err('e'), out('c')])
  })

  it('sends what arrived within 50ms as one message per request', () => {
    const { log, outputs } = live()
    log.begin(base('r1'))
    log.begin(base('r2'))
    log.appendOutput('r1', 'stdout', 'a')
    log.appendOutput('r2', 'stderr', 'x')
    log.appendOutput('r1', 'stdout', 'b')
    expect(outputs).toEqual([])
    vi.advanceTimersByTime(50)
    expect(outputs).toEqual([{ id: 'r1', parts: [out('ab')] }, { id: 'r2', parts: [err('x')] }])
    log.appendOutput('r1', 'stdout', 'c')
    vi.advanceTimersByTime(50)
    expect(outputs).toHaveLength(3)
    expect(outputs[2]).toEqual({ id: 'r1', parts: [out('c')] })
  })

  it('ignores output for an unknown or finished request, and empty output', () => {
    const { log, outputs } = live()
    log.begin(base('r1', 'done'))
    log.begin(base('r2'))
    log.appendOutput('nope', 'stdout', 'a')
    log.appendOutput('r1', 'stdout', 'a')
    log.appendOutput('r2', 'stdout', '')
    vi.advanceTimersByTime(50)
    expect(outputs).toEqual([])
    expect(log.list().some(item => 'outputParts' in item)).toBe(false)
  })

  it('does not send pending output on its own once the request finished: the finished item carries all of it', () => {
    const { log, emitted, outputs } = live()
    log.begin(base('r1'))
    log.appendOutput('r1', 'stdout', 'a')
    log.update('r1', { state: 'done', output: 'formatted' })
    vi.advanceTimersByTime(50)
    expect(outputs).toEqual([])
    expect(emitted.at(-1)).toMatchObject({ state: 'done', output: 'formatted', outputParts: [out('a')] })
  })

  it('sends pending output before handing out a snapshot, so a new subscriber never gets it twice', () => {
    const order = []
    const log = createActivityLog({ emitOutput: (payload) => order.push(payload) })
    log.begin(base('r1'))
    log.appendOutput('r1', 'stdout', 'a')
    const snapshot = log.list()
    order.push('snapshot')
    vi.advanceTimersByTime(50)
    expect(order).toEqual([{ id: 'r1', parts: [out('a')] }, 'snapshot'])
    expect(snapshot[0].outputParts).toEqual([out('a')])
  })

  it('clear() drops pending output', () => {
    const { log, outputs } = live()
    log.begin(base('r1'))
    log.appendOutput('r1', 'stdout', 'secret')
    log.clear()
    vi.advanceTimersByTime(50)
    expect(outputs).toEqual([])
    expect(log.list()).toEqual([])
  })

  it('keeps working when sending output fails', () => {
    const log = createActivityLog({ emitOutput: () => { throw new Error('window gone') } })
    log.begin(base('r1'))
    log.appendOutput('r1', 'stdout', 'a')
    expect(() => vi.advanceTimersByTime(50)).not.toThrow()
    expect(log.list()[0].outputParts).toEqual([out('a')])
  })
})
