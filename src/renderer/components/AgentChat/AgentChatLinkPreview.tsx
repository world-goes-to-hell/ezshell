import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { RiCloseLine, RiExternalLinkLine, RiFileCopyLine, RiFileLine, RiFolderOpenLine, RiLink, RiWindowLine } from 'react-icons/ri'
import { formatBytes } from '../../lib/mcpLabels'
import { isMarkdownFile } from '../../lib/markdownRender'
import { copyToClipboard } from '../../lib/terminalClipboard'
import { toast } from '../../stores/toastStore'
import type { ChatLinkPreviewData, ChatLinkPreviewResult } from '../../types/chatLinkPreview'
import { CodeEditor, type CodeEditorHandle } from '../RemoteFile/CodeEditor'
import { MarkdownPreview } from '../RemoteFile/MarkdownPreview'
import { revealedLine, revealEditorLine } from '../RemoteFile/placeholderLinks'
import './AgentChatLinkPreview.css'

const MIN_WIDTH = 290
const MAX_WIDTH = 720
const START_WIDTH = 410
const CODE_EXTENSIONS = [revealedLine]
const modifiedTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function MediaPreview({ file }: { file: Extract<ChatLinkPreviewData, { kind: 'image' | 'pdf' }> }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const blobUrl = URL.createObjectURL(new Blob([file.data], { type: file.mime }))
    setUrl(blobUrl)
    return () => URL.revokeObjectURL(blobUrl)
  }, [file.data, file.mime])
  if (failed) return <p className="chat-link-preview-empty" role="status">미리보기 없음</p>
  if (!url) return null
  if (file.kind === 'pdf') {
    return <iframe className="chat-link-preview-pdf" src={`${url}#toolbar=0`} title={file.name} referrerPolicy="no-referrer" />
  }
  // SVG stays in image mode. It is never inserted as markup or opened in a document frame.
  return <div className="chat-link-preview-image"><img src={url} alt={file.name} onError={() => setFailed(true)} /></div>
}

function CodePreview({ file }: { file: Extract<ChatLinkPreviewData, { kind: 'text' }> }) {
  const editor = useRef<CodeEditorHandle>(null)
  const [lineUnavailable, setLineUnavailable] = useState(false)
  useEffect(() => {
    const line = file.line
    if (!line) return
    const task = requestAnimationFrame(() => {
      const view = editor.current?.getView()
      if (!view) return
      if (line > view.state.doc.lines) setLineUnavailable(true)
      else revealEditorLine(view, line)
    })
    return () => cancelAnimationFrame(task)
  }, [file.line])
  return <>
    <CodeEditor ref={editor} initialText={file.text} fileName={file.name} readOnly autoFocus={false} extensions={CODE_EXTENSIONS} />
    {lineUnavailable && <p className="chat-link-preview-note">{file.line}행은 미리보기 범위에 없습니다.</p>}
  </>
}

function PreviewBody({ file }: { file: ChatLinkPreviewData }) {
  switch (file.kind) {
    case 'image':
    case 'pdf': return <MediaPreview file={file} />
    case 'text': return <>
      {!file.line && isMarkdownFile(file.name) ? <MarkdownPreview text={file.text} /> : <CodePreview file={file} />}
      {file.truncated && <p className="chat-link-preview-note">파일의 앞부분만 표시합니다.</p>}
    </>
    case 'directory': return <>
      {file.entries.length ? <ul className="chat-link-preview-directory">
        {file.entries.map(({ name, kind }) => {
          const Icon = kind === 'directory' ? RiFolderOpenLine : kind === 'link' ? RiLink : RiFileLine
          return <li key={name} title={name}><Icon size={15} aria-hidden /><span dir="auto">{name}</span></li>
        })}
      </ul> : <p className="chat-link-preview-empty">빈 폴더</p>}
      {file.truncated && <p className="chat-link-preview-note">항목 {file.entries.length}개를 표시합니다.</p>}
    </>
    case 'unavailable': return <div className="chat-link-preview-empty" role="status">
      <strong>미리보기 없음</strong>
      <p>{file.reason === 'too-large' ? '파일이 미리보기 용량을 초과했습니다.' : '이 파일 형식은 미리 볼 수 없습니다.'}</p>
    </div>
  }
}

