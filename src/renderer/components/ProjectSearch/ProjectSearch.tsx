// 프로젝트 검색 (docs/plan/2026-11-26-project-search.md): Shift twice finds a file by name, Ctrl+Shift+F finds
// text in the files, both in the project of the local tab in front (its repository or worktree, else the
// shell's folder). Enter opens the file in the file window, a content result at its line. The text stays for the
// next opening, and the searches whose result was opened are listed in the empty box and complete what is typed.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { RiCloseLine, RiFileLine, RiFileSearchLine, RiFolder3Line, RiHistoryLine, RiSearchLine } from 'react-icons/ri'
import { useProjectSearchStore, type ProjectSearchMode } from '../../stores/projectSearchStore'
import { useShortcutsStore } from '../../stores/shortcutsStore'
import { useWorkspaceDirectory } from '../../hooks/useWorkspaceDirectory'
import { matchesBinding } from '../../lib/shortcutMatch'
import { contentRows, createDoubleShift, highlightParts, splitPath } from '../../lib/projectSearch'
import { completeSearch } from '../../lib/projectSearchHistory'
import { findQueryFromSelection } from '../../lib/terminalText'
import { openWorkspaceFile } from '../Workspace/WorkspaceDetails'
import type { WorkspaceContentSearchResult, WorkspaceDirectorySearchResult } from '../../types'
import './ProjectSearch.css'

const FILE_DELAY_MS = 120
const CONTENT_DELAY_MS = 300
const CONTENT_MIN = 2

/** The text selected on the page (a chat, a file list), one line, as the query to start from */
const selectedText = () => findQueryFromSelection(window.getSelection()?.toString() ?? '', 200)

/**
 * Listens for the two keys everywhere in the window, also in a terminal or a text box: on the window, before
 * the element (capture), so xterm does not send them to the shell. Mounted while the app is unlocked.
 */
export function ProjectSearchKeys() {
  useEffect(() => {
    const doubleShift = createDoubleShift()
    const onKey = (event: KeyboardEvent) => {
      if (doubleShift(event)) {
        useProjectSearchStore.getState().show('file', selectedText())
        return
      }
      if (event.type !== 'keydown' || event.repeat) return
      if (!matchesBinding(event, useShortcutsStore.getState().getEffectiveKeys('project-content-search'))) return
      event.preventDefault()
      event.stopPropagation()
      useProjectSearchStore.getState().show('content', selectedText())
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
    }
  }, [])
  return null
}

type FileHit = { path: string }

