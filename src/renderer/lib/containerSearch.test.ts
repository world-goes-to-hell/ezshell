import { describe, it, expect } from 'vitest'
import { searchTerms, matchName, orderBySearch } from './containerSearch'

describe('searchTerms', () => {
  it('splits at spaces, commas and bars, without case, each word once', () => {
    expect(searchTerms('  Nginx, redis |api  nginx ')).toEqual(['nginx', 'redis', 'api'])
    expect(searchTerms('')).toEqual([])
    expect(searchTerms(' , | ')).toEqual([])
  })

  it('keeps at most 20 words of at most 100 letters', () => {
    expect(searchTerms(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '))).toHaveLength(20)
    expect(searchTerms('x'.repeat(150))[0]).toHaveLength(100)
  })
})

describe('matchName', () => {
  it('marks every place a word appears, ignoring case', () => {
    expect(matchName('web-API-api', ['api'])).toEqual([
      { text: 'web-', isMatch: false }, { text: 'API', isMatch: true }, { text: '-', isMatch: false }, { text: 'api', isMatch: true }
    ])
  })

  it('joins overlapping matches of different words', () => {
    expect(matchName('mbris-db', ['bris', 'is-d'])).toEqual([
      { text: 'm', isMatch: false }, { text: 'bris-d', isMatch: true }, { text: 'b', isMatch: false }
    ])
  })

  it('is null when no word is in the name or nothing is searched', () => {
    expect(matchName('redis', ['nginx'])).toBeNull()
    expect(matchName('redis', [])).toBeNull()
  })
})

describe('orderBySearch', () => {
  const containers = [{ name: 'db' }, { name: 'web-nginx' }, { name: 'cache-redis' }, { name: 'api' }, { name: 'nginx-proxy' }]

  it('puts any container matching one of the words first, and keeps all the others below', () => {
    const rows = orderBySearch(containers, searchTerms('nginx redis'))
    expect(rows.map(row => row.item.name)).toEqual(['web-nginx', 'cache-redis', 'nginx-proxy', 'db', 'api'])
    expect(rows.map(row => row.parts !== null)).toEqual([true, true, true, false, false])
  })

  it('keeps the order as it is without a search', () => {
    const rows = orderBySearch(containers, [])
    expect(rows.map(row => row.item.name)).toEqual(containers.map(c => c.name))
    expect(rows.every(row => row.parts === null)).toBe(true)
  })

  it('shows every container even when nothing matches', () => {
    expect(orderBySearch(containers, ['zzz'])).toHaveLength(containers.length)
  })
})
