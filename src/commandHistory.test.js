import { describe, it, expect } from 'vitest'
import history from './commandHistory.js'

const { addCommand, removeCommand, isValidHistoryKey, normalizeCommand, sanitizeHistory, MAX_ENTRIES } = history

describe('addCommand', () => {
  it('puts a new command on top', () => {
    const entries = [{ command: 'ls', lastUsedAt: 1 }]
    expect(addCommand(entries, 'pwd', 2)).toEqual([
      { command: 'pwd', lastUsedAt: 2 },
      { command: 'ls', lastUsedAt: 1 }
    ])
  })

  it('moves a repeated command to the top instead of duplicating it', () => {
    const entries = [
      { command: 'pwd', lastUsedAt: 3 },
      { command: 'ls', lastUsedAt: 2 },
      { command: 'whoami', lastUsedAt: 1 }
    ]
    expect(addCommand(entries, 'ls', 4)).toEqual([
      { command: 'ls', lastUsedAt: 4 },
      { command: 'pwd', lastUsedAt: 3 },
      { command: 'whoami', lastUsedAt: 1 }
    ])
  })

  it('drops the oldest entries beyond the limit', () => {
    const entries = [{ command: 'b', lastUsedAt: 2 }, { command: 'a', lastUsedAt: 1 }]
    expect(addCommand(entries, 'c', 3, 2).map(e => e.command)).toEqual(['c', 'b'])
  })

  it('does not mutate the input list', () => {
    const entries = [{ command: 'ls', lastUsedAt: 1 }]
    addCommand(entries, 'pwd', 2)
    expect(entries).toEqual([{ command: 'ls', lastUsedAt: 1 }])
  })

  it('defaults to a 500 entry limit', () => {
    expect(MAX_ENTRIES).toBe(500)
  })
})

describe('removeCommand', () => {
  it('removes only the matching command', () => {
    const entries = [{ command: 'ls', lastUsedAt: 2 }, { command: 'pwd', lastUsedAt: 1 }]
    expect(removeCommand(entries, 'ls')).toEqual([{ command: 'pwd', lastUsedAt: 1 }])
  })
})

describe('normalizeCommand', () => {
  it('keeps a normal command', () => {
    expect(normalizeCommand('docker compose ps')).toBe('docker compose ps')
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['non-string', 42],
    ['multi-line', 'ls\nrm -rf /'],
    ['control characters', 'ls\x1b[A'],
    ['too long', 'a'.repeat(4097)]
  ])('rejects %s', (_label, value) => {
    expect(normalizeCommand(value)).toBeNull()
  })
})

describe('isValidHistoryKey', () => {
  it.each([
    'c6a1e0f2-6f1b-4c2a-9b1e-2d3f4a5b6c7d',
    'quick:root@10.0.0.1:22',
    'quick:deploy@my-host.example.com:2222',
    'quick:ci+bot@host:22',
    'quick:관리자@서버.example:22',
    'quick:root@[::1]:22'
  ])('accepts %s', (key) => {
    expect(isValidHistoryKey(key)).toBe(true)
  })

  it.each(['', '__proto__', 'constructor', 'a b', 'a\tb', 'a\nb', 'x'.repeat(301), null])('rejects %s', (key) => {
    expect(isValidHistoryKey(key)).toBe(false)
  })
})

describe('sanitizeHistory', () => {
  it('keeps valid keys and entries and drops the rest', () => {
    const raw = {
      'quick:root@host:22': [
        { command: 'ls', lastUsedAt: 2 },
        { command: '', lastUsedAt: 1 },
        { command: 'pwd' },
        'not an entry'
      ],
      'bad key': [{ command: 'ls', lastUsedAt: 1 }],
      other: 'not a list'
    }
    expect(sanitizeHistory(raw)).toEqual({
      'quick:root@host:22': [{ command: 'ls', lastUsedAt: 2 }],
      other: []
    })
  })

  it('returns an empty object for non-object input', () => {
    expect(sanitizeHistory(null)).toEqual({})
    expect(sanitizeHistory([])).toEqual({})
  })
})
