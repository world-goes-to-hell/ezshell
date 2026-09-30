import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { RiCloseFill, RiSearchLine, RiServerLine, RiFolder3Line } from 'react-icons/ri'
import { modalOverlayVariants, modalContentVariants } from '../../lib/animation/variants'
import { buildPickerItems, filterPickerItems, moveSelection } from '../../lib/sessionPicker'
import { useSessionStore, type Session } from '../../stores/sessionStore'
import { useTerminalStore, type TerminalInfo } from '../../stores/terminalStore'
import './SessionPickerModal.css'

interface SessionPickerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (session: Session) => void
}

const NO_TERMINALS: ReadonlyMap<string, TerminalInfo> = new Map()

export function SessionPickerModal({ open, onOpenChange, onSelect }: SessionPickerModalProps) {
  const sessions = useSessionStore(state => state.sessions)
  const folders = useSessionStore(state => state.folders)
  // Only track open tabs while visible; the picker stays mounted and tab state churns constantly
  const terminals = useTerminalStore(state => (open ? state.terminals : NO_TERMINALS))
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  const openSessionIds = useMemo(() => new Set(
    Array.from(terminals.values())
      .map(t => t.connectConfig?.savedSessionId)
      .filter((id): id is string => Boolean(id))
  ), [terminals])

  const items = useMemo(
    () => filterPickerItems(buildPickerItems(sessions, folders, openSessionIds), query),
    [sessions, folders, openSessionIds, query]
  )

  // Start fresh every time the picker opens
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
    }
  }, [open])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const choose = (session: Session) => {
    onOpenChange(false)
    onSelect(session)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => moveSelection(i, e.key === 'ArrowDown' ? 1 : -1, items.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[selectedIndex]
      if (item) choose(item.session)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div className="modal-overlay" variants={modalOverlayVariants} initial="hidden" animate="visible" exit="exit" />
            </Dialog.Overlay>
            <Dialog.Content asChild aria-describedby={undefined}>
              <motion.div className="modal-content session-picker-modal" variants={modalContentVariants} initial="hidden" animate="visible" exit="exit">
                <Dialog.Title className="modal-title">
                  <RiServerLine size={20} />
                  기존 세션 선택
                </Dialog.Title>

                <div className="session-picker-search">
                  <RiSearchLine size={16} />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
                    onKeyDown={handleKeyDown}
                    placeholder="이름, 호스트, 사용자, 폴더로 검색"
                    autoFocus
                  />
                </div>

                {items.length === 0 ? (
                  <div className="session-picker-empty">
                    {sessions.length === 0 ? '저장된 세션이 없습니다' : '검색 결과가 없습니다'}
                  </div>
                ) : (
                  <ul className="session-picker-list" ref={listRef} role="listbox">
                    {items.map(({ session, folderPath, isOpen }, index) => (
                      <li
                        key={session.id}
                        data-index={index}
                        role="option"
                        aria-selected={index === selectedIndex}
                        className={`session-picker-item ${index === selectedIndex ? 'is-selected' : ''}`}
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => choose(session)}
                      >
                        <span className="session-picker-dot" style={session.backgroundColor ? { background: session.backgroundColor } : undefined} />
                        <div className="session-picker-text">
                          <div className="session-picker-name">
                            <span>{session.name || `${session.username}@${session.host}`}</span>
                            {isOpen && <span className="session-picker-badge">열림</span>}
                          </div>
                          <div className="session-picker-meta">
                            <span>{session.username}@{session.host}:{session.port || 22}</span>
                            {folderPath && (
                              <span className="session-picker-folder">
                                <RiFolder3Line size={12} />
                                {folderPath}
                              </span>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="session-picker-hint">↑↓ 이동 · Enter 연결 · Esc 닫기</div>

                <Dialog.Close asChild>
                  <button className="modal-close-btn" aria-label="닫기">
                    <RiCloseFill size={20} />
                  </button>
                </Dialog.Close>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
