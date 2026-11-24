import { describe, expect, it, vi } from 'vitest'
import { GIT_READ_LIMITS, createReadCache, forgetAfterCommit, gitCommitFilesKey, gitLogKey, gitReadLimit, gitStatusKey, succeeded } from './gitReadCache'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('createReadCache', () => {
  it('keeps the last answer for the next open', async () => {
    const cache = createReadCache()
    expect(cache.peek('a')).toBeUndefined()
    await cache.read('a', async () => 1)
    expect(cache.peek('a')).toBe(1)
    await cache.read('a', async () => 2)
    expect(cache.peek('a')).toBe(2)
  })

  it('shares a read already running for the same key', async () => {
    const cache = createReadCache()
    const answer = deferred<number>()
    const load = vi.fn(() => answer.promise)
    const first = cache.read('a', load)
    const second = cache.read('a', load)
    answer.resolve(7)
    expect(await first).toBe(7)
    expect(await second).toBe(7)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not share or keep a read that began before an invalidation (a refresh, a commit)', async () => {
    const cache = createReadCache()
    const old = deferred<string>()
    const oldRead = cache.read('a', () => old.promise)
    cache.invalidate()
    const fresh = vi.fn(async () => 'after')
    const freshRead = cache.read('a', fresh)
    expect(fresh).toHaveBeenCalledTimes(0) // runs on the next tick, but on its own
    expect(await freshRead).toBe('after')
    old.resolve('before')
    expect(await oldRead).toBe('before')
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(cache.peek('a')).toBe('after')
  })

  it('does not keep answers that keep() refuses', async () => {
    const cache = createReadCache()
    await cache.read('a', async () => ({ success: false }), succeeded)
    expect(cache.peek('a')).toBeUndefined()
    await cache.read('a', async () => ({ success: true }), succeeded)
    expect(cache.peek('a')).toEqual({ success: true })
  })

  it('a failed read is not kept and the next read runs again', async () => {
    const cache = createReadCache()
    await expect(cache.read('a', async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(cache.peek('a')).toBeUndefined()
    expect(await cache.read('a', async () => 3)).toBe(3)
  })

  it('forgets the oldest answers past the limit', async () => {
    const cache = createReadCache({ limitOf: () => ({ group: '', max: 2 }) })
    await cache.read('a', async () => 1)
    await cache.read('b', async () => 2)
    await cache.read('a', async () => 1) // used again: now newest
    await cache.read('c', async () => 3)
    expect(cache.peek('b')).toBeUndefined()
    expect(cache.peek('a')).toBe(1)
    expect(cache.peek('c')).toBe(3)
  })

  it('clear() forgets everything, and a read running at the time is not kept', async () => {
    const cache = createReadCache()
    await cache.read('a', async () => 1)
    const late = deferred<number>()
    const running = cache.read('b', () => late.promise)
    cache.clear()
    late.resolve(2)
    await running
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('b')).toBeUndefined()
  })
})

describe('gitReadLimit', () => {
  it('keeps few large answers (history, changes) and many small ones (a commit\'s files), each kind apart', async () => {
    expect(GIT_READ_LIMITS).toEqual({ log: 20, status: 20, files: 200 })
    const cache = createReadCache({ limitOf: gitReadLimit })
    for (let index = 0; index < 25; index += 1) await cache.read(gitStatusKey(`D:\\r${index}`), async () => index)
    for (let index = 0; index < 210; index += 1) await cache.read(gitCommitFilesKey('D:\\r', `h${index}`), async () => index)
    await cache.read(gitLogKey('D:\\r', false), async () => 'log')
    // The 5 oldest status answers went; the files and the history did not push them (or each other) out
    expect(cache.peek(gitStatusKey('D:\\r4'))).toBeUndefined()
    expect(cache.peek(gitStatusKey('D:\\r5'))).toBe(5)
    expect(cache.peek(gitStatusKey('D:\\r24'))).toBe(24)
    expect(cache.peek(gitCommitFilesKey('D:\\r', 'h9'))).toBeUndefined()
    expect(cache.peek(gitCommitFilesKey('D:\\r', 'h10'))).toBe(10)
    expect(cache.peek(gitLogKey('D:\\r', false))).toBe('log')
  })
})

describe('forgetAfterCommit', () => {
  it("drops the history and the changes, keeps a commit's files", async () => {
    const cache = createReadCache()
    const keys = [gitLogKey('D:\\repo', false), gitLogKey('D:\\repo', true), gitStatusKey('D:\\repo'), gitCommitFilesKey('D:\\repo', 'a'.repeat(40))]
    for (const key of keys) await cache.read(key, async () => key)
    forgetAfterCommit(cache)
    expect(keys.map(key => cache.peek(key) !== undefined)).toEqual([false, false, false, true])
  })
})

describe('keys', () => {
  it('tell the checkout history from all branches and one folder from another', () => {
    expect(gitLogKey('D:\\a', false)).not.toBe(gitLogKey('D:\\a', true))
    expect(gitStatusKey('D:\\a')).not.toBe(gitStatusKey('D:\\b'))
    expect(gitCommitFilesKey('D:\\a', 'x')).not.toBe(gitCommitFilesKey('D:\\a', 'y'))
  })
})
