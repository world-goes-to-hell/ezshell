import { RiStarFill } from 'react-icons/ri'

interface PathBookmarkSuggestionsProps {
  id: string
  items: string[]
  highlightedIndex: number
  currentPath: string
  onSelect: (path: string) => void
  onHighlight: (index: number) => void
}

/** Bookmark list shown under the path input while it is being edited. */
export function PathBookmarkSuggestions({ id, items, highlightedIndex, currentPath, onSelect, onHighlight }: PathBookmarkSuggestionsProps) {
  return (
    <ul id={id} className="path-suggestions" role="listbox" aria-label="즐겨찾기 경로">
      <li className="path-suggestions-header" role="presentation">
        <RiStarFill size={14} />
        즐겨찾기
      </li>
      {items.map((path, index) => (
        <li
          key={path}
          id={`${id}-option-${index}`}
          role="option"
          aria-selected={index === highlightedIndex}
          className={`path-suggestion ${index === highlightedIndex ? 'is-highlighted' : ''} ${path === currentPath ? 'is-current' : ''}`}
          title={path}
          // Keep focus in the input so its blur handler does not close the list before the click lands
          onMouseDown={e => e.preventDefault()}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onSelect(path)}
        >
          {path}
        </li>
      ))}
    </ul>
  )
}
