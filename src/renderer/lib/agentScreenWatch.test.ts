import { describe, expect, it } from 'vitest'
import { INITIAL_SCREEN_WATCH, readScreenWatch } from './agentScreenWatch'

const composer = { composer: '', approval: null }
const gone = { composer: null, approval: null }
const asking = { composer: null, approval: { question: 'Allow?' } }

function run(screens: (typeof composer | typeof gone | typeof asking | null)[]) {
  let watch = INITIAL_SCREEN_WATCH
  return screens.map(screen => {
    const next = readScreenWatch(watch, screen)
    watch = next.watch
    return next.open
  })
}

describe('a screen of the CLI over the chat', () => {
  it('opens the terminal once the composer that was there stays gone for three reads', () => {
    expect(run([composer, gone, gone, gone])).toEqual([false, false, false, true])
  })

  it('waits through a redraw that hides the composer for a moment', () => {
    expect(run([composer, gone, gone, composer, gone, gone])).toEqual([false, false, false, false, false, false])
  })

  it('leaves questions to the chat, which answers them with its own cards', () => {
    expect(run([composer, asking, asking, asking, asking])).toEqual([false, false, false, false, false])
  })

  it('waits longer when the composer was never seen (an agent still starting)', () => {
    expect(run(Array(9).fill(gone))).toEqual(Array(9).fill(false))
    expect(run(Array(10).fill(gone))[9]).toBe(true)
  })

  it('opens once, then counts again from the start', () => {
    expect(run([composer, gone, gone, gone, gone, gone, gone])).toEqual([false, false, false, true, false, false, true])
    expect(run([composer, null, gone, gone, gone])).toEqual([false, false, false, false, true])
  })
})
