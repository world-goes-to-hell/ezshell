import { useRef, useState, type RefObject } from 'react'
import { RiCloseLine, RiDownload2Line } from 'react-icons/ri'
import { useBrowserBookmarkStore } from '../../stores/browserBookmarkStore'
import { confirmDialog } from '../../stores/confirmStore'

const PAGE_SIZE = 50
const formatVisit = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function BrowserSavedPages({ id, importTrigger, onImport, onClose, onNavigate }: {
  id: string
  importTrigger: RefObject<HTMLButtonElement | null>
  onImport: () => void
  onClose: () => void
  onNavigate: (url: string) => void
}) {
  const bookmarks = useBrowserBookmarkStore(store => store.bookmarks)
  const history = useBrowserBookmarkStore(store => store.history)
  const removeBookmark = useBrowserBookmarkStore(store => store.removeBookmark)
  const clearHistory = useBrowserBookmarkStore(store => store.clearHistory)
  const [showHistory, setShowHistory] = useState(false)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [query, setQuery] = useState('')
  const listSwitcher = useRef<HTMLButtonElement>(null)
  const allPages = showHistory ? history : bookmarks
  const search = query.trim().toLowerCase()
  const pages = search ? allPages.filter(page => `${page.title} ${page.url}`.toLowerCase().includes(search)) : allPages

  function show(history: boolean) {
    setShowHistory(history)
    setQuery('')
    setLimit(PAGE_SIZE)
  }

  async function removeHistory() {
    if (await confirmDialog({ title: '가져온 방문 기록 삭제', message: 'ezShell에 가져온 방문 기록을 모두 지울까요?', confirmLabel: '삭제', danger: true })) {
      clearHistory()
      listSwitcher.current?.focus({ preventScroll: true })
    }
  }

  return (
    <section className="browser-review-bookmarks" id={id} aria-label="즐겨찾기와 방문 기록" onKeyDown={event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }}>
      <div className="browser-saved-pages-tools">
        <div role="group" aria-label="저장한 페이지 보기">
          <button type="button" aria-pressed={!showHistory} onClick={() => show(false)}>즐겨찾기</button>
          <button ref={listSwitcher} type="button" aria-pressed={showHistory} onClick={() => show(true)}>방문 기록</button>
        </div>
        {!!allPages.length && <input className="browser-login-search" type="search" aria-label="저장한 페이지 검색" placeholder="검색"
          value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE) }} />}
        {showHistory && !!history.length && <button type="button" onClick={() => void removeHistory()}>기록 지우기</button>}
        <button ref={importTrigger} type="button" aria-haspopup="dialog" onClick={onImport}>
          <RiDownload2Line aria-hidden="true" />가져오기
        </button>
      </div>
      {pages.length ? <>
        <ul>
          {pages.slice(0, limit).map(page => (
            <li key={page.url}>
              <button type="button" className="browser-review-bookmark-open" title={page.url} onClick={() => onNavigate(page.url)}>
                <span>{page.title}</span>
                <small>{page.url}</small>
                {'visitedAt' in page && <time dateTime={new Date(Number(page.visitedAt)).toISOString()}>{formatVisit.format(Number(page.visitedAt))}</time>}
              </button>
              {!showHistory && <button type="button" className="browser-review-bookmark-remove" title="즐겨찾기에서 제거"
                aria-label={`${page.title} 즐겨찾기에서 제거`} onClick={() => {
                  removeBookmark(page.url)
                  importTrigger.current?.focus({ preventScroll: true })
                }}><RiCloseLine aria-hidden="true" /></button>}
            </li>
          ))}
        </ul>
        {pages.length > limit && <button type="button" onClick={() => setLimit(limit + PAGE_SIZE)}>더 보기</button>}
      </> : <p>{search ? '일치하는 페이지가 없습니다.' : showHistory ? '가져온 방문 기록이 없습니다.' : '저장된 즐겨찾기가 없습니다.'}</p>}
    </section>
  )
}
