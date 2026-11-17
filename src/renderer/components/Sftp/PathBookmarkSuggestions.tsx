import { useLayoutEffect, useRef, useState } from 'react'
import type { IconType } from 'react-icons'
import {
  RiStarFill, RiComputerLine, RiHome4Line, RiFileTextLine, RiDownload2Line, RiImageLine, RiMusic2Line,
  RiFilmLine, RiHardDrive2Line, RiUsbLine, RiServerLine, RiDiscLine
} from 'react-icons/ri'

/** One row of the list under the path input: a bookmark, a usual folder or a drive */
export interface PathSuggestion {
  path: string
  label: string
  section: 'bookmark' | 'place' | 'drive'
  /** Picks the icon: a LocalPlace or LocalDrive kind */
  kind?: string
}

const SECTION_TITLES: Record<PathSuggestion['section'], string> = { bookmark: '즐겨찾기', place: '바로 가기', drive: '내 PC' }

const ICONS: Record<string, IconType> = {
  desktop: RiComputerLine,
  home: RiHome4Line,
  documents: RiFileTextLine,
  downloads: RiDownload2Line,
  pictures: RiImageLine,
  music: RiMusic2Line,
  videos: RiFilmLine,
  local: RiHardDrive2Line,
  removable: RiUsbLine,
  network: RiServerLine,
  cd: RiDiscLine
}

const EDGE_GAP = 8
const MIN_LIST_HEIGHT = 90

/**
 * Height left for the list before the nearest ancestor that clips its content (the SFTP pane is
 * overflow: hidden). Without this the list keeps its CSS height in a short pane: its lower part is
 * cut off, and scrolling to the end still leaves the last rows out of sight.
 */
function roomBelow(list: HTMLElement): number | null {
  const top = list.getBoundingClientRect().top
  let bottom = window.innerHeight
  for (let node = list.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY !== 'visible') {
      bottom = Math.min(bottom, node.getBoundingClientRect().bottom)
      break
    }
  }
  const room = Math.floor(bottom - top - EDGE_GAP)
  return Number.isFinite(room) ? Math.max(MIN_LIST_HEIGHT, room) : null
}

interface PathBookmarkSuggestionsProps {
  id: string
  items: PathSuggestion[]
  highlightedIndex: number
  currentPath: string
  onSelect: (path: string) => void
  onHighlight: (index: number) => void
}

/** The list shown under the path input while it is being edited: bookmarks, then (local) usual folders and drives */
export function PathBookmarkSuggestions({ id, items, highlightedIndex, currentPath, onSelect, onHighlight }: PathBookmarkSuggestionsProps) {
  const label = items.every(item => item.section === 'bookmark') ? '즐겨찾기 경로' : '이동할 위치'
  const listRef = useRef<HTMLUListElement>(null)
  const [room, setRoom] = useState<number | null>(null)

  // CSS caps the height (max-height); this only lowers it when the pane is shorter than that
  useLayoutEffect(() => {
    const measure = () => { if (listRef.current) setRoom(roomBelow(listRef.current)) }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [items.length])

  // Arrow keys move the highlight; keep the highlighted row in view
  useLayoutEffect(() => {
    if (highlightedIndex < 0) return
    listRef.current?.querySelector('.is-highlighted')?.scrollIntoView({ block: 'nearest' })
  }, [highlightedIndex])

  return (
    <ul
      ref={listRef}
      id={id}
      className="path-suggestions"
      role="listbox"
      aria-label={label}
      // Pressing the list's scrollbar must not take focus from the input: its blur closes the list
      onMouseDown={e => e.preventDefault()}
      style={room === null ? undefined : { maxHeight: `min(360px, 55vh, ${room}px)` }}
    >
      {items.map((item, index) => {
        const Icon = item.section === 'bookmark' ? null : ICONS[item.kind ?? ''] ?? RiHardDrive2Line
        const startsSection = index === 0 || items[index - 1].section !== item.section
        const showsPath = item.label !== item.path
        return [
          startsSection && (
            <li key={`header-${item.section}`} className="path-suggestions-header" role="presentation">
              {item.section === 'bookmark' && <RiStarFill size={14} />}
              {SECTION_TITLES[item.section]}
            </li>
          ),
          <li
            key={`${item.section}:${item.path}`}
            id={`${id}-option-${index}`}
            role="option"
            aria-selected={index === highlightedIndex}
            className={`path-suggestion ${index === highlightedIndex ? 'is-highlighted' : ''} ${item.path === currentPath ? 'is-current' : ''}`}
            title={item.path}
            // Keep focus in the input so its blur handler does not close the list before the click lands
            onMouseDown={e => e.preventDefault()}
            onMouseEnter={() => onHighlight(index)}
            onClick={() => onSelect(item.path)}
          >
            {Icon && <Icon size={15} className="path-suggestion-icon" aria-hidden="true" />}
            <span className="path-suggestion-label">{item.label}</span>
            {showsPath && <span className="path-suggestion-path">{item.path}</span>}
          </li>
        ]
      })}
    </ul>
  )
}
