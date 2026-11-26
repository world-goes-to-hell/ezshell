import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SearchStore = typeof import('./projectSearchStore').useProjectSearchStore
let search: SearchStore
const savedState = 'ezshell.projectSearch'
let stored: Map<string, string>

beforeEach(async () => {
  stored = new Map([[savedState, JSON.stringify({ state: { history: { file: ['Order', 7, 'a\nb', 'Order', 'README'], content: 'bad' } }, version: 0 })]])
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key)
  } })
  vi.resetModules()
  search = (await import('./projectSearchStore')).useProjectSearchStore
})
afterEach(() => vi.unstubAllGlobals())

describe('project search store', () => {
  it('opens again with the last text in the box, unless text was selected on the page', () => {
    const state = () => search.getState()
    state().show('file')
    state().keep('OrderServ')
    state().close()
    expect(state().open).toBeNull()
    state().show('file')
    expect(state().open?.query).toBe('OrderServ')
    state().show('content', 'needle')
    expect(state().open).toMatchObject({ mode: 'content', query: 'needle' })
  })

  it('reads only single-line text from the stored history, and stores each opened search per mode', () => {
    expect(search.getState().history).toEqual({ file: ['Order', 'README'], content: [] })
    search.getState().record('content', 'needle')
    search.getState().record('file', 'README')
    expect(search.getState().history).toEqual({ file: ['README', 'Order'], content: ['needle'] })
    search.getState().forget('file', 'Order')
    const saved = JSON.parse(stored.get(savedState)!).state
    expect(saved).toEqual({ history: { file: ['README'], content: ['needle'] } })
  })
})
