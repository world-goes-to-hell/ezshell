import { describe, it, expect } from 'vitest'
import {
  createDirectoryHistory,
  recordVisit,
  requestStep,
  MAX_HISTORY
} from './directoryHistory'

const visitAll = (paths: string[]) =>
  paths.reduce(recordVisit, createDirectoryHistory())

describe('directoryHistory', () => {
  it('first visit sets current without adding a back entry', () => {
    const state = recordVisit(createDirectoryHistory(), '/home')
    expect(state.current).toBe('/home')
    expect(state.back).toEqual([])
  })

  it('ignores an empty initial path so it never becomes a back target', () => {
    const state = visitAll(['', '/home'])
    expect(state.current).toBe('/home')
    expect(state.back).toEqual([])
  })

  it('pushes the previous path on normal navigation and clears forward', () => {
    const state = visitAll(['/', '/home', '/home/user'])
    expect(state.back).toEqual(['/', '/home'])
    expect(state.forward).toEqual([])
  })

  it('does not record a refresh of the same path', () => {
    const state = visitAll(['/', '/home', '/home'])
    expect(state.back).toEqual(['/'])
  })

  it('back step returns the previous path and moves current to forward once it loads', () => {
    const visited = visitAll(['/', '/home', '/home/user'])
    const { state: pending, target } = requestStep(visited, 'back')
    expect(target).toBe('/home')

    const done = recordVisit(pending, '/home')
    expect(done.current).toBe('/home')
    expect(done.back).toEqual(['/'])
    expect(done.forward).toEqual(['/home/user'])
  })

  it('forward step returns to the path we came back from', () => {
    const visited = visitAll(['/', '/home', '/home/user'])
    const afterBack = recordVisit(requestStep(visited, 'back').state, '/home')
    const { state: pending, target } = requestStep(afterBack, 'forward')
    expect(target).toBe('/home/user')

    const done = recordVisit(pending, '/home/user')
    expect(done.back).toEqual(['/', '/home'])
    expect(done.forward).toEqual([])
  })

  it('returns no target when there is nowhere to go', () => {
    const state = visitAll(['/'])
    expect(requestStep(state, 'back').target).toBeNull()
    expect(requestStep(state, 'forward').target).toBeNull()
  })

  it('keeps stacks untouched when a back step never lands (load failed)', () => {
    const visited = visitAll(['/', '/home', '/home/user'])
    const { state: pending } = requestStep(visited, 'back')
    // Load failed: the panel reverts to the original path
    const reverted = recordVisit(pending, '/home/user')
    expect(reverted.back).toEqual(['/', '/home'])
    expect(reverted.forward).toEqual([])
    expect(reverted.pending).toBeNull()
  })

  it('treats a different destination during a pending step as normal navigation', () => {
    const visited = visitAll(['/', '/home', '/home/user'])
    const { state: pending } = requestStep(visited, 'back')
    const state = recordVisit(pending, '/var')
    expect(state.back).toEqual(['/', '/home', '/home/user'])
    expect(state.forward).toEqual([])
  })

  it('caps the back stack length', () => {
    const paths = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => `/d${i}`)
    const state = visitAll(paths)
    expect(state.back).toHaveLength(MAX_HISTORY)
    expect(state.back[state.back.length - 1]).toBe(`/d${MAX_HISTORY + 8}`)
  })
})
