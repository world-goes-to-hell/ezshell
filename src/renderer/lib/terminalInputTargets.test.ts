import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerMainInputTarget,
  setFocusedInputTarget,
  unregisterInputTarget,
  insertIntoSession,
  resetInputTargets
} from './terminalInputTargets'

const makeTarget = () => ({ insert: vi.fn() })

describe('terminal input targets', () => {
  beforeEach(() => resetInputTargets())

  it('inserts into the main terminal by default', () => {
    const main = makeTarget()
    registerMainInputTarget('s1', main)
    expect(insertIntoSession('s1', 'ls')).toBe(true)
    expect(main.insert).toHaveBeenCalledWith('ls')
  })

  it('inserts into the pane that was focused last', () => {
    const main = makeTarget()
    const split = makeTarget()
    registerMainInputTarget('s1', main)
    setFocusedInputTarget('s1', split)
    insertIntoSession('s1', 'pwd')
    expect(split.insert).toHaveBeenCalledWith('pwd')
    expect(main.insert).not.toHaveBeenCalled()
  })

  it('falls back to the main terminal when the focused pane goes away', () => {
    const main = makeTarget()
    const split = makeTarget()
    registerMainInputTarget('s1', main)
    setFocusedInputTarget('s1', split)
    unregisterInputTarget('s1', split)
    insertIntoSession('s1', 'whoami')
    expect(main.insert).toHaveBeenCalledWith('whoami')
  })

  it('keeps sessions separate', () => {
    const a = makeTarget()
    registerMainInputTarget('a', a)
    expect(insertIntoSession('b', 'ls')).toBe(false)
    expect(a.insert).not.toHaveBeenCalled()
  })

  it('ignores unregistering a target that was already replaced', () => {
    const first = makeTarget()
    const second = makeTarget()
    registerMainInputTarget('s1', first)
    registerMainInputTarget('s1', second)
    unregisterInputTarget('s1', first)
    insertIntoSession('s1', 'ls')
    expect(second.insert).toHaveBeenCalledWith('ls')
  })
})
