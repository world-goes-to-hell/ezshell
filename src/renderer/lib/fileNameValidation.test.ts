import { describe, it, expect } from 'vitest'
import { validateNewName } from './fileNameValidation'

const remote = (name: string, existing: string[] = [], currentName?: string) =>
  validateNewName(name, { windowsRules: false, existingNames: existing, currentName })
const local = (name: string, existing: string[] = [], currentName?: string) =>
  validateNewName(name, { windowsRules: true, existingNames: existing, currentName })

describe('validateNewName', () => {
  it('trims surrounding whitespace', () => {
    expect(remote('  a.txt  ')).toEqual({ ok: true, name: 'a.txt' })
  })

  it('rejects empty names and dot entries', () => {
    expect(remote('   ').ok).toBe(false)
    expect(remote('.').ok).toBe(false)
    expect(remote('..').ok).toBe(false)
  })

  it('rejects slashes on both sides', () => {
    expect(remote('a/b').ok).toBe(false)
    expect(local('a/b').ok).toBe(false)
  })

  it('allows characters that only Windows forbids on the remote side', () => {
    expect(remote('a:b?.txt').ok).toBe(true)
    expect(remote('con').ok).toBe(true)
  })

  it('applies Windows rules on the local side', () => {
    for (const bad of ['a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(local(bad).ok).toBe(false)
    }
    expect(local('name.').ok).toBe(false)
    expect(local('CON').ok).toBe(false)
    expect(local('nul.txt').ok).toBe(false)
    expect(local('com1').ok).toBe(false)
    expect(local('console.log').ok).toBe(true)
  })

  it('rejects a name that already exists', () => {
    expect(remote('b.txt', ['a.txt', 'b.txt']).ok).toBe(false)
    expect(local('B.TXT', ['a.txt', 'b.txt']).ok).toBe(false)
    // Remote file systems are case-sensitive
    expect(remote('B.TXT', ['b.txt']).ok).toBe(true)
  })

  it('lets an entry keep its own name or change only its case', () => {
    expect(remote('a.txt', ['a.txt'], 'a.txt')).toEqual({ ok: true, name: 'a.txt' })
    expect(local('A.txt', ['a.txt'], 'a.txt')).toEqual({ ok: true, name: 'A.txt' })
  })

  it('returns a message on failure', () => {
    const result = local('a|b')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('|')
  })
})
