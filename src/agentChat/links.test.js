import { describe, expect, it } from 'vitest'
import { linkKeysIn, linkTarget } from './links.js'

describe('links in an agent\'s answer', () => {
  it('reads files of this PC and web pages, one key whatever the spelling', () => {
    expect(linkTarget('C:/Users/me/a.txt', 'win32')).toEqual({ kind: 'path', path: 'C:\\Users\\me\\a.txt', key: 'c:\\users\\me\\a.txt' })
    expect(linkTarget('file:///C:/Users/me/a%20b.txt', 'win32')?.path).toBe('C:\\Users\\me\\a b.txt')
    expect(linkTarget('C:/Users/me/a%20b.txt', 'win32')?.key).toBe('c:\\users\\me\\a b.txt')
    expect(linkTarget('/home/me/a.txt', 'linux')).toEqual({ kind: 'path', path: '/home/me/a.txt', key: '/home/me/a.txt' })
    expect(linkTarget('https://example.com/docs', 'win32')).toEqual({ kind: 'url', url: 'https://example.com/docs', key: 'https://example.com/docs' })
  })

  it('refuses network shares, relative paths and other schemes', () => {
    for (const bad of ['\\\\host\\share\\a', '//host/share', 'file://host/share/a', 'a.txt', '../a', 'javascript:alert(1)', '%APPDATA%\\a', 'C:/a\nb']) {
      expect(linkTarget(bad, 'win32')).toBeNull()
    }
  })

  it('finds the links of Markdown, autolinks and bare addresses', () => {
    const text = '- [mcp.json](C:/Users/me/mcp.json) · [문서](https://example.com/a)\n- <https://example.com/b> and https://example.com/c.\n- [share](\\\\host\\x)'
    expect(linkKeysIn(text, 'win32')).toEqual(['c:\\users\\me\\mcp.json', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c'])
  })
})
