import { describe, it, expect, vi } from 'vitest'
import jobStoreModule from './jobStore.js'

const { createJobStore } = jobStoreModule

function setup(options = {}) {
  let clock = 1000
  let counter = 0
  const store = createJobStore({ now: () => clock, newId: () => `job-${++counter}`, ...options })
  return { store, tick: (ms) => { clock += ms } }
}

const fields = (sessionId = 's1') => ({ sessionId, sessionName: 'dev', command: 'make', limitMs: 60000 })

/** Create a job that is already running (its stop function attached) */
function start(store, sessionId, stop = () => {}) {
  const { id } = store.create(fields(sessionId))
  store.attach(id, { cwd: '/home/app', stop })
  return id
}

describe('createJobStore', () => {
  it('creates a running job and lists it', () => {
    const { store } = setup()
    const id = start(store, 's1')
    expect(store.list()).toEqual([
      { id, sessionId: 's1', sessionName: 'dev', command: 'make', cwd: '/home/app', limitMs: 60000, state: 'running', exitCode: null, signal: null, startedAt: 1000, finishedAt: null, unread: 0, unconfirmed: false }
    ])
  })

  it('reads output once, continuing where the last read stopped', async () => {
    const { store } = setup()
    const id = start(store)
    store.append(id, 'one\n')
    expect(await store.read(id)).toMatchObject({ text: 'one\n', skipped: 0, more: false })
    store.append(id, 'two\n')
    store.append(id, 'three\n')
    expect(await store.read(id)).toMatchObject({ text: 'two\nthree\n', skipped: 0 })
    expect((await store.read(id)).text).toBe('')
  })

  it('hands out long output in pieces', async () => {
    const { store } = setup({ readChars: 4 })
    const id = start(store)
    store.append(id, 'abcdefghij')
    expect(await store.read(id)).toMatchObject({ text: 'abcd', more: true })
    expect(await store.read(id)).toMatchObject({ text: 'efgh', more: true })
    expect(await store.read(id)).toMatchObject({ text: 'ij', more: false })
  })

  it('lets the kept output grow to twice the limit before cutting it back', async () => {
    const { store } = setup({ keepChars: 5 })
    const id = start(store)
    store.append(id, 'abcdefgh')
    expect((await store.read(id)).text).toBe('abcdefgh')
    store.append(id, 'ijk')
    expect(await store.read(id)).toMatchObject({ text: 'ijk', skipped: 0 })
  })

  it('remembers that the end of a stopped job could not be confirmed', () => {
    const { store } = setup()
    const id = start(store)
    store.finish(id, { state: 'stopped', unconfirmed: true })
    expect(store.get(id)).toMatchObject({ state: 'stopped', unconfirmed: true })
  })

  it('keeps only the end of the output and tells how much was lost', async () => {
    const { store } = setup({ keepChars: 5 })
    const id = start(store)
    store.append(id, 'abc')
    expect((await store.read(id)).text).toBe('abc')
    store.append(id, 'defghijkl')
    expect(await store.read(id)).toMatchObject({ text: 'hijkl', skipped: 4 })
    expect(store.list()[0].unread).toBe(0)
  })

  it('waits for the job to end and then hands out what it printed meanwhile', async () => {
    const { store } = setup()
    const id = start(store)
    let answered = false
    const pending = store.read(id, { waitMs: 5000 }).then((read) => { answered = true; return read })
    store.append(id, 'one\n')
    store.append(id, 'two\n')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(answered).toBe(false)
    store.finish(id, { state: 'done', exitCode: 0 })
    expect(await pending).toMatchObject({ text: 'one\ntwo\n', job: { state: 'done' } })
  })

  it('answers after the wait time with what a running job printed so far', async () => {
    const { store } = setup()
    const id = start(store)
    const startedAt = Date.now()
    const pending = store.read(id, { waitMs: 60 })
    store.append(id, 'so far\n')
    expect(await pending).toMatchObject({ text: 'so far\n', job: { state: 'running' } })
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50)
  })

  it('stops waiting once a full read is ready', async () => {
    const { store } = setup({ readChars: 4 })
    const id = start(store)
    const pending = store.read(id, { waitMs: 5000 })
    store.append(id, 'abcdef')
    expect(await pending).toMatchObject({ text: 'abcd', more: true })
  })

  it('stops waiting when the job ends', async () => {
    const { store } = setup()
    const id = start(store)
    const pending = store.read(id, { waitMs: 5000 })
    store.finish(id, { state: 'done', exitCode: 0 })
    expect(await pending).toMatchObject({ text: '', job: { state: 'done', exitCode: 0 } })
  })

  it('stops waiting after the wait time', async () => {
    const { store } = setup()
    const id = start(store)
    expect(await store.read(id, { waitMs: 20 })).toMatchObject({ text: '', job: { state: 'running' } })
  })

  it('stops waiting when the request is cancelled', async () => {
    const { store } = setup()
    const id = start(store)
    const controller = new AbortController()
    const pending = store.read(id, { waitMs: 5000, signal: controller.signal })
    controller.abort()
    expect(await pending).toMatchObject({ text: '' })
  })

  it('does not wait for a finished job, or when asked not to wait', async () => {
    const { store } = setup()
    const id = start(store)
    store.append(id, 'x')
    expect((await store.read(id)).text).toBe('x')
    store.finish(id, { state: 'done', exitCode: 0 })
    expect((await store.read(id, { waitMs: 5000 })).text).toBe('')
  })

  it('answers null for a job it does not know', async () => {
    const { store } = setup()
    expect(await store.read('job-x')).toBeNull()
    expect(store.get('job-x')).toBeNull()
    expect(store.stop('job-x')).toBe(false)
  })

  it('stamps the end time and ignores output and a second finish afterwards', async () => {
    const { store, tick } = setup()
    const id = start(store)
    tick(500)
    store.finish(id, { state: 'timeout', exitCode: null, signal: 'KILL' })
    tick(500)
    store.finish(id, { state: 'done', exitCode: 0 })
    store.append(id, 'late')
    expect(store.get(id)).toMatchObject({ state: 'timeout', signal: 'KILL', finishedAt: 1500, unread: 0 })
  })

  it('limits running jobs per session', () => {
    const { store } = setup({ perSession: 2, total: 5 })
    start(store, 's1')
    const second = start(store, 's1')
    expect(store.canStart('s1')).toBe('session')
    expect(store.create(fields('s1'))).toEqual({ error: 'session' })
    expect(store.canStart('s2')).toBeNull()
    store.finish(second, { state: 'done', exitCode: 0 })
    expect(store.canStart('s1')).toBeNull()
  })

  it('limits running jobs in total', () => {
    const { store } = setup({ perSession: 2, total: 3 })
    start(store, 's1')
    start(store, 's2')
    start(store, 's3')
    expect(store.canStart('s4')).toBe('total')
    expect(store.create(fields('s4'))).toEqual({ error: 'total' })
  })

  it('counts a job that is still starting, and forgets one that failed to start', () => {
    const { store } = setup({ perSession: 1 })
    const { id } = store.create(fields('s1'))
    expect(store.canStart('s1')).toBe('session')
    store.discard(id)
    expect(store.canStart('s1')).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('keeps only the most recent finished jobs', () => {
    const { store, tick } = setup({ keepFinished: 2, perSession: 10, total: 10 })
    const ids = [1, 2, 3].map(() => { tick(10); return start(store) })
    const running = start(store)
    ids.forEach((id) => { tick(10); store.finish(id, { state: 'done', exitCode: 0 }) })
    expect(store.list().map(job => job.id).sort()).toEqual([ids[1], ids[2], running].sort())
  })

  it('stops a running job through its stop function, once', () => {
    const { store } = setup()
    const stop = vi.fn()
    const id = start(store, 's1', stop)
    expect(store.stop(id)).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    store.finish(id, { state: 'stopped', exitCode: null })
    expect(store.stop(id)).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stops the jobs a rule selects', () => {
    const { store } = setup()
    const stopA = vi.fn()
    const stopB = vi.fn()
    start(store, 's1', stopA)
    start(store, 's2', stopB)
    store.stopWhere(job => job.sessionId === 's2')
    expect(stopA).not.toHaveBeenCalled()
    expect(stopB).toHaveBeenCalledTimes(1)
  })

  it('a failing stop function does not keep the others from stopping', () => {
    const { store } = setup()
    const stopB = vi.fn()
    start(store, 's1', () => { throw new Error('gone') })
    start(store, 's2', stopB)
    store.clear()
    expect(stopB).toHaveBeenCalledTimes(1)
  })

  it('clear stops every running job, forgets everything and releases waiting reads', async () => {
    const { store } = setup()
    const stop = vi.fn()
    const id = start(store, 's1', stop)
    store.append(id, 'secret')
    await store.read(id)
    const pending = store.read(id, { waitMs: 5000 })
    store.clear()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(await pending).toBeNull()
    expect(store.list()).toEqual([])
    expect(store.attach(id, { cwd: '/', stop })).toBe(false)
  })

  it('tells when a job has finished', async () => {
    const { store } = setup()
    const id = start(store)
    const pending = store.whenFinished(id, 5000)
    store.finish(id, { state: 'stopped', exitCode: null })
    expect(await pending).toMatchObject({ state: 'stopped' })
    expect(await store.whenFinished(id, 5000)).toMatchObject({ state: 'stopped' })
  })

  it('gives up waiting for the end after the given time', async () => {
    const { store } = setup()
    const id = start(store)
    expect(await store.whenFinished(id, 20)).toMatchObject({ state: 'running' })
  })
})
