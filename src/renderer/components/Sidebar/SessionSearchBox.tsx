import { RiSearchLine, RiCloseLine, RiArrowUpSLine, RiArrowDownSLine } from 'react-icons/ri'

interface SessionSearchBoxProps {
  query: string
  onQueryChange: (query: string) => void
  /** How many sessions match; null while nothing is searched */
  matchCount: number | null
  /** Index of the current match (the one Enter connects to) */
  current: number
  onStep: (delta: number) => void
  onConnectCurrent: () => void
}

/**
 * The sidebar's search box. It marks the matching sessions in the tree without hiding the others:
 * the arrows move between matches while the typing stays in the box, Enter connects to the current one.
 */
export function SessionSearchBox({ query, onQueryChange, matchCount, current, onStep, onConnectCurrent }: SessionSearchBoxProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      onStep(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (!event.repeat) onConnectCurrent()
    } else if (event.key === 'Escape' && query) {
      event.preventDefault()
      event.stopPropagation()
      onQueryChange('')
    }
  }

  // The buttons leave the keyboard in the box, so the arrows and Enter keep working
  const keepTyping = (event: React.MouseEvent) => event.preventDefault()

  const hasMatches = matchCount !== null && matchCount > 0
  return (
    <div className={`sidebar-search${query ? ' has-query' : ''}`}>
      <RiSearchLine size={14} className="sidebar-search-icon" aria-hidden="true" />
      <input
        type="text"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="세션 찾기 · 이름, 호스트, 계정, 폴더"
        aria-label="저장된 세션 찾기"
        title="↑↓ 다음 세션 · Enter 연결 · Esc 지우기"
        spellCheck={false}
      />
      {matchCount !== null && (
        <span className={`sidebar-search-count${hasMatches ? '' : ' is-none'}`} aria-live="polite">
          {hasMatches ? `${current + 1}/${matchCount}` : '없음'}
        </span>
      )}
      {hasMatches && matchCount > 1 && (
        <>
          <button type="button" className="sidebar-search-btn" onMouseDown={keepTyping} onClick={() => onStep(-1)} title="이전 세션" aria-label="이전 세션">
            <RiArrowUpSLine size={14} />
          </button>
          <button type="button" className="sidebar-search-btn" onMouseDown={keepTyping} onClick={() => onStep(1)} title="다음 세션" aria-label="다음 세션">
            <RiArrowDownSLine size={14} />
          </button>
        </>
      )}
      {query && (
        <button type="button" className="sidebar-search-btn" onMouseDown={keepTyping} onClick={() => onQueryChange('')} title="검색 지우기" aria-label="검색 지우기">
          <RiCloseLine size={14} />
        </button>
      )}
    </div>
  )
}
