import { describe, it, expect } from 'vitest'
import { EditorState, Text } from '@codemirror/state'
import { countProblems, findProblem, logProblemField, problemOrdinal, problemsOf, scanProblems } from './logProblems'
import { planAppend } from './logAppend'
import type { JumpLevel } from './logLevels'

const docOf = (value: string) => Text.of(value.split('\n'))
const linesOf = (doc: Text, problems: ReturnType<typeof scanProblems>) => problems.map(p => `${doc.lineAt(p.pos).number}:${p.level}`)
const BOTH = new Set<JumpLevel>(['error', 'warn'])
const ERRORS = new Set<JumpLevel>(['error'])

const TRACE = [
  'INFO start',
  'ERROR request failed',
  'java.lang.IllegalStateException: boom',
  '\tat com.example.A.run(A.java:1)',
  '\tat com.example.B.run(B.java:2)',
  'Caused by: java.sql.SQLException: ERROR: relation "t" does not exist',
  '\t... 12 more',
  'INFO next',
  'WARN slow',
  'WARN slower',
  'ERROR one',
  'ERROR two',
  'java.lang.NullPointerException',
  '\tat com.example.C.run(C.java:3)'
].join('\n')

describe('problems of a log', () => {
  it('takes a stack trace as one error', () => {
    const doc = docOf(TRACE)
    expect(linesOf(doc, scanProblems(doc))).toEqual(['2:error', '9:warn', '10:warn', '11:error', '12:error'])
    expect(countProblems(scanProblems(doc))).toEqual({ error: 3, warn: 2 })
  })

  it('a crash without a level line above is an error of its own', () => {
    const doc = docOf('INFO a\njava.lang.NullPointerException\n\tat x.Y.z(Y.java:1)\nINFO b')
    expect(linesOf(doc, scanProblems(doc))).toEqual(['2:error'])
  })

  it('a stack under a warning belongs to the warning', () => {
    const doc = docOf('WARN retry\njava.io.IOException: reset\n\tat x.Y.z(Y.java:1)')
    expect(linesOf(doc, scanProblems(doc))).toEqual(['1:warn'])
  })

  it('takes a Python traceback as one error, source lines included', () => {
    const doc = docOf([
      'INFO a',
      'ERROR job crashed',
      'Traceback (most recent call last):',
      '  File "/app/job.py", line 88, in run',
      '    rows = fetch(cursor)',
      '  File "/app/db.py", line 12, in fetch',
      '    return int(value)',
      'ValueError: invalid literal for int()',
      'INFO b',
      'Traceback (most recent call last):',
      '  File "/app/x.py", line 1, in <module>',
      '    main()',
      'KeyError: 1'
    ].join('\n'))
    expect(linesOf(doc, scanProblems(doc))).toEqual(['2:error', '10:error'])
    expect(linesOf(doc, scanProblems(doc, 8, 8))).toEqual([])
    expect(linesOf(doc, scanProblems(doc, 13, 13))).toEqual([])
  })

  it('reads a range with the line above it in mind', () => {
    const doc = docOf(TRACE)
    expect(linesOf(doc, scanProblems(doc, 3, 6))).toEqual([])
    expect(linesOf(doc, scanProblems(doc, 13, 14))).toEqual([])
  })

  it('counts from a place on', () => {
    const doc = docOf(TRACE)
    const problems = scanProblems(doc)
    expect(countProblems(problems, doc.line(9).from)).toEqual({ error: 2, warn: 2 })
    expect(countProblems(problems, doc.length)).toEqual({ error: 0, warn: 0 })
  })

  it('tells which problem the cursor is at', () => {
    const doc = docOf(TRACE)
    const problems = scanProblems(doc)
    expect(problemOrdinal(problems, 0)).toBe(0)
    expect(problemOrdinal(problems, doc.line(2).from)).toBe(1)
    expect(problemOrdinal(problems, doc.line(5).from)).toBe(1)
    expect(problemOrdinal(problems, doc.line(14).from)).toBe(5)
  })
})

describe('moving between problems', () => {
  const doc = docOf(TRACE)
  const problems = scanProblems(doc)
  const at = (line: number) => doc.line(line).from
  const lineOf = (result: ReturnType<typeof findProblem>) => (result.problem ? doc.lineAt(result.problem.pos).number : null)

  it('goes to the next and previous report, not the next line', () => {
    expect(lineOf(findProblem(problems, at(2), 1, BOTH))).toBe(9)
    expect(lineOf(findProblem(problems, at(4), -1, BOTH))).toBe(2)
    expect(lineOf(findProblem(problems, at(2), 1, ERRORS))).toBe(11)
  })

  it('goes to the first and the last', () => {
    expect(lineOf(findProblem(problems, at(9), 'first', BOTH))).toBe(2)
    expect(lineOf(findProblem(problems, at(1), 'last', BOTH))).toBe(12)
    expect(lineOf(findProblem(problems, at(1), 'first', new Set<JumpLevel>(['warn'])))).toBe(9)
  })

  it('goes round the end and says so, or stops there', () => {
    const round = findProblem(problems, at(12), 1, BOTH)
    expect([round.outcome, lineOf(round)]).toEqual(['wrapped', 2])
    expect(findProblem(problems, at(12), 1, BOTH, false)).toEqual({ outcome: 'end', problem: null })
    expect(findProblem(problems, at(2), -1, BOTH, false).outcome).toBe('end')
  })

  it('answers none when there is no other one', () => {
    const single = docOf('INFO a\nERROR b\nINFO c')
    const list = scanProblems(single)
    expect(findProblem(list, single.line(2).from, 1, BOTH).outcome).toBe('none')
    expect(findProblem(list, 0, 1, new Set<JumpLevel>(['warn'])).outcome).toBe('none')
  })
})

describe('the problem list in the editor state', () => {
  const CHUNKS = [
    'Traceback (most recent call last):\n', '  File "/app/j.py", line 3, in run\n', '    go()\n', 'ValueError: bad\n',
    '  File "/app/k.py", line 9, in go', '\n', '    stray()\nKeyError: 2\n',
    'ERROR a\n', 'java.lang.X', 'Exception: boom\n', '\tat a.B.c(B.java:1)\n', 'INFO ok\n', 'WARN w\nINFO x',
    ' more\n', '\tat stray.Frame.run(F.java:9)\n', 'ERR', 'OR late\n', 'Caused by: java.io.IOException: ERROR x\n', 'INFO end\n'
  ]

  it('stays equal to a full read through additions and trimming', () => {
    let state = EditorState.create({ doc: '', extensions: [logProblemField] })
    const limits = { maxChars: 260, keepChars: 150 }
    for (let round = 0; round < 80; round++) {
      const plan = planAppend(state.doc, CHUNKS[round % CHUNKS.length], limits)
      state = state.update({ changes: plan.changes }).state
      expect(problemsOf(state)).toEqual(scanProblems(state.doc))
      expect(state.doc.length).toBeLessThanOrEqual(limits.maxChars)
    }
  })

  it('reads the text it starts with', () => {
    const state = EditorState.create({ doc: TRACE, extensions: [logProblemField] })
    expect(problemsOf(state)).toHaveLength(5)
  })
})