export function ProjectSearch() {
  const open = useProjectSearchStore(state => state.open)
  const close = useProjectSearchStore(state => state.close)
  const keep = useProjectSearchStore(state => state.keep)
  const record = useProjectSearchStore(state => state.record)
  const forget = useProjectSearchStore(state => state.forget)
  // Mounted all along: it follows which local pane has the focus, as the workspace panel does
  const { folder, isLoading } = useWorkspaceDirectory(Boolean(open))
  const [root, setRoot] = useState<string | null>(null)
  const [mode, setMode] = useState<ProjectSearchMode>('file')
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [includeAll, setIncludeAll] = useState(false)
  const [files, setFiles] = useState<FileHit[]>([])
  const [content, setContent] = useState<WorkspaceContentSearchResult | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  // The completed part of the text, selected so typing on replaces it (as the browser tab's address bar)
  const pendingSelection = useRef<[number, number] | null>(null)
  // Each completion renders again: the next letter of the same completion leaves the text as it was
  const [completions, setCompletions] = useState(0)
  const history = useProjectSearchStore(state => state.history[mode])
  // Where the keys were (a terminal, a chat): focused again when the search closes
  const returnFocus = useRef<HTMLElement | null>(null)

  // Each opening: its mode and starting text, the text selected for a new search
  useEffect(() => {
    if (!open) {
      const back = returnFocus.current
      returnFocus.current = null
      if (back?.isConnected) back.focus()
      return
    }
    if (!returnFocus.current && document.activeElement instanceof HTMLElement && !document.activeElement.closest('.project-search')) {
      returnFocus.current = document.activeElement
    }
    setMode(open.mode)
    setQuery(open.query)
    setSelected(0)
    window.setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 0)
  }, [open])

  useEffect(() => { if (open) keep(query) }, [open, query, keep])

  useLayoutEffect(() => {
    const range = pendingSelection.current
    pendingSelection.current = null
    if (range && inputRef.current === document.activeElement) inputRef.current?.setSelectionRange(range[0], range[1])
  }, [query, completions])

  // The project: the repository (or worktree) holding the shell's folder, else that folder
  useEffect(() => {
    if (!open || !folder) { setRoot(null); return }
    let current = true
    setRoot(folder)
    void window.electronAPI.localProjectInspect?.(folder).then(result => {
      if (current && result.success && result.repo) setRoot(result.repo.root)
    }).catch(() => undefined)
    return () => { current = false }
  }, [open, folder])

  // The name search keeps its list current from the first search on: start it as soon as the project is known
  useEffect(() => {
    if (open && root) void window.electronAPI.workspaceDirectoryPrepare?.(root, false, includeAll).catch(() => undefined)
  }, [open, root, includeAll])

  useEffect(() => {
    if (!open || !root) return
    const text = query
    const ready = mode === 'file' ? text.trim().length > 0 : text.trim().length >= CONTENT_MIN
    const id = ++request.current
    if (!ready) {
      setFiles([]); setContent(null); setTruncated(false); setSearching(false); setError(null)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(async () => {
      try {
        if (mode === 'file') {
          const result = await window.electronAPI.workspaceDirectorySearch?.(root, text.trim(), includeAll)
          if (id !== request.current) return
          if (!result?.success) { setError(result?.error ?? '파일을 찾지 못했습니다.'); setFiles([]); return }
          const found = (result as WorkspaceDirectorySearchResult).entries.filter(entry => entry.kind === 'file')
          setFiles(found.map(entry => ({ path: entry.path })))
          setTruncated(result.truncated)
        } else {
          const result = await window.electronAPI.workspaceContentSearch?.(root, text, caseSensitive)
          if (id !== request.current) return
          if (!result?.success) { setError(result?.error ?? '내용을 검색하지 못했습니다.'); setContent(null); return }
          setContent(result)
          setTruncated(result.truncated)
        }
        setError(null)
        setSelected(0)
      } catch {
        if (id === request.current) setError('검색하지 못했습니다.')
      } finally {
        if (id === request.current) setSearching(false)
      }
    }, mode === 'file' ? FILE_DELAY_MS : CONTENT_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [open, root, mode, query, caseSensitive, includeAll])

  const rows = useMemo(() => (content ? contentRows(content.files) : []), [content])
  const lineRows = useMemo(() => rows.filter(row => row.kind === 'line'), [rows])
  // The empty box lists the searches of this mode whose result was opened
  const recent = query.trim() || !folder ? [] : history
  const count = recent.length ? recent.length : mode === 'file' ? files.length : lineRows.length

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected, mode])

  if (!open) return null

  const complete = (value: string) => {
    const full = completeSearch(value, history)
    if (!full) return
    pendingSelection.current = [value.length, full.length]
    setCompletions(current => current + 1)
    setQuery(full)
  }

  const change = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    const native = event.nativeEvent as InputEvent
    setQuery(value)
    setSelected(0)
    // Only typing on at the end: deleting must not bring the completion back, and an IME completes once its
    // composition ends
    if (event.target.selectionStart === value.length && native.inputType?.startsWith('insert') && !native.isComposing) complete(value)
  }

  const chooseRecent = (index: number) => {
    const text = recent[index]
    if (text === undefined) return
    setQuery(text)
    setSelected(0)
    inputRef.current?.focus()
  }

  const pick = (index: number) => {
    if (!root) return
    if (recent.length) { chooseRecent(index); return }
    const text = mode === 'file' ? query.trim() : query
    if (mode === 'file') {
      const hit = files[index]
      if (!hit) return
      record(mode, text)
      close()
      void openWorkspaceFile(root, hit.path, splitPath(hit.path).name)
    } else {
      const row = lineRows[index]
      if (!row || row.kind !== 'line') return
      record(mode, text)
      close()
      void openWorkspaceFile(root, row.path, `${splitPath(row.path).name}:${row.line}`, { line: row.line })
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (count) setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count)
      return
    }
    if (event.key === 'Enter') { event.preventDefault(); pick(selected); return }
    if (event.key === 'Tab') { event.preventDefault(); setMode(current => (current === 'file' ? 'content' : 'file')); setSelected(0) }
  }

  const projectName = root ? splitPath(root.replace(/\\/g, '/').replace(/\/$/, '')).name : null
  const hint = !folder
    ? (isLoading ? '프로젝트를 확인하는 중…' : '로컬 작업 탭에서 쓸 수 있습니다. 로컬 터미널 탭을 앞에 두고 다시 열어 주세요.')
    : error ?? (mode === 'content' && query.trim().length > 0 && query.trim().length < CONTENT_MIN ? `${CONTENT_MIN}자 이상 입력해 주세요.`
      : searching && count === 0 ? '찾는 중…'
      : query.trim() && !searching && count === 0 ? '찾은 것이 없습니다.' : null)

  return (
    <>
      <div className="project-search-overlay" onMouseDown={close} />
      <div className="project-search" role="dialog" aria-label="프로젝트 검색" onKeyDown={onKeyDown}>
        <div className="project-search-head">
          <div className="project-search-modes" role="tablist">
            {(['file', 'content'] as const).map(value => (
              <button key={value} type="button" role="tab" aria-selected={mode === value} className="project-search-mode"
                onClick={() => { setMode(value); setSelected(0); inputRef.current?.focus() }}>
                {value === 'file' ? <RiFileLine size={13} aria-hidden="true" /> : <RiFileSearchLine size={13} aria-hidden="true" />}
                {value === 'file' ? '파일' : '내용'}
                <kbd>{value === 'file' ? 'Shift Shift' : useShortcutsStore.getState().formatKeys(useShortcutsStore.getState().getEffectiveKeys('project-content-search'))}</kbd>
              </button>
            ))}
          </div>
          {projectName && <span className="project-search-project" title={root ?? undefined}><RiFolder3Line size={12} aria-hidden="true" />{projectName}</span>}
        </div>
        <div className="project-search-input">
          <RiSearchLine size={17} aria-hidden="true" />
          <input ref={inputRef} value={query} onChange={change} spellCheck={false} autoComplete="off"
            onCompositionEnd={event => {
              const target = event.currentTarget
              if (target.selectionStart === target.value.length) complete(target.value)
            }}
            placeholder={mode === 'file' ? '파일 이름이나 경로 일부' : '파일 내용에서 찾을 글'} aria-label={mode === 'file' ? '찾을 파일 이름' : '찾을 내용'}
            role="combobox" aria-expanded={count > 0} aria-controls="project-search-list" />
          {searching && <span className="project-search-spin" aria-hidden="true" />}
          <label className="project-search-option">
            {mode === 'file'
              ? <><input type="checkbox" checked={includeAll} onChange={event => setIncludeAll(event.target.checked)} />모두 포함</>
              : <><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} />대소문자 구분</>}
          </label>
        </div>
        <div className="project-search-list" id="project-search-list" role="listbox" ref={listRef}>
          {hint && <div className="project-search-empty">{hint}</div>}
          {!hint && recent.length > 0 && <div className="project-search-recent-head">최근 검색</div>}
          {!hint && recent.map((text, index) => (
            <div key={text} role="option" aria-selected={index === selected} className="project-search-row is-recent"
              onMouseMove={() => setSelected(index)} onClick={() => chooseRecent(index)}>
              <RiHistoryLine size={14} aria-hidden="true" />
              <span className="project-search-name">{text}</span>
              <button type="button" className="project-search-forget" title="기록에서 지우기" aria-label={`${text} 기록에서 지우기`}
                onMouseDown={event => event.preventDefault()}
                onClick={event => { event.stopPropagation(); forget(mode, text); setSelected(0) }}>
                <RiCloseLine size={13} aria-hidden="true" />
              </button>
            </div>
          ))}
          {!hint && !recent.length && mode === 'file' && files.map((hit, index) => {
            const { name, folder: parent } = splitPath(hit.path)
            return (
              <div key={hit.path} role="option" aria-selected={index === selected} className="project-search-row is-file"
                onMouseMove={() => setSelected(index)} onClick={() => pick(index)}>
                <RiFileLine size={14} aria-hidden="true" />
                <span className="project-search-name">{highlightParts(name, query.trim(), false).map((part, at) => part.hit ? <mark key={at}>{part.text}</mark> : part.text)}</span>
                <span className="project-search-folder">{parent}</span>
              </div>
            )
          })}
          {!hint && !recent.length && mode === 'content' && rows.map(row => {
            if (row.kind === 'file') {
              const { name, folder: parent } = splitPath(row.path)
              return (
                <div key={`f:${row.path}`} className="project-search-file-head">
                  <RiFileLine size={13} aria-hidden="true" />
                  <span className="project-search-name">{name}</span>
                  <span className="project-search-folder">{parent}</span>
                  <span className="project-search-count">{row.count}</span>
                </div>
              )
            }
            return (
              <div key={`l:${row.path}:${row.line}`} role="option" aria-selected={row.index === selected} className="project-search-row is-line"
                onMouseMove={() => setSelected(row.index)} onClick={() => pick(row.index)}>
                <span className="project-search-line">{row.line}</span>
                <code className="project-search-text">{highlightParts(row.text.trim(), query, caseSensitive).map((part, at) => part.hit ? <mark key={at}>{part.text}</mark> : part.text)}</code>
              </div>
            )
          })}
        </div>
        <div className="project-search-foot">
          <span><kbd>↑↓</kbd> 고르기</span>
          <span><kbd>Enter</kbd> {recent.length ? '다시 검색' : '열기'}</span>
          <span><kbd>Tab</kbd> 파일·내용</span>
          <span><kbd>Esc</kbd> 닫기</span>
          {count > 0 && !recent.length && <span className="project-search-total">{mode === 'content' && content ? `${content.files.length}개 파일 · ` : ''}{count}개{truncated ? ' (더 있음)' : ''}</span>}
        </div>
      </div>
    </>
  )
}
