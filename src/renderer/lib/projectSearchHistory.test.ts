import { describe, expect, it } from 'vitest'
import { completeSearch, MAX_SEARCH_HISTORY, withSearch, withoutSearch } from './projectSearchHistory'

describe('project search history', () => {
  it('puts the newest search first, once, and keeps a limited number', () => {
    expect(withSearch(['Order', 'README'], 'README')).toEqual(['README', 'Order'])
    expect(withSearch(['Order'], 'order')).toEqual(['order', 'Order'])
    const many = Array.from({ length: MAX_SEARCH_HISTORY }, (_, index) => `q${index}`)
    const next = withSearch(many, 'new')
    expect(next).toHaveLength(MAX_SEARCH_HISTORY)
    expect(next[0]).toBe('new')
    expect(next).not.toContain(`q${MAX_SEARCH_HISTORY - 1}`)
  })

  it('does not keep blank, multi-line or overlong text', () => {
    const list = ['Order']
    expect(withSearch(list, '   ')).toBe(list)
    expect(withSearch(list, 'a\nb')).toBe(list)
    expect(withSearch(list, 'x'.repeat(201))).toBe(list)
  })

  it('forgets one search', () => {
    expect(withoutSearch(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('completes what was typed with the newest search that begins with it, keeping the typed letters', () => {
    const history = ['OrderService', 'OrderController', 'README']
    expect(completeSearch('ord', history)).toBe('orderService')
    expect(completeSearch('OrderC', history)).toBe('OrderController')
    expect(completeSearch('README', history)).toBeNull()
    expect(completeSearch('', history)).toBeNull()
    expect(completeSearch('xyz', history)).toBeNull()
  })
})
