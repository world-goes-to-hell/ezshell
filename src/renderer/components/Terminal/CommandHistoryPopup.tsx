import { useEffect, useRef, useState, useId } from 'react'
import { createPortal } from 'react-dom'
import { RiHistoryLine } from 'react-icons/ri'
import { useCommandHistory, useFilteredHistory, formatHistoryTime } from '../../hooks/useCommandHistory'
import { CommandHistoryEmpty } from './CommandHistoryEmpty'

interface CommandHistoryPopupProps {
  sessionId: string
  /** Bounds of the terminal the popup belongs to; it opens near that terminal's top */
  anchor: DOMRect
  onInsert: (command: string) => void
  onClose: () => void
}

const MAX_VISIBLE_RESULTS = 100
const POPUP_MARGIN = 16
const POPUP_MAX_WIDTH = 640

export function CommandHistoryPopup({ sessionId, anchor, onInsert, onClose }: CommandHistoryPopupProps) {
  const { isAvailable, entries } = useCommandHistory(sessionId)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const results = useFilteredHistory(entries, query).slice(0, MAX_VISIBLE_RESULTS)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()

  useEffect(() => setHighlighted(0), [query])

  useEffect(() => {
    listRef.current?.children[highlighted]?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const picked = results[highlighted]
      if (picked) onInsert(picked.command)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const width = Math.min(POPUP_MAX_WIDTH, Math.max(anchor.width - POPUP_MARGIN * 2, 280))
  const style = { top: anchor.top + POPUP_MARGIN, left: anchor.left + anchor.width / 2 - width / 2, width }

  return createPortal(
    <>
      <div className="history-popup-backdrop" onMouseDown={onClose} />
      <div className="history-popup" style={style} role="dialog" aria-label="명령어 기록 검색">
        <div className="history-popup-search">
          <RiHistoryLine size={16} aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="명령어 기록 검색"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={results[highlighted] ? `${listId}-${highlighted}` : undefined}
          />
          <kbd className="history-popup-hint">Enter 입력 · Esc 닫기</kbd>
        </div>
        {results.length > 0 ? (
          <ul className="history-popup-list" id={listId} ref={listRef} role="listbox">
            {results.map((entry, index) => (
              <li
                key={entry.command}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlighted}
                className={`history-popup-item ${index === highlighted ? 'highlighted' : ''}`}
                onMouseEnter={() => setHighlighted(index)}
                onMouseDown={e => { e.preventDefault(); onInsert(entry.command) }}
              >
                <span className="history-command">{entry.command}</span>
                <span className="history-time">{formatHistoryTime(entry.lastUsedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <CommandHistoryEmpty isAvailable={isAvailable} totalCount={entries.length} />
        )}
      </div>
    </>,
    document.body
  )
}
