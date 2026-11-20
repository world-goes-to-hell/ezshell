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

  it('takes the line off a link to a place in a file (Codex: path:187, GitHub style: #L12)', () => {
    expect(linkTarget('D:/proj/README.md:187', 'win32')).toEqual({ kind: 'path', path: 'D:\\proj\\README.md', key: 'd:\\proj\\readme.md', line: 187 })
    expect(linkTarget('D:/proj/app.ts:12:5', 'win32')).toMatchObject({ path: 'D:\\proj\\app.ts', line: 12 })
    expect(linkTarget('/home/me/app.py#L42', 'linux')).toMatchObject({ path: '/home/me/app.py', line: 42 })
    expect(linkTarget('/home/me/app.py#L42-L50', 'linux')).toMatchObject({ path: '/home/me/app.py', line: 42 })
    // The drive letter is not a line
    expect(linkTarget('D:/proj', 'win32')).toEqual({ kind: 'path', path: 'D:\\proj', key: 'd:\\proj' })
  })

  it('reads a relative link against the agent\'s folder (Claude writes docs/x.md), never without one', () => {
    expect(linkTarget('docs/figma/plugin.md', 'win32', 'D:\\proj')).toMatchObject({ path: 'D:\\proj\\docs\\figma\\plugin.md', key: 'd:\\proj\\docs\\figma\\plugin.md' })
    expect(linkTarget('../plan/a.md:3', 'win32', 'D:\\proj\\docs')).toMatchObject({ path: 'D:\\proj\\plan\\a.md', line: 3 })
    expect(linkTarget('./src/a.ts', 'linux', '/home/me/proj')).toMatchObject({ path: '/home/me/proj/src/a.ts' })
    expect(linkTarget('docs/x.md', 'win32')).toBeNull()
    // Not paths: other schemes, placeholders and patterns from code
    for (const bad of ['app://{{connector_id}}', 'plugin://x', '?:\\s|$', '#anchor', 'mailto:a@b.c', '${bad}', 'a\\\\host']) {
      expect(linkTarget(bad, 'win32', 'D:\\proj')).toBeNull()
    }
  })

  it('finds the links of Markdown, autolinks and bare addresses', () => {
    const text = '- [mcp.json](C:/Users/me/mcp.json) · [문서](https://example.com/a)\n- <https://example.com/b> and https://example.com/c.\n- [share](\\\\host\\x)'
    expect(linkKeysIn(text, 'win32')).toEqual(['c:\\users\\me\\mcp.json', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c'])
    // A relative link counts with the agent's folder; a line does not change the key
    expect(linkKeysIn('[plan](docs/plan.md) [r](D:/proj/README.md:9)', 'win32', 'D:\\proj')).toEqual(['d:\\proj\\docs\\plan.md', 'd:\\proj\\readme.md'])
  })
})
