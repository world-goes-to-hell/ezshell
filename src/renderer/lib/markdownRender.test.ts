import { describe, expect, it } from 'vitest'
import { isMarkdownFile, renderMarkdown } from './markdownRender'

describe('renderMarkdown', () => {
  it('renders the usual Markdown', () => {
    const html = renderMarkdown('# Title\n\n- **bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x = 1\n```\n')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<table>')
    expect(html).toContain('<pre><code class="language-js">')
  })

  it('shows raw HTML as text', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('keeps http links and drops script, file and data links', () => {
    expect(renderMarkdown('[ok](https://example.com)')).toContain('href="https://example.com"')
    for (const bad of ['javascript:alert(1)', 'file:///C:/secret.txt', 'data:text/html,hi', '\\\\host\\share']) {
      expect(renderMarkdown(`[x](${bad})`)).not.toContain('href=')
    }
  })

  it('turns images into their alt text', () => {
    const html = renderMarkdown('![logo <b>](https://example.com/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('[logo &lt;b&gt;]')
  })

  it('knows Markdown file names', () => {
    expect(isMarkdownFile('README.md')).toBe(true)
    expect(isMarkdownFile('notes.MARKDOWN')).toBe(true)
    expect(isMarkdownFile('app.ts')).toBe(false)
  })
})

describe('renderChatMarkdown (an agent\'s answer)', () => {
  it('keeps links to this PC\'s files as written, and still drops script and network-share links', async () => {
    const { renderChatMarkdown } = await import('./markdownRender')
    expect(renderChatMarkdown('[mcp.json](C:/Users/me/AppData/Roaming/ezshell/mcp.json)')).toContain('href="C:/Users/me/AppData/Roaming/ezshell/mcp.json"')
    expect(renderChatMarkdown('[x](C:\\Users\\me\\a.txt)')).toContain('href="C:\\Users\\me\\a.txt"')
    expect(renderChatMarkdown('[x](file:///C:/a.txt)')).toContain('href="file:///C:/a.txt"')
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', '\\\\host\\share', '//host/share']) {
      expect(renderChatMarkdown(`[x](${bad})`)).not.toContain('href=')
    }
  })

  it('keeps relative file links of an answer ("docs/x.md", "../a.md:3") as written', async () => {
    const { renderChatMarkdown, LOCAL_PATH_LINK } = await import('./markdownRender')
    expect(renderChatMarkdown('[계획](docs/plan/a.md)')).toContain('href="docs/plan/a.md"')
    expect(renderChatMarkdown('[a](../plan/한글.md:3)')).toContain('href="../plan/한글.md:3"')
    expect(LOCAL_PATH_LINK.test('docs/plan/a.md')).toBe(true)
    for (const bad of ['#anchor', 'mailto:a@b.c', '%5Chost%5Cshare', 'app://x', '${bad}']) expect(LOCAL_PATH_LINK.test(bad)).toBe(false)
  })

  it('makes a path written as inline code a link (2026-11-23 user report: the path could not be opened)', async () => {
    const { renderChatMarkdown } = await import('./markdownRender')
    expect(renderChatMarkdown('파일 위치: `D:\\DEV\\db\\a.sql`')).toContain('<a href="D:\\DEV\\db\\a.sql" class="md-code-link"><code>D:\\DEV\\db\\a.sql</code></a>')
    expect(renderChatMarkdown('`src/ipc/a.js:12`')).toContain('href="src/ipc/a.js:12"')
    expect(renderChatMarkdown('`docs/plan/`')).toContain('href="docs/plan/"')
    for (const plain of ['`role_sn`', '`/compact`', '`feat/log-view`', '`rsrc-mng-role.sql`', '`\\\\host\\x\\a.sql`', '`a"b/c.md`']) {
      expect(renderChatMarkdown(plain)).not.toContain('href=')
    }
    // Not a link inside a link
    expect(renderChatMarkdown('[`docs/a.md`](docs/b.md)').match(/<a /g)).toHaveLength(1)
  })

  it('leaves the file window\'s Markdown view as it was', () => {
    expect(renderMarkdown('`docs/a.md`')).not.toContain('href=')
    expect(renderMarkdown('[x](C:/Users/me/a.txt)')).not.toContain('href=')
  })
})
