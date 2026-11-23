// Markdown to HTML for the file window's Markdown view (RemoteFile/MarkdownPreview.tsx).
// The file may come from anywhere (a server, a cloned repository), so the output stays inert:
// raw HTML in the file is shown as text (`html: false`), links that are not http(s)/mailto/#anchors
// are left out by markdown-it's own check plus ours, and images become their alt text: the page's
// Content Security Policy would refuse them anyway (and a remote image would tell its server the file was read).
import MarkdownIt from 'markdown-it'

const SAFE_LINK = /^(https?:|mailto:|#)/i
/**
 * A file or folder of this PC: "C:\…", "C:/…", "/…", "file:///…" (never "\\host\share"), or a relative path
 * an agent writes ("docs/x.md", "../plan/a.md"; main reads it against the agent's folder and opens it only
 * when it is in the conversation and exists: src/agentChat/links.js)
 */
// The relative form never starts with a slash, or its encoding: markdown-it checks a link after encoding
// it, so "\\host\share" arrives as "%5Chost%5Cshare"
export const LOCAL_PATH_LINK = /^(?:[a-z]:[\\/]|\/(?![\\/])|file:\/\/\/|(?![a-z][a-z0-9+.-]*:|#|[\\/]|%5c|%2f)[^\s<>"|?*{}$]+$)/i

/**
 * A path an agent writes as inline code (`D:\proj\db\a.sql`, `src/ipc/a.js:12`, `docs/plan/`), drawn as a link in
 * the chat (2026-11-23 user report: it could not be opened). Main counts the same spans as links of the
 * conversation (src/agentChat/links.js CODE_PATH: keep the two in step). A relative one needs a folder and a file
 * name with an extension (or a closing slash): `feat/branch`, `/compact` and `role_sn` stay text.
 */
export const CODE_PATH = /^(?:[a-z]:[\\/][^<>"|?*\u0000-\u001f]*|\/[^\s<>"|?*{}$\\/]+\/[^\s<>"|?*{}$\\]*|(?:[^\s<>"|?*{}$\\/:]+[\\/])+(?:[^\s<>"|?*{}$\\/:]+\.[a-z0-9]{1,10}(?::\d{1,7}(?::\d{1,7})?|#L\d{1,7}(?:-L?\d{1,7})?)?)?)$/i

/** `localLinks`: links to this PC's files stay links (the agent chat opens them through main) */
function create(localLinks = false): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
  const defaultValidate = md.validateLink.bind(md)
  md.validateLink = (url: string) => (localLinks && LOCAL_PATH_LINK.test(url.trim())) || (defaultValidate(url) && SAFE_LINK.test(url.trim()))
  if (localLinks) {
    // Kept as written: the usual encoding turns a Windows path's backslashes into %5C
    const defaultNormalize = md.normalizeLink.bind(md)
    md.normalizeLink = (url: string) => (LOCAL_PATH_LINK.test(url.trim()) ? url.trim() : defaultNormalize(url))
    const defaultCode = md.renderer.rules.code_inline!
    md.renderer.rules.code_inline = (tokens, index, options, env, self) => {
      const html = defaultCode(tokens, index, options, env, self)
      const path = tokens[index].content.trim()
      if (!CODE_PATH.test(path) || insideLink(tokens, index)) return html
      return `<a href="${md.utils.escapeHtml(path)}" class="md-code-link">${html}</a>`
    }
  }
  md.renderer.rules.image = (tokens, index) => {
    const alt = md.utils.escapeHtml(tokens[index].content || '이미지')
    return `<span class="md-image" title="이미지는 표시하지 않습니다">[${alt}]</span>`
  }
  return md
}

/** Whether an inline token sits between a link's open and close (a link may not hold another) */
function insideLink(tokens: { type: string }[], index: number): boolean {
  for (let at = index - 1; at >= 0; at--) {
    if (tokens[at].type === 'link_close') return false
    if (tokens[at].type === 'link_open') return true
  }
  return false
}

let instance: MarkdownIt | null = null
let chatInstance: MarkdownIt | null = null

export function renderMarkdown(text: string): string {
  instance ??= create()
  return instance.render(text)
}

/** An agent's answer in the chat view: like renderMarkdown, and links to this PC's files stay links */
export function renderChatMarkdown(text: string): string {
  chatInstance ??= create(true)
  return chatInstance.render(text)
}

/** Explicit HTTP(S) links in terminal output, including their text offsets. */
export function webLinksIn(text: string) {
  instance ??= create()
  return (instance.linkify.match(text) ?? []).filter(link => /^https?:\/\//i.test(link.raw))
}

/** Whether a file name is a Markdown file (the window offers the Markdown view) */
export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(name)
}
