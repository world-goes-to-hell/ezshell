import { useState, useEffect, useMemo, useId, KeyboardEvent } from 'react'
import { RiHardDrive2Fill } from 'react-icons/ri'
import { PathBookmarkButton } from './PathBookmarkButton'
import { PathBookmarkSuggestions } from './PathBookmarkSuggestions'
import { usePathBookmarks } from '../../hooks/usePathBookmarks'

interface PathBarProps {
  path: string
  onNavigate: (path: string) => void
  type: 'local' | 'remote'
  label: string
  /** Runtime SSH session id; enables per-saved-session path bookmarks */
  sessionId?: string
  /** Increment to open the path editor from outside (Ctrl+L in the file list) */
  editRequest?: number
}

const WINDOWS_DRIVES = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:']
const NO_HIGHLIGHT = -1

const isWindows = () => {
  return navigator.platform.toLowerCase().includes('win') ||
         navigator.userAgent.toLowerCase().includes('windows')
}

export function PathBar({ path, onNavigate, type, label, sessionId, editRequest = 0 }: PathBarProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [inputPath, setInputPath] = useState(path)
  const [highlightedIndex, setHighlightedIndex] = useState(NO_HIGHLIGHT)
  const bookmarks = usePathBookmarks(sessionId, type)
  const listId = useId()

  useEffect(() => {
    setInputPath(path)
  }, [path])

  useEffect(() => {
    if (editRequest > 0) setIsEditing(true)
  }, [editRequest])

  // Show every bookmark until the user starts typing, then filter by what was typed
  const suggestions = useMemo(() => {
    const query = inputPath.trim().toLowerCase()
    if (!query || inputPath === path) return bookmarks.bookmarks
    return bookmarks.bookmarks.filter(bookmark => bookmark.toLowerCase().includes(query))
  }, [bookmarks.bookmarks, inputPath, path])

  const showSuggestions = isEditing && suggestions.length > 0

  const finishEditing = () => {
    setIsEditing(false)
    setHighlightedIndex(NO_HIGHLIGHT)
  }

  const navigateTo = (target: string) => {
    onNavigate(target)
    finishEditing()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && showSuggestions) {
      e.preventDefault()
      setHighlightedIndex(i => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp' && showSuggestions) {
      e.preventDefault()
      setHighlightedIndex(i => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const picked = showSuggestions && highlightedIndex >= 0 ? suggestions[highlightedIndex] : undefined
      const trimmedPath = (picked ?? inputPath).trim()
      if (trimmedPath) {
        navigateTo(trimmedPath)
      } else {
        finishEditing()
      }
    } else if (e.key === 'Escape') {
      setInputPath(path)
      finishEditing()
    }
  }

  const handleBlur = () => {
    setInputPath(path)
    finishEditing()
  }

  const handleDriveChange = (drive: string) => {
    onNavigate(`${drive}\\`)
  }

  const currentDrive = isWindows() && type === 'local'
    ? path.substring(0, 2).toUpperCase()
    : null

  return (
    <div className="path-bar">
      <span className="path-label">{label}</span>

      {/* Drive selector for Windows local */}
      {type === 'local' && isWindows() && (
        <div className="drive-selector">
          <RiHardDrive2Fill size={16} />
          <select
            value={currentDrive || 'C:'}
            onChange={(e) => handleDriveChange(e.target.value)}
            className="drive-select"
          >
            {WINDOWS_DRIVES.map(drive => (
              <option key={drive} value={drive}>{drive}</option>
            ))}
          </select>
        </div>
      )}

      {/* Editable path; bookmarks drop down under it while editing */}
      <div className="path-field">
        {isEditing ? (
          <input
            type="text"
            className="path-input"
            value={inputPath}
            onChange={(e) => {
              setInputPath(e.target.value)
              setHighlightedIndex(NO_HIGHLIGHT)
            }}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            onFocus={(e) => e.target.select()}
            role="combobox"
            aria-expanded={showSuggestions}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showSuggestions && highlightedIndex >= 0 ? `${listId}-option-${highlightedIndex}` : undefined}
            autoFocus
          />
        ) : (
          <span
            className="path-display"
            onClick={() => setIsEditing(true)}
            title="클릭하여 경로 편집"
          >
            {path}
          </span>
        )}

        {showSuggestions && (
          <PathBookmarkSuggestions
            id={listId}
            items={suggestions}
            highlightedIndex={highlightedIndex}
            currentPath={path}
            onSelect={navigateTo}
            onHighlight={setHighlightedIndex}
          />
        )}
      </div>

      {sessionId && (
        <PathBookmarkButton bookmarks={bookmarks} currentPath={path} onNavigate={onNavigate} />
      )}
    </div>
  )
}
