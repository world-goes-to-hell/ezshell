// The Markdown view of the file window: the editor's text as a document. The HTML comes from
// lib/markdownRender.ts, which keeps it inert (no raw HTML, no images, only http(s)/mailto links).
// Links do not navigate this window: the address shows on hover and a click copies it.
import { useMemo, type MouseEvent } from 'react'
import { renderMarkdown } from '../../lib/markdownRender'
import { toast } from '../../stores/toastStore'
import './MarkdownPreview.css'

export function MarkdownPreview({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as HTMLElement).closest('a')
    if (!link) return
    event.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' })
      return
    }
    void navigator.clipboard?.writeText(href).then(() => toast.info('링크 주소를 복사했습니다', href), () => {})
  }

  return (
    <div className="markdown-preview" onClick={onClick}>
      {/* eslint-disable-next-line react/no-danger -- inert HTML from markdownRender (html: false, links checked, no images) */}
      <article className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
