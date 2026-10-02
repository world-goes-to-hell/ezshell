import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import approvalModule from './approval.js'

const { createApprovalBroker } = approvalModule

function setup(overrides = {}) {
  const shown = []
  const dismissed = []
  let count = 0
  const broker = createApprovalBroker({
    show: (request) => { shown.push(request); return true },
    dismiss: (id) => dismissed.push(id),
    timeoutMs: 1000,
    newId: () => `a${++count}`,
    now: () => 0,
    ...overrides
  })
  return { broker, shown, dismissed }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createApprovalBroker', () => {
  it('shows the request and resolves with the answer', async () => {
    const { broker, shown } = setup()
    const answer = broker.request({ command: 'rm x' })
    expect(shown).toEqual([{ id: 'a1', command: 'rm x', expiresAt: 1000 }])
    expect(broker.respond('a1', true)).toBe(true)
    await expect(answer).resolves.toBe('approved')
  })

  it('resolves a refusal as denied', async () => {
    const { broker } = setup()
    const answer = broker.request({})
    broker.respond('a1', false)
    await expect(answer).resolves.toBe('denied')
  })

  it('gives a request its own time limit when it asks for one', async () => {
    const { broker, shown, dismissed } = setup()
    const slow = broker.request({ kind: 'file' }, { timeoutMs: 5000 })
    expect(shown[0].expiresAt).toBe(5000)
    vi.advanceTimersByTime(4999)
    expect(dismissed).toEqual([])
    vi.advanceTimersByTime(1)
    await expect(slow).resolves.toBe('expired')
    // The next request is back to the default
    const quick = broker.request({})
    expect(shown[1].expiresAt).toBe(1000)
    vi.advanceTimersByTime(1000)
    await expect(quick).resolves.toBe('expired')
  })

  it.each([[0], [-5], ['long'], [Infinity]])('ignores an unusable time limit (%j)', (timeoutMs) => {
    const { broker, shown } = setup()
    broker.request({}, { timeoutMs })
    expect(shown[0].expiresAt).toBe(1000)
  })

  it('expires after the timeout and closes the dialog', async () => {
    const { broker, dismissed } = setup()
    const answer = broker.request({})
    vi.advanceTimersByTime(1000)
    await expect(answer).resolves.toBe('expired')
    expect(dismissed).toEqual(['a1'])
  })

  it('asks one request at a time', async () => {
    const { broker, shown } = setup()
    const first = broker.request({ command: 'a' })
    const second = broker.request({ command: 'b' })
    expect(shown.map(request => request.id)).toEqual(['a1'])
    broker.respond('a1', true)
    expect(shown.map(request => request.id)).toEqual(['a1', 'a2'])
    broker.respond('a2', false)
    await expect(first).resolves.toBe('approved')
    await expect(second).resolves.toBe('denied')
  })

  it('ignores answers for requests that are not on screen', () => {
    const { broker } = setup()
    broker.request({})
    broker.request({})
    expect(broker.respond('a2', true)).toBe(false)
    expect(broker.respond('nope', true)).toBe(false)
  })

  it('denies at once when the dialog cannot be shown', async () => {
    const { broker } = setup({ show: () => false })
    await expect(broker.request({})).resolves.toBe('denied')
  })

  it('cancels when the caller aborts', async () => {
    const { broker, dismissed } = setup()
    const controller = new AbortController()
    const answer = broker.request({}, { signal: controller.signal })
    controller.abort()
    await expect(answer).resolves.toBe('cancelled')
    expect(dismissed).toEqual(['a1'])
  })

  it('cancels a queued request without showing it', async () => {
    const { broker, shown } = setup()
    broker.request({})
    const controller = new AbortController()
    const queued = broker.request({}, { signal: controller.signal })
    controller.abort()
    await expect(queued).resolves.toBe('cancelled')
    broker.respond('a1', true)
    expect(shown).toHaveLength(1)
  })

  it('cancels everything on cancelAll', async () => {
    const { broker, shown, dismissed } = setup()
    const first = broker.request({})
    const second = broker.request({})
    broker.cancelAll()
    await expect(first).resolves.toBe('cancelled')
    await expect(second).resolves.toBe('cancelled')
    expect(dismissed).toEqual(['a1'])
    expect(shown).toHaveLength(1)
    expect(broker.pendingCount()).toBe(0)
  })

  it('resolves even if dismiss throws on expiry', async () => {
    const { broker, shown } = setup({ dismiss: () => { throw new Error('dismiss failed') } })
    const first = broker.request({})
    const second = broker.request({})
    vi.advanceTimersByTime(1000)
    await expect(first).resolves.toBe('expired')
    expect(shown.map(r => r.id)).toEqual(['a1', 'a2'])
  })

  it('resolves all promises even if dismiss throws in cancelAll', async () => {
    const { broker } = setup({ dismiss: () => { throw new Error('dismiss failed') } })
    const first = broker.request({})
    const second = broker.request({})
    broker.cancelAll()
    await expect(first).resolves.toBe('cancelled')
    await expect(second).resolves.toBe('cancelled')
  })

  it('denies and shows next if show throws', async () => {
    const shown = []
    const { broker } = setup({ show: (r) => { shown.push(r); if (r.id === 'a1') throw new Error('show failed'); return true } })
    const first = broker.request({ command: 'a' })
    const second = broker.request({ command: 'b' })
    await expect(first).resolves.toBe('denied')
    expect(shown.map(r => r.id)).toEqual(['a1', 'a2'])
    broker.respond('a2', true)
    await expect(second).resolves.toBe('approved')
  })

  it('rejects respond with non-boolean approved value', async () => {
    const { broker } = setup()
    const answer = broker.request({})
    expect(broker.respond('a1', 'true')).toBe(false)
    expect(broker.respond('a1', 1)).toBe(false)
    expect(broker.respond('a1', true)).toBe(true)
    await expect(answer).resolves.toBe('approved')
  })

  it('refuses respond after expiry', async () => {
    const { broker } = setup()
    const answer = broker.request({})
    vi.advanceTimersByTime(1000)
    expect(broker.respond('a1', true)).toBe(false)
    await expect(answer).resolves.toBe('expired')
  })

  it('refuses respond after double answer', async () => {
    const { broker } = setup()
    const answer = broker.request({})
    expect(broker.respond('a1', true)).toBe(true)
    expect(broker.respond('a1', false)).toBe(false)
    await expect(answer).resolves.toBe('approved')
  })

  it('refuses respond after abort', async () => {
    const { broker } = setup()
    const controller = new AbortController()
    const answer = broker.request({}, { signal: controller.signal })
    controller.abort()
    expect(broker.respond('a1', true)).toBe(false)
    await expect(answer).resolves.toBe('cancelled')
  })

  it('refuses respond after cancelAll', async () => {
    const { broker } = setup()
    const answer = broker.request({})
    broker.cancelAll()
    expect(broker.respond('a1', true)).toBe(false)
    await expect(answer).resolves.toBe('cancelled')
  })

  it('puts id after spread to prevent override by details', async () => {
    const { broker, shown } = setup()
    broker.request({ id: 'fake-id', command: 'test' })
    expect(shown[0].id).toBe('a1')
  })
})
