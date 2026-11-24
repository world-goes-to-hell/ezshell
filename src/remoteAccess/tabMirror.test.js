import { describe, it, expect, vi } from 'vitest'
import { createTabMirror } from './tabMirror.js'

describe('createTabMirror', () => {
  it('keeps a tab\'s latest output and the PC\'s size for a phone that attaches later', () => {
    const mirror = createTabMirror()
    mirror.record('t1', Buffer.from('first\r\n'))
    mirror.resize('t1', 132, 43)
    const onData = vi.fn()
    const attached = mirror.attach('t1', { onData, onEnd: vi.fn() })
    expect(attached).toMatchObject({ cols: 132, rows: 43, snapshot: 'first\r\n' })
    mirror.record('t1', 'next')
    expect(onData).toHaveBeenCalledWith('next')
    attached.detach()
    mirror.record('t1', 'more')
    expect(onData).toHaveBeenCalledTimes(1)
  })

  it('keeps a bounded amount, starting at a line once the front was cut', () => {
    const mirror = createTabMirror({ maxChars: 100 })
    mirror.record('t1', `${'x'.repeat(80)}\n${'y'.repeat(60)}`)
    const { snapshot } = mirror.attach('t1', { onData: vi.fn(), onEnd: vi.fn() })
    expect(snapshot).toBe('y'.repeat(60))
  })

  it('keeps the exact tail across many small chunks and one oversized chunk', () => {
    const mirror = createTabMirror({ maxChars: 13 })
    for (let index = 0; index < 400; index++) mirror.record('t1', String(index % 10))
    const handlers = { onData: vi.fn(), onEnd: vi.fn() }
    expect(mirror.attach('t1', handlers).snapshot).toBe('7890123456789')
    mirror.record('t1', 'abcdefghijklmnop')
    mirror.record('t1', 'xy')
    expect(mirror.attach('t1', handlers).snapshot).toBe('fghijklmnopxy')
    expect(handlers.onData.mock.calls).toEqual([['abcdefghijklmnop'], ['xy']])
  })

  it('keeps nothing while remote access is off, and ignores a size that is not one', () => {
    let on = false
    const mirror = createTabMirror({ isEnabled: () => on })
    mirror.record('t1', 'secret')
    mirror.resize('t1', 120, 30)
    on = true
    mirror.resize('t1', 0, 30)
    mirror.resize('t1', 'x', 30)
    expect(mirror.attach('t1', { onData: vi.fn(), onEnd: vi.fn() })).toMatchObject({ cols: 80, rows: 24, snapshot: '' })
  })

  it('tells followers when the tab ends and drops a closed tab\'s output', () => {
    const mirror = createTabMirror()
    mirror.record('t1', 'out')
    const onEnd = vi.fn()
    mirror.attach('t1', { onData: vi.fn(), onEnd })
    mirror.ended('t1', 'disconnected')
    expect(onEnd).toHaveBeenCalledWith('disconnected')
    expect(mirror.followerCount('t1')).toBe(0)
    // A reconnect continues under the same id: the output is still there
    expect(mirror.attach('t1', { onData: vi.fn(), onEnd: vi.fn() }).snapshot).toBe('out')
    mirror.ended('t1', 'closed')
    expect(mirror.attach('t1', { onData: vi.fn(), onEnd: vi.fn() }).snapshot).toBe('')
  })

  it('forgets everything when cleared', () => {
    const mirror = createTabMirror()
    mirror.record('t1', 'out')
    mirror.clear()
    expect(mirror.attach('t1', { onData: vi.fn(), onEnd: vi.fn() }).snapshot).toBe('')
  })
})