interface AgentChatLinkPreviewProps {
  shellId: string
  href: string
  onClose: () => void
  onOpen: (href: string, how: 'app' | 'explorer') => void
}

export function AgentChatLinkPreview({ shellId, href, onClose, onOpen }: AgentChatLinkPreviewProps) {
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [answer, setAnswer] = useState<{ href: string; result: ChatLinkPreviewResult } | null>(null)
  const [width, setWidth] = useState(START_WIDTH)
  const drag = useRef<{ id: number; x: number; width: number } | null>(null)
  const current = answer?.href === href ? answer.result : null
  const file = current?.ok ? current.preview : null

  useEffect(() => {
    let active = true
    setAnswer(null)
    const read = window.electronAPI.agentChatLinkPreview
    read?.(shellId, href).then(result => {
      if (active) setAnswer({ href, result })
    }).catch(() => {
      if (active) setAnswer({ href, result: { ok: false, error: '링크를 미리 볼 수 없습니다.' } })
    })
    return () => { active = false }
  }, [href, shellId])

  useEffect(() => { closeRef.current?.focus({ preventScroll: true }) }, [href])

  const measuredWidth = () => panelRef.current?.getBoundingClientRect().width ?? width
  const upperWidth = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (panelRef.current?.parentElement?.clientWidth ?? 1000) - 300))
  const resize = (next: number) => setWidth(Math.round(Math.min(upperWidth(), Math.max(MIN_WIDTH, next))))
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, x: event.clientX, width: measuredWidth() }
    event.preventDefault()
  }
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const started = drag.current
    if (started?.id === event.pointerId) resize(started.width + started.x - event.clientX)
  }
  const endDrag = () => { drag.current = null }
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Home') resize(MIN_WIDTH)
    else if (event.key === 'End') resize(MAX_WIDTH)
    else resize(measuredWidth() + (event.key === 'ArrowLeft' ? 24 : -24))
  }

  return <aside ref={panelRef} className="chat-link-preview" aria-label="파일 미리보기"
    style={{ '--chat-link-preview-width': `${width}px` } as CSSProperties} onContextMenu={event => event.stopPropagation()}>
    <div className="chat-link-preview-divider" role="separator" aria-label="미리보기 폭 조절"
      aria-orientation="vertical" aria-valuemin={MIN_WIDTH} aria-valuemax={MAX_WIDTH} aria-valuenow={width} tabIndex={0}
      onPointerDown={startDrag} onPointerMove={moveDrag} onLostPointerCapture={endDrag} onKeyDown={resizeKey} />
    <header className="chat-link-preview-header">
      <div className="chat-link-preview-heading">
        <h2 title={file?.name}>{file?.name ?? '파일 미리보기'}</h2>
        <button ref={closeRef} type="button" aria-label="미리보기 닫기" title="미리보기 닫기" onClick={onClose}><RiCloseLine size={18} aria-hidden /></button>
      </div>
      {file && <>
        <div className="chat-link-preview-path" title={file.path} dir="auto">{file.path}</div>
        <div className="chat-link-preview-metadata">
          {file.size !== null && <span>{formatBytes(file.size)}</span>}
          <time dateTime={new Date(file.modifiedAt).toISOString()} title="수정 시각">{modifiedTime.format(file.modifiedAt)}</time>
          {file.kind === 'text' && file.line && <span>{file.line}행</span>}
          {file.linked && <span>링크 · 실제 위치가 다릅니다</span>}
        </div>
        <div className="chat-link-preview-actions">
          <button type="button" onClick={() => onOpen(href, 'app')}><RiWindowLine size={14} aria-hidden />ezShell로 열기</button>
          <button type="button" onClick={() => onOpen(href, 'explorer')}><RiExternalLinkLine size={14} aria-hidden />파일 탐색기로 열기</button>
          <button type="button" onClick={async () => {
            if (!(await copyToClipboard(file.path))) toast.error('복사 실패', '클립보드에 접근할 수 없습니다.')
          }}><RiFileCopyLine size={14} aria-hidden />경로 복사</button>
        </div>
      </>}
    </header>
    <div className="chat-link-preview-body" aria-busy={!current}>
      {file ? <PreviewBody key={href} file={file} /> : <p className="chat-link-preview-empty" role="status">
        {current && !current.ok ? current.error : '불러오는 중…'}
      </p>}
    </div>
  </aside>
}
