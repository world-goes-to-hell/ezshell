import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
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

const MIN_WIDTH = 480
const MAX_WIDTH = 1100
const BACKDROP_GAP = 24
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
  themeStyle?: CSSProperties
  onClose: () => void
  onRestoreFocus: () => void
  onOpen: (href: string, how: 'app' | 'explorer') => void
}

export function AgentChatLinkPreview({ shellId, href, themeStyle, onClose, onRestoreFocus, onOpen }: AgentChatLinkPreviewProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [answer, setAnswer] = useState<{ href: string; result: ChatLinkPreviewResult } | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const [requestedWidth, setRequestedWidth] = useState<number | null>(null)
  const drag = useRef<{ pointerId: number; clientX: number; width: number } | null>(null)
  const current = answer?.href === href ? answer.result : null
  const file = current?.ok ? current.preview : null
  const maxWidth = Math.min(MAX_WIDTH, Math.max(0, viewportWidth - BACKDROP_GAP))
  const minWidth = Math.min(MIN_WIDTH, maxWidth)
  const clampWidth = (next: number) => Math.round(Math.min(maxWidth, Math.max(minWidth, next)))
  const width = clampWidth(requestedWidth ?? viewportWidth * 0.55)

  useEffect(() => {
    const syncViewport = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', syncViewport)
    syncViewport()
    return () => window.removeEventListener('resize', syncViewport)
  }, [])

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

  const resize = (next: number) => setRequestedWidth(clampWidth(next))
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return
    event.preventDefault()
    drag.current = { pointerId: event.pointerId, clientX: event.clientX, width }
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (start?.pointerId === event.pointerId) resize(start.width + start.clientX - event.clientX)
  }
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null
  }
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Home') resize(minWidth)
    else if (event.key === 'End') resize(maxWidth)
    else resize(width + (event.key === 'ArrowLeft' ? 24 : -24))
  }

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay chat-link-preview-overlay"
        onMouseDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()} />
      <Dialog.Content className="chat-link-preview" aria-modal="true" aria-describedby={undefined}
        style={{ ...themeStyle, width }} onMouseDown={event => event.stopPropagation()}
        onContextMenu={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
        onOpenAutoFocus={event => { event.preventDefault(); closeRef.current?.focus({ preventScroll: true }) }}
        onCloseAutoFocus={event => { event.preventDefault(); onRestoreFocus() }}
        onEscapeKeyDown={event => {
          event.stopPropagation()
          if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) event.preventDefault()
        }}>
        <header className="chat-link-preview-header">
          <div className="chat-link-preview-heading">
            <Dialog.Title title={file?.name}>{file?.name ?? '파일 미리보기'}</Dialog.Title>
            <Dialog.Close ref={closeRef} aria-label="미리보기 닫기" title="미리보기 닫기"><RiCloseLine size={18} aria-hidden /></Dialog.Close>
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
        {minWidth < maxWidth && <div className="chat-link-preview-divider" role="separator" aria-label="미리보기 폭 조절"
          aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={width} tabIndex={0}
          onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag} onKeyDown={resizeKey} onDoubleClick={() => setRequestedWidth(null)} />}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
