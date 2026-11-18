import { describe, it, expect } from 'vitest'
import { ChangeSet, Text } from '@codemirror/state'
import { planAppend } from './logAppend'

const docOf = (value: string) => Text.of(value.split('\n'))
const apply = (doc: Text, plan: ReturnType<typeof planAppend>) => ChangeSet.of(plan.changes, doc.length).apply(doc)
const NO_LIMIT = { maxChars: 1_000_000, keepChars: 1_000_000 }

describe('adding to the log view', () => {
  it('adds at the end and counts the new lines', () => {
    const doc = docOf('ERROR a\nINFO b\n')
    const plan = planAppend(doc, 'WARN c\nERROR d\n', NO_LIMIT)
    expect(plan).toMatchObject({ addedLines: 2, trimmed: false })
    expect(apply(doc, plan).toString()).toBe('ERROR a\nINFO b\nWARN c\nERROR d\n')
  })

  it('tells where the line it finished starts', () => {
    const doc = docOf('INFO a\nERR')
    const plan = planAppend(doc, 'OR db down\n', NO_LIMIT)
    const after = apply(doc, plan)
    expect(after.toString()).toBe('INFO a\nERROR db down\n')
    expect(after.lineAt(plan.resumedAt).text).toBe('ERROR db down')
    expect(plan.addedLines).toBe(1)
  })

  it('drops the oldest whole lines past the limit', () => {
    const doc = docOf('ERROR 1\nWARN 2\nINFO 3\n')
    const plan = planAppend(doc, 'ERROR 4\n', { maxChars: 25, keepChars: 20 })
    const after = apply(doc, plan)
    expect(plan.trimmed).toBe(true)
    expect(after.toString()).toBe('INFO 3\nERROR 4\n')
    expect(plan.addedLines).toBe(1)
    expect(after.lineAt(plan.resumedAt).text).toBe('ERROR 4')
  })

  it('stays under the limit through many additions', () => {
    let doc = docOf('')
    const limits = { maxChars: 200, keepChars: 120 }
    for (let i = 0; i < 60; i++) {
      const chunk = i % 3 === 0 ? `ERROR ${i}\n` : i % 3 === 1 ? `WARN ${i}\nINFO x` : ` more ${i}\n`
      doc = apply(doc, planAppend(doc, chunk, limits))
      expect(doc.length).toBeLessThanOrEqual(limits.maxChars)
    }
  })
})
