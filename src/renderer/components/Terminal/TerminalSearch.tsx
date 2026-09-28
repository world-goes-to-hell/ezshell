import { useState, useRef, useEffect } from 'react'
import { SearchAddon } from 'xterm-addon-search'
import { motion, AnimatePresence } from 'framer-motion'
import { RiSearchLine, RiCloseLine, RiArrowUpLine, RiArrowDownLine } from 'react-icons/ri'
import './TerminalSearch.css'

interface TerminalSearchProps {
  searchAddon: SearchAddon | null
  isOpen: boolean
  onClose: () => void
}

export function TerminalSearch({ searchAddon, isOpen, onClose }: TerminalSearchProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  const handleSearch = (direction: 'next' | 'prev') => {
    if (!searchAddon || !query) return
    if (direction === 'next') {
      searchAddon.findNext(query)
    } else {
      searchAddon.findPrevious(query)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch(e.shiftKey ? 'prev' : 'next')
    } else if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'F3') {
      e.preventDefault()
      handleSearch(e.shiftKey ? 'prev' : 'next')
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="terminal-search"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
        >
          <RiSearchLine className="search-icon" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="검색..."
            className="search-input"
          />
          <button onClick={() => handleSearch('prev')} title="이전 (Shift+F3)">
            <RiArrowUpLine />
          </button>
          <button onClick={() => handleSearch('next')} title="다음 (F3)">
            <RiArrowDownLine />
          </button>
          <button onClick={onClose} title="닫기 (Esc)">
            <RiCloseLine />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
