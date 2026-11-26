import { describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { legacyStartOrder, reconcileStartOrder, restoreStartOrder, runStartStages, selectStartStages, stopStages, validateStartOrder } from './runStartOrder.js'

const stage = (ids, kind = 'none', value) => ({ ids, gate: { kind, ...(value !== undefined && { value }) } })
const presets = [
  { id: 'config', inAll: true },
  { id: 'disabled', inAll: false, waitReady: true },
  { id: 'gateway', inAll: true, waitReady: true },
  { id: 'web', inAll: true }
]
const defaults = legacyStartOrder(presets)

describe('project start order', () => {
  it('migrates in order and uses the following included preset’s wait flag', () => {
    expect(defaults).toEqual({
      stages: [stage(['config'], 'ready'), stage(['gateway']), stage(['web'])],
      timeoutSeconds: 300, reverseStop: true, askDependencies: true, onTimeout: 'pause'
    })
  })

  it('keeps custom stages while removing missing IDs and putting newly included presets at the end', () => {
    const order = { ...defaults, stages: [stage(['web', 'config'], 'log', 'Listening'), stage(['gateway'])] }
    const edited = [presets[0], presets[2], { id: 'admin', inAll: true }, presets[1]]
    expect(reconcileStartOrder(order, edited).stages).toEqual([stage(['config'], 'log', 'Listening'), stage(['gateway']), stage(['admin'])])
    expect(selectStartStages(order, ['config', 'gateway'])).toEqual([stage(['config'], 'log', 'Listening'), stage(['gateway'])])
    expect(stopStages(order, presets)).toEqual([['disabled'], ['gateway'], ['web', 'config']])
    expect(stopStages({ ...order, reverseStop: false }, presets)).toEqual([presets.map(preset => preset.id)])
  })

  it('rejects unknown and duplicate IDs, empty or excessive stages, invalid timeouts, and multiline or long logs', () => {
    for (const stages of [
      [stage(['other'])], [stage(['config']), stage(['config'])], [stage([])],
      Array.from({ length: 51 }, () => stage(['config'])),
      [stage(['config'], 'log', 'first\nsecond')], [stage(['config'], 'log', 'x'.repeat(201))],
      [stage(['config'], 'log', 'hidden\u200bword')]
    ]) expect(() => validateStartOrder({ ...defaults, stages }, presets)).toThrow()
    for (const timeoutSeconds of [0, 1.1, 3601, '300']) {
      expect(() => validateStartOrder({ ...defaults, timeoutSeconds }, presets)).toThrow()
    }
  })

  it('restores the usable stages and options around unknown stored IDs', () => {
    const order = { ...defaults, timeoutSeconds: 27, stages: [
      stage(['web', 'missing'], 'log', 'Listening'), stage(['missing']), stage(['gateway', 'config'])
    ] }
    expect(restoreStartOrder(order, presets)).toEqual({ ...order, stages: [
      stage(['web'], 'log', 'Listening'), stage(['gateway', 'config'])
    ] })
  })

  it('appends selected presets outside the saved order according to the preset list', () => {
    expect(selectStartStages(defaults, ['manual', 'disabled', 'config'], ['config', 'disabled', 'manual', 'gateway'])).toEqual([
      stage(['config'], 'ready'), stage(['disabled']), stage(['manual'])
    ])
  })

  it('only accepts plain HTTP to the three loopback hosts', () => {
    const from = value => validateStartOrder({ ...defaults, stages: [stage(['config'], 'url', value)] }, presets)
    for (const value of ['http://127.0.0.1:8080/health', 'http://localhost/path', 'http://[::1]:9000/ready']) {
      expect(from(value).stages[0].gate.value).toBe(value)
    }
    for (const value of ['https://localhost/', 'http://127.1/', 'http://localhost.evil/', 'http://localhost@192.0.2.2/',
      'http://user@localhost/', 'http://user:pass@127.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://localhost:0/',
      'http://localhost/#fragment', 'http://localhost\\192.0.2.2']) expect(() => from(value)).toThrow()
  })
})

function startFixture(stages, options = {}) {
  const controller = new AbortController()
  const batch = { ...defaults, stages, index: 0, ignored: new Set(), skippedGates: new Set(), startedIds: new Set(), ...options }
  const running = new Set()
  const failed = new Set()
  const ready = new Set()
  const publish = vi.fn()
  const start = vi.fn(async id => { running.add(id) })
  const run = dependencies => runStartStages(batch, {
    start, active: id => running.has(id), failed: id => failed.has(id), meets: id => ready.has(id), publish, signal: controller.signal, pollMs: 5, ...dependencies
  })
  return { batch, controller, failed, running, ready, publish, start, run }
}

describe('staged start', () => {
  it('starts same-stage services concurrently and waits for all of them before starting the next stage', async () => {
    const f = startFixture([stage(['config', 'web'], 'log', 'Ready'), stage(['gateway'])])
    const opening = Promise.withResolvers()
    const secondEntered = Promise.withResolvers()
    f.start.mockImplementation(async id => {
      if (id === 'config') await opening.promise
      if (id === 'web') secondEntered.resolve()
      f.running.add(id)
    })
    const result = f.run()
    await secondEntered.promise
    expect(f.start.mock.calls).toEqual([['config'], ['web']])
    opening.resolve()
    f.ready.add('web')
    await vi.waitFor(() => expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'waiting', ids: ['config'] })))
    expect(f.start).not.toHaveBeenCalledWith('gateway')
    f.ready.add('config')
    expect(await result).toBeNull()
    expect(f.start).toHaveBeenLastCalledWith('gateway')
  })

  it('pauses on timeout, returns the remaining IDs, and can continue by configuration', async () => {
    let now = 0
    const clock = () => now += 1001
    const stages = [stage(['config', 'web'], 'ready'), stage(['gateway'])]
    const paused = startFixture(stages, { timeoutSeconds: 1 })
    paused.ready.add('web')
    expect(await paused.run({ now: clock })).toEqual({ reason: 'timeout', index: 0, ids: ['config'] })
    expect(paused.start).not.toHaveBeenCalledWith('gateway')
    const continued = startFixture(stages, { timeoutSeconds: 1, onTimeout: 'continue' })
    expect(await continued.run({ now: clock })).toBeNull()
    expect(continued.start).toHaveBeenLastCalledWith('gateway')
  })

  it('reports an earlier exit during the next stage and stops before the following stage', async () => {
    const f = startFixture([stage(['config']), stage(['web'], 'ready'), stage(['gateway'])])
    const result = f.run()
    await vi.waitFor(() => expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'waiting', index: 1 })))
    f.running.delete('config')
    f.failed.add('config')
    expect(await result).toEqual({ reason: 'exited', index: 0, ids: ['config'] })
    expect(f.start).not.toHaveBeenCalledWith('gateway')
  })

  it('advances when a gated stage completes without a crash or is manually stopped', async () => {
    const f = startFixture([stage(['config', 'web'], 'ready'), stage(['gateway'])])
    const result = f.run()
    await vi.waitFor(() => expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'waiting' })))
    f.running.clear()
    expect(await result).toBeNull()
    expect(f.start).toHaveBeenLastCalledWith('gateway')
  })

  it('requires a 2xx response and does not follow a loopback redirect', async () => {
    const visited = []
    let status = 302
    const server = createServer((request, response) => {
      visited.push(request.url)
      response.writeHead(status, { Location: '/other' })
      response.end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const stages = [stage(['config'], 'url', `http://127.0.0.1:${server.address().port}/health`), stage(['gateway'])]
      let time = 0
      const redirect = startFixture(stages, { timeoutSeconds: 1 })
      expect(await redirect.run({ now: () => time += 1001 })).toMatchObject({ reason: 'timeout' })
      expect(visited).toEqual(['/health'])
      status = 204
      const success = startFixture(stages)
      expect(await success.run()).toBeNull()
      expect(success.start).toHaveBeenLastCalledWith('gateway')
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})
