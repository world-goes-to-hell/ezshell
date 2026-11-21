import { useEffect, useId, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import { RiCloseFill, RiSearchLine, RiServerLine, RiFolderOpenLine } from 'react-icons/ri'
import { modalOverlayVariants, modalContentVariants } from '../../lib/animation/variants'
import { buildPickerItems, buildPickerTree, filterPickerItems, moveSelection, type SessionPickerFolder, type SessionPickerItem } from '../../lib/sessionPicker'
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
  const listId = useId()

  const openSessionIds = useMemo(() => new Set(
    Array.from(terminals.values())
      .map(t => t.connectConfig?.savedSessionId)
      .filter((id): id is string => Boolean(id))
  ), [terminals])

  const items = useMemo(() => buildPickerItems(sessions, folders, openSessionIds), [sessions, folders, openSessionIds])
  const tree = useMemo(() => buildPickerTree(filterPickerItems(items, query), folders), [items, folders, query])
  const indexes = useMemo(() => new Map(tree.ordered.map((item, index) => [item.session.id, index])), [tree])
  const activeIndex = Math.min(selectedIndex, Math.max(0, tree.ordered.length - 1))
  const selected = tree.ordered[activeIndex]?.session

  // Start fresh every time the picker opens
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
    }
  }, [open])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, selected?.id])

  const choose = (session: Session) => {
    onOpenChange(false)
    onSelect(session)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(moveSelection(activeIndex, e.key === 'ArrowDown' ? 1 : -1, tree.ordered.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (selected) choose(selected)
    }
  }

  const renderSession = ({ session, isOpen }: SessionPickerItem) => {
    const index = indexes.get(session.id)
    const active = index === activeIndex
    return (
      <li
        key={session.id}
        id={`${listId}-option-${index}`}
        data-index={index}
        data-session-id={session.id}
        role="option"
        aria-selected={active}
        className={`session-picker-item${active ? ' is-selected' : ''}`}
        onMouseEnter={() => setSelectedIndex(index ?? 0)}
        onClick={() => choose(session)}
      >
        <span className="session-picker-dot" style={session.backgroundColor ? { background: session.backgroundColor } : undefined} />
        <div className="session-picker-text">
          <div className="session-picker-name">
            <span>{session.name || `${session.username}@${session.host}`}</span>
            {isOpen && <span className="session-picker-badge">열림</span>}
          </div>
          <span className="session-picker-meta">{session.username}@{session.host}:{session.port || 22}</span>
        </div>
      </li>
    )
  }

  const renderFolder = ({ folder, folders, items }: SessionPickerFolder) => {
    const labelId = `${listId}-folder-${folder.id}`
    return (
      <li key={folder.id} className="session-picker-folder" role="group" aria-labelledby={labelId}>
        <div id={labelId} className="session-picker-folder-heading" title={folder.name}>
          <RiFolderOpenLine size={15} aria-hidden="true" />
          <span>{folder.name}</span>
        </div>
        <ul className="session-picker-children" role="presentation">
          {folders.map(renderFolder)}
          {items.map(renderSession)}
        </ul>
      </li>
    )
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
                  <RiSearchLine size={16} aria-hidden="true" />
                  <input
                    type="text"
                    role="combobox"
                    aria-label="세션 검색"
                    aria-autocomplete="list"
                    aria-expanded={Boolean(selected)}
                    aria-controls={selected ? listId : undefined}
                    aria-activedescendant={selected ? `${listId}-option-${activeIndex}` : undefined}
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0) }}
                    onKeyDown={handleKeyDown}
                    placeholder="이름, 호스트, 사용자, 폴더로 검색"
                    autoFocus
                  />
                </div>

                {tree.ordered.length === 0 ? (
                  <div className="session-picker-empty">
                    {sessions.length === 0 ? '저장된 세션이 없습니다' : '검색 결과가 없습니다'}
                  </div>
                ) : (
                  <ul className="session-picker-list" ref={listRef} id={listId} role="listbox" aria-label="저장된 세션">
                    {tree.folders.map(renderFolder)}
                    {tree.items.map(renderSession)}
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
