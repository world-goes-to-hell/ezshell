import { describe, it, expect } from 'vitest'
import { BROWSER_TAB_DEFAULT_TITLE, nextBrowserTabTitle, pageTabTitle } from './browserTabTitle'

describe('pageTabTitle', () => {
  it('shows the page title', () => {
    expect(pageTabTitle({ title: 'GitHub 대시보드', url: 'https://github.com/' })).toBe('GitHub 대시보드')
  })

  it('falls back to the host, then to the default name', () => {
    expect(pageTabTitle({ title: '', url: 'http://localhost:5173/main' })).toBe('localhost:5173')
    expect(pageTabTitle({ url: 'https://example.com/a' })).toBe('example.com')
    expect(pageTabTitle({ title: '   ', url: '' })).toBe(BROWSER_TAB_DEFAULT_TITLE)
  })

  it('keeps one line without control or invisible characters', () => {
    expect(pageTabTitle({ title: ' 첫 줄\n둘째\t줄‮끝\u0007 ', url: '' })).toBe('첫 줄 둘째 줄 끝')
  })

  it('shortens a long title', () => {
    const title = pageTabTitle({ title: 'a'.repeat(200), url: '' })
    expect(title).toHaveLength(80)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('nextBrowserTabTitle', () => {
  it('replaces the default name of a new tab', () => {
    expect(nextBrowserTabTitle(BROWSER_TAB_DEFAULT_TITLE, undefined, 'Google')).toBe('Google')
  })

  it('follows the page while the tab shows what was last set', () => {
    expect(nextBrowserTabTitle('Google', 'Google', 'Gmail')).toBe('Gmail')
    expect(nextBrowserTabTitle('Gmail', 'Gmail', 'Gmail')).toBeNull()
  })

  it('leaves a tab the user renamed', () => {
    expect(nextBrowserTabTitle('내 검토 화면', 'Google', 'Gmail')).toBeNull()
    expect(nextBrowserTabTitle('내 검토 화면', undefined, 'Gmail')).toBeNull()
  })
})
