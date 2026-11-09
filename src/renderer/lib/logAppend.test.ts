import { describe, it, expect } from 'vitest'
import { ChangeSet, Text } from '@codemirror/state'
import { countLevels, planAppend, NO_COUNTS } from './logAppend'

const docOf = (value: string) => Text.of(value.split('\n'))
const apply = (doc: Text, plan: ReturnType<typeof planAppend>) => ChangeSet.of(plan.changes, doc.length).apply(doc)
const NO_LIMIT = { maxChars: 1_000_000, keepChars: 1_000_000 }

describe('adding to the log view', () => {
  it('counts only what was added', () => {
    const doc = docOf('ERROR a\nINFO b\n')
    const counts = countLevels(doc)
    expect(counts).toEqual({ error: 1, warn: 0 })
    const plan = planAppend(doc, 'WARN c\nERROR d\n', counts, NO_LIMIT)
    expect(plan).toMatchObject({ counts: { error: 2, warn: 1 }, newErrors: 1, addedLines: 2, trimmed: false })
    expect(apply(doc, plan).toString()).toBe('ERROR a\nINFO b\nWARN c\nERROR d\n')
  })

  it('counts a line once when the new text finishes it', () => {
    // "ERR" alone already reads as an error; finished as "ERROR ..." it is still one error
    const doc = docOf('INFO a\nERR')
    const counts = countLevels(doc)
    expect(counts).toEqual({ ...NO_COUNTS, error: 1 })
    const plan = planAppend(doc, 'OR db down\n', counts, NO_LIMIT)
    expect(plan.counts).toEqual({ error: 1, warn: 0 })
    expect(apply(doc, plan).toString()).toBe('INFO a\nERROR db down\n')
  })

  it('drops the oldest whole lines past the limit and takes their counts away', () => {
    const doc = docOf('ERROR 1\nWARN 2\nINFO 3\n')
    const counts = countLevels(doc)
    const plan = planAppend(doc, 'ERROR 4\n', counts, { maxChars: 25, keepChars: 20 })
    const after = apply(doc, plan)
    expect(plan.trimmed).toBe(true)
    expect(after.toString()).toBe('INFO 3\nERROR 4\n')
    expect(plan.counts).toEqual(countLevels(after))
    expect(plan.addedLines).toBe(1)
  })

  it('keeps counts right after many additions with trimming', () => {
    let doc = docOf('')
    let counts = countLevels(doc)
    const limits = { maxChars: 200, keepChars: 120 }
    for (let i = 0; i < 60; i++) {
      const chunk = i % 3 === 0 ? `ERROR ${i}\n` : i % 3 === 1 ? `WARN ${i}\nINFO x` : ` more ${i}\n`
      const plan = planAppend(doc, chunk, counts, limits)
      doc = apply(doc, plan)
      counts = plan.counts
      expect(counts).toEqual(countLevels(doc))
      expect(doc.length).toBeLessThanOrEqual(limits.maxChars)
    }
  })
})
