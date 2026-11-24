import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiCheckboxMultipleLine, RiCloseLine, RiDeleteBinLine, RiDownload2Line, RiFolder3Line, RiFolderOpenLine } from 'react-icons/ri'
import { bookmarkNodes, bookmarkTree, searchBookmarkTree, visibleBookmarkNodes, type BookmarkNode } from '../../lib/browserBookmarkTree'
import { useBrowserBookmarkStore } from '../../stores/browserBookmarkStore'
import { confirmDialog } from '../../stores/confirmStore'
import type { BrowserBookmarkEntry, BrowserBookmarkPage, BrowserVisit } from '../../types'

const PAGE_SIZE = 50
const formatVisit = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function BookmarkCheckbox({ checked, mixed = false, disabled, label, onChange }: {
  checked: boolean; mixed?: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void
}) {
  const checkbox = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => { if (checkbox.current) checkbox.current.indeterminate = mixed }, [mixed])
  return <input type="checkbox" ref={checkbox} checked={checked} disabled={disabled} aria-label={label} onChange={event => onChange(event.target.checked)} />
}

function PageLink({ page, onClick }: { page: BrowserBookmarkPage | BrowserVisit; onClick: () => void }) {
  return (
    <button type="button" className="browser-review-bookmark-open" title={page.url} onClick={onClick}>
      <span>{page.title}</span>
      <small>{page.url}</small>
      {'visitedAt' in page && <time dateTime={new Date(page.visitedAt).toISOString()}>{formatVisit.format(page.visitedAt)}</time>}
    </button>
  )
}

