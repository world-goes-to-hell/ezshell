import { describe, it, expect } from 'vitest'
import { diff } from '@codemirror/merge'
import { COMPARE_DIFF_CONFIG } from './compareDiff'

// A file like src/remoteFiles/documents.js (about 25 KB) changed in many places spread over the whole
// file (a line added every 40 lines), as after a day of work: no long stretch is shared from end to
// end, so the library cannot split the problem in halves and has to match line by line.
const lines = Array.from({ length: 600 }, (_, i) => `const value${i} = require('./module${i % 37}.js') // line ${i}`)
const before = lines.join('\n')
const edited = lines.flatMap((line, i) => (i % 40 === 6 ? [`const added${i} = require('./new${i}.js')`, line] : [line]))
const after = edited.join('\n')
const addedLines = edited.length - lines.length
const changedInB = (changes: readonly { fromB: number; toB: number }[]) => changes.reduce((sum, c) => sum + (c.toB - c.fromB), 0)

describe('compare diff config', () => {
  it('finds just the added lines in a long file changed in many places', () => {
    expect(before.length).toBeGreaterThan(25_000)
    const changes = diff(before, after, COMPARE_DIFF_CONFIG)
    expect(changes.every(c => c.toA === c.fromA)).toBe(true)
    expect(changes).toHaveLength(addedLines)
    expect(changedInB(changes)).toBeLessThan(addedLines * 60)
  })

  it('the old scan limit marked almost the whole file instead (the bug)', () => {
    expect(changedInB(diff(before, after, { scanLimit: 500 }))).toBeGreaterThan(20_000)
  })
})
