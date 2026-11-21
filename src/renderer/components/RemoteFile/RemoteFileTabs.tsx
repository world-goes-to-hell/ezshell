import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { RiCloseLine, RiFileEditLine } from 'react-icons/ri'
import { fileNameOf } from '../../lib/remoteFileText'
import type { RemoteFileTab } from '../../types'

const DRAG_THRESHOLD = 8
const DETACH_MARGIN = 16

interface PressedTab {
  docId: string
  pointerId: number
  x: number
  y: number
}

interface RemoteFileTabsProps {
  tabs: RemoteFileTab[]
  activeId: string | null
  movingId: string | null
  onSelect: (docId: string) => void
  onClose: (tab: RemoteFileTab) => void
  onDetach: (docId: string) => void
}

const moved = (event: PointerEvent, press: PressedTab) =>
  Math.hypot(event.clientX - press.x, event.clientY - press.y) >= DRAG_THRESHOLD

export function RemoteFileTabs({ tabs, activeId, movingId, onSelect, onClose, onDetach }: RemoteFileTabsProps) {
  const bar = useRef<HTMLDivElement>(null)
  const pressed = useRef<PressedTab | null>(null)
  const suppressClick = useRef(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const detach = useRef(onDetach)
  detach.current = onDetach

  useEffect(() => {
    if (activeId && !pressed.current) {
      document.getElementById(`file-tab-${activeId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [activeId])

  const cancelDrag = () => {
    pressed.current = null
    setDraggedId(null)
  }

  useEffect(() => {
    const track = (event: PointerEvent) => {
      const press = pressed.current
      if (!suppressClick.current && press?.pointerId === event.pointerId && moved(event, press)) {
        suppressClick.current = true
        setDraggedId(press.docId)
      }
    }
    const finish = (event: PointerEvent) => {
      const press = pressed.current
      const bounds = bar.current?.getBoundingClientRect()
      if (press?.pointerId !== event.pointerId || !bounds) return
      const isDrag = suppressClick.current || moved(event, press)
      suppressClick.current = isDrag
      cancelDrag()
      const { clientX, clientY } = event
      if (isDrag && (clientY < bounds.top - DETACH_MARGIN || clientY > bounds.bottom + DETACH_MARGIN
        || clientX < bounds.left - DETACH_MARGIN || clientX > bounds.right + DETACH_MARGIN)) {
        detach.current(press.docId)
      }
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !pressed.current) return
      suppressClick.current = true
      cancelDrag()
    }
    window.addEventListener('pointermove', track)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancelDrag)
    window.addEventListener('blur', cancelDrag)
    window.addEventListener('keydown', onEscape)
    return () => {
      window.removeEventListener('pointermove', track)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancelDrag)
      window.removeEventListener('blur', cancelDrag)
      window.removeEventListener('keydown', onEscape)
    }
  }, [])

  const start = (event: ReactPointerEvent<HTMLButtonElement>, docId: string) => {
    if (event.button !== 0 || pressed.current || movingId) return
    suppressClick.current = false
    pressed.current = { docId, pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  return (
    <div ref={bar} className={`remote-file-tabs${draggedId ? ' is-dragging' : ''}`} role="tablist" aria-label="열린 파일">
      {tabs.map(tab => {
        const name = fileNameOf(tab.path, tab.local)
        const active = tab.docId === activeId
        return (
          <div key={tab.docId} className={`remote-file-tab${active ? ' is-active' : ''}${draggedId === tab.docId ? ' is-dragged' : ''}`}>
            <button type="button" role="tab" className="remote-file-tab-select" id={`file-tab-${tab.docId}`}
              aria-controls={`file-pane-${tab.docId}`} aria-selected={active} title={tab.path}
              onPointerDown={event => start(event, tab.docId)}
              onClick={event => { if (!suppressClick.current || event.detail === 0) onSelect(tab.docId) }}>
              <RiFileEditLine size={14} aria-hidden="true" />
              <span className="remote-file-tab-name">{name}</span>
              {tab.dirty && <span className="remote-file-tab-dirty" role="img" aria-label="저장하지 않은 변경" />}
            </button>
            <button type="button" className="remote-file-tab-close" aria-label={`${name} 탭 닫기`} disabled={tab.docId === movingId}
              onClick={() => onClose(tab)}><RiCloseLine size={14} aria-hidden="true" /></button>
          </div>
        )
      })}
    </div>
  )
}