export function BrowserSavedPages({ id, importTrigger, expandedFolders, onExpandedFoldersChange, onImport, onClose, onNavigate }: {
  id: string
  importTrigger: RefObject<HTMLButtonElement | null>
  expandedFolders: ReadonlySet<string>
  onExpandedFoldersChange: (folders: ReadonlySet<string>) => void
  onImport: () => void
  onClose: () => void
  onNavigate: (url: string) => void
}) {
  const bookmarks = useBrowserBookmarkStore(store => store.bookmarks)
  const history = useBrowserBookmarkStore(store => store.history)
  const removeBookmark = useBrowserBookmarkStore(store => store.removeBookmark)
  const removeBookmarks = useBrowserBookmarkStore(store => store.removeBookmarks)
  const clearHistory = useBrowserBookmarkStore(store => store.clearHistory)
  const [showHistory, setShowHistory] = useState(false)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [query, setQuery] = useState('')
  const [closedSearchFolders, setClosedSearchFolders] = useState<ReadonlySet<string>>(() => new Set())
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<BrowserBookmarkEntry>>(() => new Set())
  const bookmarksTab = useRef<HTMLButtonElement>(null)
  const historyTab = useRef<HTMLButtonElement>(null)
  const selectButton = useRef<HTMLButtonElement>(null)
  const search = query.trim().toLowerCase()
  const tree = useMemo(() => bookmarkTree(bookmarks), [bookmarks])
  const filtered = useMemo(() => searchBookmarkTree(tree, search), [tree, search])
  const isOpen = (key: string) => search ? !closedSearchFolders.has(key) : expandedFolders.has(key)
  const rows: BookmarkNode[] = []
  if (!showHistory) {
    for (const node of visibleBookmarkNodes(filtered, isOpen)) {
      rows.push(node)
      if (rows.length > limit) break
    }
  }
  const visits = showHistory ? history.filter(page => !search || `${page.title} ${page.url}`.toLowerCase().includes(search)) : []
  const scope = useMemo(() => selecting ? [...bookmarkNodes(filtered)].filter(node => !node.contextOnly) : [], [filtered, selecting])
  const { chosen, partial } = useMemo(() => {
    const chosen = new Set<BrowserBookmarkEntry>()
    const partial = new Set<BrowserBookmarkEntry>()
    if (!selected.size) return { chosen, partial }
    for (const { entry, parents } of bookmarkNodes(tree)) {
      if (!selected.has(entry)) continue
      chosen.add(entry)
      for (const parent of parents) partial.add(parent)
    }
    return { chosen, partial }
  }, [tree, selected])
  const allSelected = scope.length > 0 && scope.every(node => chosen.has(node.entry))

  function searchFor(value: string) {
    setQuery(value)
    setLimit(PAGE_SIZE)
    setSelected(new Set())
    setClosedSearchFolders(new Set())
  }

  function finishSelection() {
    setSelecting(false)
    setSelected(new Set())
  }

  function show(history: boolean) {
    if (history === showHistory) return
    setShowHistory(history)
    searchFor('')
    finishSelection()
  }

  function toggleFolder(node: BookmarkNode, index: number) {
    const wasOpen = isOpen(node.key)
    const keys = new Set(search ? closedSearchFolders : expandedFolders)
    if (keys.has(node.key)) keys.delete(node.key)
    else keys.add(node.key)
    if (search) setClosedSearchFolders(keys)
    else onExpandedFoldersChange(keys)
    if (!wasOpen) setLimit(current => Math.max(current, index + 1 + Math.min(node.children.length, PAGE_SIZE)))
  }

  function toggleNode(node: BookmarkNode, checked: boolean) {
    setSelected(previous => {
      const next = new Set(previous)
      for (const { entry } of bookmarkNodes([node])) {
        if (checked) next.add(entry)
        else next.delete(entry)
      }
      // An unchecked descendant keeps its containing folders in the list.
      if (!checked) for (const parent of node.parents) next.delete(parent)
      return next
    })
  }

  async function deleteSelection() {
    if (!chosen.size) return
    const folderCount = [...chosen].filter(entry => entry.kind === 'folder').length
    const pageCount = chosen.size - folderCount
    const count = [pageCount > 0 && `즐겨찾기 ${pageCount.toLocaleString()}개`, folderCount > 0 && `폴더 ${folderCount.toLocaleString()}개`].filter(Boolean).join(' 및 ')
    const confirmed = await confirmDialog({ title: '선택한 즐겨찾기 삭제', message: `ezShell에서 ${count}를 삭제할까요?`, confirmLabel: '삭제', danger: true })
    if (!confirmed) return
    removeBookmarks(chosen)
    finishSelection()
    bookmarksTab.current?.focus({ preventScroll: true })
  }

  async function removeHistory() {
    if (await confirmDialog({ title: '가져온 방문 기록 삭제', message: 'ezShell에 가져온 방문 기록을 모두 지울까요?', confirmLabel: '삭제', danger: true })) {
      clearHistory()
      historyTab.current?.focus({ preventScroll: true })
    }
  }

  return (
    <section className="browser-review-bookmarks" id={id} aria-label="즐겨찾기와 방문 기록" onKeyDown={event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (selecting) {
        finishSelection()
        selectButton.current?.focus({ preventScroll: true })
      } else onClose()
    }}>
      <div className="browser-saved-pages-tools">
        <div role="group" aria-label="저장한 페이지 보기">
          <button ref={bookmarksTab} type="button" aria-pressed={!showHistory} onClick={() => show(false)}>즐겨찾기</button>
          <button ref={historyTab} type="button" aria-pressed={showHistory} onClick={() => show(true)}>방문 기록</button>
        </div>
        {!!(showHistory ? history.length : bookmarks.length) && <input className="browser-login-search" type="search" aria-label="저장한 페이지 검색" placeholder="검색"
          value={query} onChange={event => searchFor(event.target.value)} />}
        {!showHistory && !!bookmarks.length && <button ref={selectButton} type="button" aria-pressed={selecting} onClick={() => selecting ? finishSelection() : setSelecting(true)}>
          <RiCheckboxMultipleLine aria-hidden="true" />{selecting ? '선택 취소' : '선택'}
        </button>}
        {showHistory && !!history.length && <button type="button" onClick={() => void removeHistory()}>기록 지우기</button>}
        <button ref={importTrigger} type="button" aria-haspopup="dialog" onClick={() => { finishSelection(); onImport() }}>
          <RiDownload2Line aria-hidden="true" />가져오기
        </button>
        {selecting && <div className="browser-bookmark-actions" role="group" aria-label="즐겨찾기 일괄 선택">
          <label>
            <BookmarkCheckbox checked={allSelected} mixed={!allSelected && !!chosen.size} disabled={!scope.length} label={search ? '검색 결과 전체 선택' : '전체 선택'}
              onChange={checked => setSelected(checked ? new Set(scope.map(node => node.entry)) : new Set())} />
            {search ? '검색 결과 전체 선택' : '전체 선택'}
          </label>
          <button type="button" className="browser-bookmark-delete" disabled={!chosen.size} onClick={() => void deleteSelection()}>
            <RiDeleteBinLine aria-hidden="true" />선택 삭제{chosen.size ? ` (${chosen.size.toLocaleString()})` : ''}
          </button>
        </div>}
      </div>
      {showHistory && !!visits.length && <ul className="browser-visit-list">
        {visits.slice(0, limit).map(page => <li key={page.url}><PageLink page={page} onClick={() => onNavigate(page.url)} /></li>)}
      </ul>}
      {!showHistory && !!rows.length && <ul className="browser-bookmark-tree" aria-label="즐겨찾기 목록">
        {rows.slice(0, limit).map((node, index) => {
          const { entry } = node
          const folder = entry.kind === 'folder'
          const checked = chosen.has(entry)
          const open = folder && isOpen(node.key)
          const Chevron = open ? RiArrowDownSLine : RiArrowRightSLine
          const FolderIcon = open ? RiFolderOpenLine : RiFolder3Line
          const indent = { '--bookmark-depth': Math.min(node.parents.length, 12) } as CSSProperties
          return <li key={node.key} className="browser-bookmark-row" data-kind={folder ? 'folder' : 'page'} data-selected={checked || undefined} style={indent}>
            {selecting && <span className="browser-bookmark-choice">
              {!node.contextOnly && <BookmarkCheckbox checked={checked} mixed={folder && !checked && partial.has(entry)}
                label={folder ? `${entry.title} 폴더 선택` : `${entry.title} 선택`} onChange={checked => toggleNode(node, checked)} />}
            </span>}
            {entry.kind === 'folder' ?
              <button type="button" className="browser-review-bookmark-open browser-bookmark-folder" title={entry.title} aria-expanded={open}
                onClick={() => toggleFolder(node, index)}>
                <Chevron aria-hidden="true" /><FolderIcon aria-hidden="true" /><span>{entry.title}</span>
                <small>{open && !entry.children.length ? '빈 폴더' : `${entry.children.length.toLocaleString()}개`}</small>
              </button>
              : <>
              <PageLink page={entry} onClick={() => selecting ? toggleNode(node, !checked) : onNavigate(entry.url)} />
              {!selecting && <button type="button" className="browser-review-bookmark-remove" title="즐겨찾기에서 제거"
                aria-label={`${entry.title} 즐겨찾기에서 제거`} onClick={() => {
                  removeBookmark(entry)
                  importTrigger.current?.focus({ preventScroll: true })
                }}><RiCloseLine aria-hidden="true" /></button>}
            </>}
          </li>
        })}
      </ul>}
      {(showHistory ? visits.length : rows.length) > limit && <button type="button" onClick={() => setLimit(limit + PAGE_SIZE)}>더 보기</button>}
      {!(showHistory ? visits.length : rows.length) && <p>{search ? '일치하는 항목이 없습니다.' : showHistory ? '가져온 방문 기록이 없습니다.' : '저장된 즐겨찾기가 없습니다.'}</p>}
    </section>
  )
}
