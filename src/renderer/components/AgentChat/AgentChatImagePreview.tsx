import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState, type CSSProperties } from 'react'
import { RiCloseLine } from 'react-icons/ri'

export function useChatImageUrl(image: Blob): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const next = URL.createObjectURL(image)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [image])
  return url
}

interface AgentChatImagePreviewProps {
  shellId: string
  imageId?: string
  thumbnail: Blob
  label: string
  themeStyle?: CSSProperties
  onClose: () => void
  onRestoreFocus: () => void
}

export function AgentChatImagePreview({ shellId, imageId, thumbnail, label, themeStyle, onClose, onRestoreFocus }: AgentChatImagePreviewProps) {
  const [original, setOriginal] = useState<Blob | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const url = useChatImageUrl(original ?? thumbnail)

  useEffect(() => {
    const read = window.electronAPI.agentChatPreviewImage
    if (!imageId || !read) return
    let active = true
    void read(shellId, imageId).then(result => {
      if (active && result.ok) {
        setOriginal(new Blob([result.data], { type: 'image/png' }))
        setUnavailable(false)
      }
    }).catch(() => {})
    return () => { active = false }
  }, [shellId, imageId])

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" onMouseDown={event => event.stopPropagation()}
          onContextMenu={event => event.stopPropagation()} />
        <Dialog.Content className="modal-content agent-chat-image-preview" aria-describedby={undefined} style={themeStyle}
          onMouseDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
          onEscapeKeyDown={event => {
            event.stopPropagation()
            if (event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) event.preventDefault()
          }}
          onCloseAutoFocus={event => { event.preventDefault(); onRestoreFocus() }}>
          <header className="agent-chat-image-preview-header">
            <Dialog.Title>{label}</Dialog.Title>
            <Dialog.Close className="agent-chat-image-preview-close" aria-label="이미지 미리보기 닫기" title="닫기 (Esc)">
              <RiCloseLine size={20} aria-hidden />
            </Dialog.Close>
          </header>
          <div className="agent-chat-image-preview-body">
            {unavailable ? <p role="status">이미지를 불러올 수 없습니다.</p> : url && (
              <img src={url} alt={label} draggable={false} onError={() => {
                if (original) setOriginal(null)
                else setUnavailable(true)
              }} />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
