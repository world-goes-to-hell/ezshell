import { useEffect, useRef, useState } from 'react'
import { RiContrastDrop2Line } from 'react-icons/ri'
import { useThemeStore } from '../../stores/themeStore'
import { MIN_WINDOW_OPACITY } from '../../lib/appearance'
import './OpacityStatus.css'

/**
 * Window opacity in the status bar: the same setting as 설정 > 테마 > 창 투명도, within reach while
 * working. The button shows the current value; pressing it opens a small panel with the slider.
 */
export function OpacityStatus() {
  const windowOpacity = useThemeStore(state => state.windowOpacity)
  const setWindowOpacity = useThemeStore(state => state.setWindowOpacity)
  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on a press outside or Escape
  useEffect(() => {
    if (!isOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen])

  // An app built before the call existed cannot change the window: showing a control would mislead
  if (typeof window.electronAPI?.setWindowOpacity !== 'function') return null

  const percent = Math.round(windowOpacity * 100)
  const isChanged = percent < 100

  return (
    <div className="opacity-status" ref={rootRef}>
      <button
        type="button"
        className={`zoom-status opacity-status-btn ${isChanged ? 'changed' : ''}`}
        onClick={() => setIsOpen(open => !open)}
        aria-expanded={isOpen}
        title={`창 투명도 ${percent}%`}
        aria-label={`창 투명도 ${percent}%`}
      >
        <RiContrastDrop2Line size={14} />
        <span>{percent}%</span>
      </button>
      {isOpen && (
        <div className="opacity-panel" role="dialog" aria-label="창 투명도">
          <div className="opacity-panel-head">
            <span>창 투명도</span>
            <span className="opacity-panel-value">{percent}%</span>
          </div>
          <input
            type="range"
            min={MIN_WINDOW_OPACITY * 100}
            max={100}
            step={5}
            value={percent}
            onChange={event => setWindowOpacity(Number(event.target.value) / 100)}
            aria-label="창 투명도"
            autoFocus
          />
          <button type="button" className="opacity-panel-reset" onClick={() => setWindowOpacity(1)} disabled={!isChanged}>
            100%로 되돌리기
          </button>
        </div>
      )}
    </div>
  )
}
