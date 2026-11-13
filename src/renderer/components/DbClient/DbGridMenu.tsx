import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { fitMenu } from '../Sftp/FileListContextMenu'

export interface GridMenuItem {
  /** A heading above the items that follow (not clickable) */
  heading?: boolean
  label: string
  /** Shown dimmer after the label (a column name, a value) */
  detail?: string
  icon?: ReactNode
  onSelect?: () => void
}

interface DbGridMenuProps {
  x: number
  y: number
  items: GridMenuItem[]
  onClose: () => void
}

/**
 * A small menu of the result grid (a column's foreign keys, a cell's actions), drawn on the page
 * itself so the grid's scrolling box does not cut it. Closes on a click elsewhere, Escape or scrolling.
 */
export function DbGridMenu({ x, y, items, onClose }: DbGridMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: y, left: x })

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    setPosition(fitMenu({ x, y }, { width, height }, { width: window.innerWidth, height: window.innerHeight }))
  }, [x, y, items.length])

  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) onClose() }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onClose, { passive: true })
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="context-menu db-grid-menu" style={{ top: position.top, left: position.left }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, index) => item.heading
        ? <div key={index} className="db-grid-menu-heading">{item.label}</div>
        : (
          <div key={index} className="context-menu-item db-grid-menu-item" role="menuitem" onClick={() => { onClose(); item.onSelect?.() }}>
            {item.icon}
            <span className="db-grid-menu-label">{item.label}</span>
            {item.detail && <span className="db-grid-menu-detail">{item.detail}</span>}
          </div>
        ))}
    </div>,
    document.body
  )
}
