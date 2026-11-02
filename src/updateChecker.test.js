import { describe, it, expect, vi } from 'vitest'
import checkerModule from './updateChecker.js'

const { createUpdateChecker } = checkerModule

function setup({ check = vi.fn(async () => {}), focusGapMs = 1000 } = {}) {
  let time = 0
  const checker = createUpdateChecker({ check, now: () => time, focusGapMs })
  return { checker, check, advance: (ms) => { time += ms } }
}

describe('createUpdateChecker', () => {
  it('checks in the background and is quiet only while the check runs', async () => {
    let seenQuiet = null
    const { checker } = setup({ check: vi.fn(async () => { seenQuiet = checker.isQuiet() }) })
    expect(await checker.run()).toBe(true)
    expect(seenQuiet).toBe(true)
    expect(checker.isQuiet()).toBe(false)
  })

  it('stops being quiet when the check fails', async () => {
    const { checker } = setup({ check: vi.fn(async () => { throw new Error('offline') }) })
    await expect(checker.run()).resolves.toBe(true)
    expect(checker.isQuiet()).toBe(false)
  })

  it('does not check again once an update is downloading or downloaded', async () => {
    const { checker, check } = setup()
    checker.setStage('downloading')
    expect(await checker.run()).toBe(false)
    checker.setStage('downloaded')
    expect(await checker.run()).toBe(false)
    expect(check).not.toHaveBeenCalled()
  })

  it('checks when the window gets focus only if the last check was a while ago', async () => {
    const { checker, check, advance } = setup({ focusGapMs: 1000 })
    await checker.run()
    advance(999)
    expect(await checker.onFocus()).toBe(false)
    advance(1)
    expect(await checker.onFocus()).toBe(true)
    expect(check).toHaveBeenCalledTimes(2)
  })
})
