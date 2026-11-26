import { describe, expect, it } from 'vitest'
import { redactRunOutput, redactRunSecrets } from './runSecrets.js'

describe('run output credentials', () => {
  it.each([
    ['db.password=fixture-password port=8080', 'db.password=**** port=8080'],
    ['pwd: fixture-pwd', 'pwd: ****'],
    ['"client_secret": "fixture secret with spaces"', '"client_secret": "****"'],
    ['-Dspring.datasource.password=fixture-vm', '-Dspring.datasource.password=****'],
    ['-Ddb.password="fixture \\"quoted\\" secret" -Xmx64m', '-Ddb.password="****" -Xmx64m'],
    ['jdbc:postgresql://fixture-user:fixture-pass@db.example.test/app', 'jdbc:postgresql://****@db.example.test/app'],
    ['Authorization: Bearer fixture-bearer', 'Authorization: Bearer ****'],
    ['"Authorization":"Basic Zml4dHVyZQ=="', '"Authorization":"Basic ****"'],
    ['Bearer fixture-free-bearer', 'Bearer ****'],
    ['<password>fixture-xml-value</password><port>8080</port>', '<password>****</password><port>8080</port>'],
    [`cloud key AKIA${'A'.repeat(16)}`, 'cloud key ****'],
    [`ghp_${'a'.repeat(36)} github_pat_${'b'.repeat(40)}`, '**** ****'],
    ['token=fixture-token\nGET /ready 200\nheaders missing', 'token=****\nGET /ready 200\nheaders missing'],
  ])('masks credentials in %s', (input, expected) => {
    expect(redactRunSecrets(input)).toBe(expected)
    expect(redactRunSecrets(expected)).toBe(expected)
  })

  it('preserves the shape and leaves the internal diagnostic unchanged', () => {
    const diagnostic = { status: 'compileError', at: 1, groups: [{ lines: ['ERROR secret=fixture-diagnosis'] }] }
    expect(redactRunOutput(diagnostic)).toEqual({ status: 'compileError', at: 1, groups: [{ lines: ['ERROR secret=****'] }] })
    expect(diagnostic.groups[0].lines).toEqual(['ERROR secret=fixture-diagnosis'])
  })
})
