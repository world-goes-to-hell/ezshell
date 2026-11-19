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

  it('leaves the file window\'s Markdown view as it was', () => {
    expect(renderMarkdown('[x](C:/Users/me/a.txt)')).not.toContain('href=')
  })
})
