import { useRef, useState, type RefObject } from 'react'
import { RiArrowRightSLine, RiCloseLine, RiDownload2Line, RiFolder3Line } from 'react-icons/ri'
import { useBrowserBookmarkStore } from '../../stores/browserBookmarkStore'
import { confirmDialog } from '../../stores/confirmStore'
import type { BrowserBookmarkEntry, BrowserBookmarkFolder, BrowserVisit } from '../../types'

const PAGE_SIZE = 50
const formatVisit = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

interface SavedRow {
  entry: BrowserBookmarkEntry | BrowserVisit
  folders: BrowserBookmarkFolder[]
}

function visibleBookmarks(entries: BrowserBookmarkEntry[], folders: BrowserBookmarkFolder[], search: string): SavedRow[] {
  if (!search) return entries.map(entry => ({ entry, folders }))
  return entries.flatMap(entry => {
    const name = entry.kind === 'folder' ? entry.title : `${entry.title} ${entry.url}`
    const matches = name.toLowerCase().includes(search) ? [{ entry, folders }] : []
    if (entry.kind === 'folder') matches.push(...visibleBookmarks(entry.children, [...folders, entry], search))
    return matches
  })
}

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
  const [folderIds, setFolderIds] = useState<string[]>([])
  const listSwitcher = useRef<HTMLButtonElement>(null)
  const search = query.trim().toLowerCase()
  let branch = bookmarks
  const folders: BrowserBookmarkFolder[] = []
  for (const id of folderIds) {
    const folder = branch.find(entry => entry.kind === 'folder' && entry.id === id)
    if (folder?.kind !== 'folder') break
    folders.push(folder)
    branch = folder.children
  }
  const rows: SavedRow[] = showHistory
    ? history.filter(page => !search || `${page.title} ${page.url}`.toLowerCase().includes(search)).map(entry => ({ entry, folders: [] }))
    : visibleBookmarks(branch, folders, search)

  function show(history: boolean) {
    setShowHistory(history)
    setQuery('')
    setLimit(PAGE_SIZE)
  }

  function openFolder(trail: BrowserBookmarkFolder[]) {
    setFolderIds(trail.map(folder => folder.id))
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
        {!!(showHistory ? history.length : branch.length) && <input className="browser-login-search" type="search" aria-label="저장한 페이지 검색" placeholder="검색"
          value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE) }} />}
        {showHistory && !!history.length && <button type="button" onClick={() => void removeHistory()}>기록 지우기</button>}
        <button ref={importTrigger} type="button" aria-haspopup="dialog" onClick={onImport}>
          <RiDownload2Line aria-hidden="true" />가져오기
        </button>
      </div>
      {!showHistory && !!folders.length && <nav className="browser-bookmark-path" aria-label="즐겨찾기 폴더">
        <button type="button" onClick={() => openFolder([])}>즐겨찾기 전체</button>
        {folders.map((folder, index) => (
          <span key={index}>
            <RiArrowRightSLine aria-hidden="true" />
            <button type="button" title={folder.title} aria-current={index === folders.length - 1 ? 'location' : undefined}
              onClick={() => openFolder(folders.slice(0, index + 1))}>{folder.title}</button>
          </span>
        ))}
      </nav>}
      {rows.length ? <>
        <ul>
          {rows.slice(0, limit).map(({ entry, folders: trail }) => {
            const path = search && trail.map(folder => folder.title).join(' › ')
            const key = trail.map(folder => folder.id)
            if ('kind' in entry && entry.kind === 'folder') {
              return <li key={JSON.stringify([...key, entry.id])}>
                <button type="button" className="browser-review-bookmark-open browser-bookmark-folder" title={entry.title}
                  onClick={() => openFolder([...trail, entry])}>
                  <RiFolder3Line aria-hidden="true" />
                  <span><span>{entry.title}</span><small>{path || `${entry.children.length.toLocaleString()}개 항목`}</small></span>
                  <RiArrowRightSLine aria-hidden="true" />
                </button>
              </li>
            }
            return <li key={JSON.stringify([...key, entry.url, entry.title])}>
              <button type="button" className="browser-review-bookmark-open" title={entry.url} onClick={() => onNavigate(entry.url)}>
                <span>{entry.title}</span>
                <small>{entry.url}</small>
                {path && <small title={path}>{path}</small>}
                {'visitedAt' in entry && <time dateTime={new Date(entry.visitedAt).toISOString()}>{formatVisit.format(entry.visitedAt)}</time>}
              </button>
              {!showHistory && <button type="button" className="browser-review-bookmark-remove" title="즐겨찾기에서 제거"
                aria-label={`${entry.title} 즐겨찾기에서 제거`} onClick={() => {
                  removeBookmark(entry)
                  importTrigger.current?.focus({ preventScroll: true })
                }}><RiCloseLine aria-hidden="true" /></button>}
            </li>
          })}
        </ul>
        {rows.length > limit && <button type="button" onClick={() => setLimit(limit + PAGE_SIZE)}>더 보기</button>}
      </> : <p>{search ? '일치하는 항목이 없습니다.' : showHistory ? '가져온 방문 기록이 없습니다.' : folders.length ? '이 폴더는 비어 있습니다.' : '저장된 즐겨찾기가 없습니다.'}</p>}
    </section>
  )
}
