// Markdown to HTML for the file window's Markdown view (RemoteFile/MarkdownPreview.tsx).
// The file may come from anywhere (a server, a cloned repository), so the output stays inert:
// raw HTML in the file is shown as text (`html: false`), links that are not http(s)/mailto/#anchors
// are left out by markdown-it's own check plus ours, and images become their alt text: the page's
// Content Security Policy would refuse them anyway (and a remote image would tell its server the file was read).
import MarkdownIt from 'markdown-it'

const SAFE_LINK = /^(https?:|mailto:|#)/i
/** A file or folder of this PC: "C:\…", "C:/…", "/…" or "file:///…" (never "\\host\share") */
export const LOCAL_PATH_LINK = /^(?:[a-z]:[\\/]|\/(?![\\/])|file:\/\/\/)/i

/** `localLinks`: links to this PC's files stay links (the agent chat opens them through main) */
function create(localLinks = false): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false })
  const defaultValidate = md.validateLink.bind(md)
  md.validateLink = (url: string) => (localLinks && LOCAL_PATH_LINK.test(url.trim())) || (defaultValidate(url) && SAFE_LINK.test(url.trim()))
  if (localLinks) {
    // Kept as written: the usual encoding turns a Windows path's backslashes into %5C
    const defaultNormalize = md.normalizeLink.bind(md)
    md.normalizeLink = (url: string) => (LOCAL_PATH_LINK.test(url.trim()) ? url.trim() : defaultNormalize(url))
  }
  md.renderer.rules.image = (tokens, index) => {
    const alt = md.utils.escapeHtml(tokens[index].content || '이미지')
    return `<span class="md-image" title="이미지는 표시하지 않습니다">[${alt}]</span>`
  }
  return md
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

/** Whether a file name is a Markdown file (the window offers the Markdown view) */
export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(name)
}
