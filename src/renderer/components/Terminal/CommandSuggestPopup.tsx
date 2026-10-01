import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './CommandSuggestPopup.css'

/** Screen position of the input being typed: left edge, and the top / bottom of the cursor row */
export interface SuggestAnchor {
  left: number
  top: number
  bottom: number
}

interface CommandSuggestPopupProps {
  items: string[]
  typed: string
  /** Index of the selected item, or null while nothing is selected */
  selected: number | null
  anchor: SuggestAnchor
  /** Element id of an option; the terminal's textarea points at the selected one (aria-activedescendant) */
  optionId: (index: number) => string
  onPick: (index: number) => void
}

const VIEWPORT_MARGIN = 8

/** The command with the typed part emphasized */
function Highlighted({ command, typed }: { command: string; typed: string }) {
  const at = command.indexOf(typed)
  if (at < 0) return <>{command}</>
  return (
    <>
      {command.slice(0, at)}
      <mark>{command.slice(at, at + typed.length)}</mark>
      {command.slice(at + typed.length)}
    </>
  )
}

/**
 * History suggestions under the input line (above it when there is no room below).
 * The terminal keeps focus: keys are handled by the terminal's key handler, and mouse presses
 * here are cancelled so the click does not blur the terminal.
 */
export function CommandSuggestPopup({ items, typed, selected, anchor, optionId, onPick }: CommandSuggestPopupProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const fitsBelow = anchor.bottom + height + VIEWPORT_MARGIN <= window.innerHeight
    const top = fitsBelow ? anchor.bottom : Math.max(VIEWPORT_MARGIN, anchor.top - height)
    const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, window.innerWidth - width - VIEWPORT_MARGIN))
    setPosition({ left, top })
  }, [anchor.left, anchor.top, anchor.bottom, items.length])

  return createPortal(
    <div
      ref={ref}
      className="command-suggest"
      style={position ?? { left: anchor.left, top: anchor.bottom, visibility: 'hidden' }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <ul className="command-suggest-list" role="listbox" aria-label="명령어 기록 자동완성">
        {items.map((command, index) => (
          <li
            key={command}
            id={optionId(index)}
            role="option"
            aria-selected={index === selected}
            className={`command-suggest-item ${index === selected ? 'selected' : ''}`}
            onClick={() => onPick(index)}
          >
            <Highlighted command={command} typed={typed} />
          </li>
        ))}
      </ul>
      <div className="command-suggest-hint">↑↓ 선택 · Enter 입력 · Esc 닫기</div>
    </div>,
    document.body
  )
}
