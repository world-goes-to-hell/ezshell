import { describe, expect, it } from 'vitest'
import { addressDisplay, inlineCompletion, suggestAddresses } from './browserAddressSuggestions'

const history = [
  { url: 'http://localhost:5173/', title: '관리자', visitedAt: 30 },
  { url: 'https://www.github.com/org/repo/pulls', title: 'Pull requests', visitedAt: 20 },
  { url: 'https://docs.example.com/guide?lang=ko', title: 'Example 가이드', visitedAt: 10 },
  { url: 'http://localhost:8080/login', title: '로그인', visitedAt: 40 }
]
const bookmarks = [{ url: 'https://gitlab.example.com/', title: 'GitLab' }, { kind: 'folder' as const, id: 'f', title: '업무', children: [
  { url: 'https://portal.example.com/', title: '업무 포털' }
] }]

describe('browser address suggestions', () => {
  it('shows an address without its scheme, and without the slash of a bare host', () => {
    expect(addressDisplay('http://localhost:5173/')).toBe('localhost:5173')
    expect(addressDisplay('https://docs.example.com/guide?lang=ko')).toBe('docs.example.com/guide?lang=ko')
  })

  it('puts addresses that start with the typed text first, newest first, then other matches', () => {
    expect(suggestAddresses('local', history, bookmarks).map(item => item.display))
      .toEqual(['localhost:8080/login', 'localhost:5173'])
    expect(suggestAddresses('git', history, bookmarks).map(item => item.display))
      .toEqual(['www.github.com/org/repo/pulls', 'gitlab.example.com'])
    expect(suggestAddresses('example', history, bookmarks).map(item => item.display))
      .toEqual(['docs.example.com/guide?lang=ko', 'gitlab.example.com', 'portal.example.com'])
  })

  it('matches page titles, bookmarks inside folders, and ignores the scheme typed', () => {
    expect(suggestAddresses('포털', history, bookmarks).map(item => item.url)).toEqual(['https://portal.example.com/'])
    expect(suggestAddresses('https://local', history, bookmarks)).toHaveLength(2)
    expect(suggestAddresses('  ', history, bookmarks)).toEqual([])
    expect(suggestAddresses('nothing-like-this', history, bookmarks)).toEqual([])
  })

  it('completes the typed text inline with the best address it begins, keeping what was typed', () => {
    const list = suggestAddresses('Loc', history, bookmarks)
    expect(inlineCompletion('Loc', list)).toEqual({ text: 'Localhost:8080/login', url: 'http://localhost:8080/login' })
    // www. is skipped: typing the site name completes it
    expect(inlineCompletion('git', suggestAddresses('git', history, bookmarks))).toEqual({
      text: 'github.com/org/repo/pulls', url: 'https://www.github.com/org/repo/pulls'
    })
    // A title match is a suggestion, never an inline completion
    expect(inlineCompletion('포털', suggestAddresses('포털', history, bookmarks))).toBeNull()
    expect(inlineCompletion('localhost:8080/login', suggestAddresses('localhost:8080/login', history, bookmarks))).toBeNull()
  })
})
