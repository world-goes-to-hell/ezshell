import { describe, expect, it } from 'vitest'
import { createDoubleShift, highlightParts, contentRows, splitPath, DOUBLE_SHIFT_MS } from './projectSearch'

type Key = { type: 'keydown' | 'keyup'; key: string; repeat?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }
const down = (key: string, extra: Partial<Key> = {}): Key => ({ type: 'keydown', key, ...extra })
const up = (key: string, extra: Partial<Key> = {}): Key => ({ type: 'keyup', key, ...extra })

function detector() {
  let time = 1000
  const shift = createDoubleShift(() => time)
  const feed = (keys: Key[], step = 50) => keys.map(key => { time += step; return shift(key) })
  return { feed, wait: (ms: number) => { time += ms } }
}

describe('Shift twice', () => {
  it('fires on the second release of two quick Shift taps with nothing between', () => {
    const { feed } = detector()
    expect(feed([down('Shift'), up('Shift'), down('Shift'), up('Shift')])).toEqual([false, false, false, true])
  })

  it('does not fire for typing: a letter between the taps, or Shift held for a capital or a Korean double consonant', () => {
    const { feed } = detector()
    expect(feed([down('Shift'), down('A'), up('A'), up('Shift'), down('Shift'), down('B'), up('B'), up('Shift')])).not.toContain(true)
    expect(feed([down('Shift'), up('Shift'), down('ㅃ'), down('Shift'), up('Shift')])).not.toContain(true)
  })

  it('does not fire when the taps are too far apart, a tap is held, the key repeats or a modifier is down', () => {
    const slow = detector()
    slow.feed([down('Shift'), up('Shift')])
    slow.wait(DOUBLE_SHIFT_MS)
    expect(slow.feed([down('Shift'), up('Shift')])).toEqual([false, false])
    const held = detector()
    expect(held.feed([down('Shift'), up('Shift'), down('Shift')]).concat(held.feed([up('Shift')], DOUBLE_SHIFT_MS + 10))).not.toContain(true)
    const repeated = detector()
    expect(repeated.feed([down('Shift'), down('Shift', { repeat: true }), up('Shift'), down('Shift'), up('Shift')])).not.toContain(true)
    const ctrl = detector()
    expect(ctrl.feed([down('Shift', { ctrlKey: true }), up('Shift'), down('Shift', { ctrlKey: true }), up('Shift')])).not.toContain(true)
  })

  it('starts over after it fired: a third tap is not a second double', () => {
    const { feed } = detector()
    expect(feed([down('Shift'), up('Shift'), down('Shift'), up('Shift'), down('Shift'), up('Shift')])).toEqual([false, false, false, true, false, false])
  })
})

describe('results', () => {
  it('marks every place the text was found, with or without case', () => {
    expect(highlightParts('Hello hello HELLO', 'hello', false)).toEqual([
      { text: 'Hello', hit: true }, { text: ' ', hit: false }, { text: 'hello', hit: true }, { text: ' ', hit: false }, { text: 'HELLO', hit: true }
    ])
    expect(highlightParts('Hello hello', 'hello', true)).toEqual([{ text: 'Hello ', hit: false }, { text: 'hello', hit: true }])
    expect(highlightParts('nothing', 'x', false)).toEqual([{ text: 'nothing', hit: false }])
    expect(highlightParts('a.b(c)', '.b(', false)).toEqual([{ text: 'a', hit: false }, { text: '.b(', hit: true }, { text: 'c)', hit: false }])
  })

  it('puts each file head before its lines; only lines are picked', () => {
    const rows = contentRows([{ path: 'src/a.ts', matches: [{ line: 3, text: 'x' }, { line: 9, text: 'y' }] }, { path: 'b.md', matches: [{ line: 1, text: 'z' }] }])
    expect(rows.map(row => row.kind === 'file' ? `F ${row.path} ${row.count}` : `L ${row.path}:${row.line} #${row.index}`)).toEqual([
      'F src/a.ts 2', 'L src/a.ts:3 #0', 'L src/a.ts:9 #1', 'F b.md 1', 'L b.md:1 #2'
    ])
  })

  it('splits a path into its name and folder', () => {
    expect(splitPath('src/renderer/App.tsx')).toEqual({ name: 'App.tsx', folder: 'src/renderer' })
    expect(splitPath('README.md')).toEqual({ name: 'README.md', folder: '' })
  })
})
