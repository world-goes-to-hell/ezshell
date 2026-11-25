// The parts of the workspace panel that open things (docs/plan/2026-11-19-workspace-files-and-git-details.md):
// the folder tree that expands in place and opens files in the file window, and the diff of one file.
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiFileLine, RiFileTextLine, RiFolderLine, RiFolderOpenLine, RiGlobalLine, RiLinksLine } from 'react-icons/ri'
import type { WorkspaceDirectoryEntry, WorkspaceDirectorySearchResult, WorkspaceGitDiff } from '../../types'
import { toast } from '../../stores/toastStore'
import { isMediaFile, isWorkspaceWebDocument, joinRelative, diffLineKind, revealStep, splitPath } from '../../lib/workspaceDetails'
import { TerminalContextMenu } from '../Terminal/TerminalContextMenu'
import './WorkspaceDetails.css'

const fileIcons = { directory: RiFolderLine, file: RiFileLine, link: RiLinksLine }

/** Opens a file of `root` in the file window: text in the editor, images and PDFs in the preview */
export async function openWorkspaceFile(root: string, relative: string, label: string, options?: { compareHead?: boolean }): Promise<void> {
  const open = window.electronAPI.localFileOpen
  if (!open) {
    toast.error('파일을 열지 못했습니다', '앱을 다시 시작한 뒤에 사용할 수 있습니다.')
    return
  }
  try {
    const result = await open(root, relative, isMediaFile(relative) ? 'preview' : 'edit', label, options)
    if (!result.success) toast.error('파일을 열지 못했습니다', result.error)
  } catch {
    toast.error('파일을 열지 못했습니다')
  }
}

/** The right-click menu of a tree row. A folder (`openFile` null) only shows it in the file explorer */
export function useWorkspaceFileMenu(root: string, relative: string, openFile: (() => void) | null) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const reveal = window.electronAPI.localFileReveal
  const canOpenInBrowser = openFile !== null && isWorkspaceWebDocument(relative)
  const revealFile = async () => {
    if (!reveal) return
    try {
      const result = await reveal(root, relative)
      if (!result.success) toast.error('파일 탐색기로 열지 못했습니다', result.error)
    } catch {
      toast.error('파일 탐색기로 열지 못했습니다')
    }
  }
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const bounds = event.clientX === 0 && event.clientY === 0 ? event.currentTarget.getBoundingClientRect() : null
    setPosition({ x: bounds?.left ?? event.clientX, y: bounds?.bottom ?? event.clientY })
  }
  const openInBrowser = async () => {
    try {
      const result = await window.electronAPI.browserReviewOpenWorkspace(root, relative)
      if (!result.success) toast.error('브라우저로 열지 못했습니다', result.error)
    } catch {
      toast.error('브라우저로 열지 못했습니다')
    }
  }
  const menu = position && (
    <TerminalContextMenu key={`${position.x}:${position.y}`} position={position} groups={[]} onClose={() => setPosition(null)} top={[
      ...(canOpenInBrowser ? [{ label: '브라우저로 열기', icon: RiGlobalLine, onSelect: () => void openInBrowser() }] : []),
      { label: '파일 탐색기로 열기', icon: RiFolderOpenLine, disabled: !reveal, onSelect: () => void revealFile() },
      ...(openFile ? [{ label: 'ezShell로 열기', icon: RiFileTextLine, onSelect: openFile }] : [])
    ]} />
  )
  return { openMenu, menu }
}

type Listing = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; entries: WorkspaceDirectoryEntry[]; total: number }

function useListing(root: string, relative: string): Listing {
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  useEffect(() => {
    let active = true
    void window.electronAPI.workspaceDirectoryList(root, relative).then(
      result => { if (active) setListing(result.success ? { status: 'ready', entries: result.entries, total: result.total } : { status: 'error', message: result.error }) },
      () => { if (active) setListing({ status: 'error', message: '폴더 목록을 읽지 못했습니다.' }) }
    )
    return () => { active = false }
  }, [root, relative])
  return listing
}

/** A folder the tree opens up to and lights (a chat's folder link); `done` once it is shown */
export interface TreeReveal {
  target: string
  seq: number
  ignoreCase: boolean
  done: () => void
}

export const TreeRevealContext = createContext<TreeReveal | null>(null)

const REVEAL_LIGHT_MS = 1600

function TreeEntry({ root, relative, entry, depth, label, showPath = false }: { root: string; relative: string; entry: WorkspaceDirectoryEntry; depth: number; label: string; showPath?: boolean }) {
  const [isOpen, setIsOpen] = useState(false)
  const [isLit, setIsLit] = useState(false)
  const rowRef = useRef<HTMLButtonElement>(null)
  const reveal = useContext(TreeRevealContext)
  const step = reveal && entry.kind === 'directory' ? revealStep(relative, reveal.target, reveal.ignoreCase) : null
  // Folders on the way open (they read their entries then), and the folder itself opens and is lit
  useEffect(() => {
    if (!reveal || !step) return
    setIsOpen(true)
    if (step !== 'target') return
    rowRef.current?.scrollIntoView({ block: 'center' })
    setIsLit(true)
    reveal.done()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq, step])
  // Its own timer: `done` clears the request, which must not cut the light short
  useEffect(() => {
    if (!isLit) return
    const timer = window.setTimeout(() => setIsLit(false), REVEAL_LIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [isLit])
  const parent = showPath ? splitPath(relative).folder : ''
  const isFolder = entry.kind === 'directory'
  const openFile = () => void openWorkspaceFile(root, relative, label)
  const { openMenu, menu } = useWorkspaceFileMenu(root, relative, isFolder ? null : openFile)
  const Icon = isFolder && isOpen ? RiFolderOpenLine : fileIcons[entry.kind]
  const Chevron = isOpen ? RiArrowDownSLine : RiArrowRightSLine
  return (
    <li className="workspace-tree-item" data-kind={entry.kind}>
      <button
        type="button"
        ref={rowRef}
        className={`workspace-tree-row${isLit ? ' is-revealed' : ''}`}
        title={showPath ? relative : isFolder ? entry.name : `${entry.name} 열기`}
        aria-expanded={isFolder ? isOpen : undefined}
        onClick={() => (isFolder ? setIsOpen(open => !open) : openFile())}
        onContextMenu={openMenu}
      >
        {isFolder ? <Chevron size={14} className="workspace-tree-chevron" aria-hidden="true" /> : <span className="workspace-tree-chevron" aria-hidden="true" />}
        <Icon size={15} className="workspace-tree-icon" aria-hidden="true" />
        {parent ? (
          <span className="workspace-tree-result-label">
            <span className="workspace-tree-name" dir="auto">{entry.name}</span>
            <span className="workspace-tree-result-path" dir="auto">{parent}</span>
          </span>
        ) : <span className="workspace-tree-name" dir="auto">{entry.name}</span>}
      </button>
      {menu}
      {isFolder && isOpen && <TreeLevel root={root} relative={relative} depth={depth + 1} label={label} />}
    </li>
  )
}

/** One folder's entries; folders expand in place and are read the first time they open */
export function TreeLevel({ root, relative, depth, label }: { root: string; relative: string; depth: number; label: string }) {
  const listing = useListing(root, relative)
  const indent = { '--workspace-tree-indent': `${depth * 14}px` } as CSSProperties
  if (listing.status === 'loading') return <p className="workspace-tree-note" style={indent}>읽는 중…</p>
  if (listing.status === 'error') return <p className="workspace-tree-note is-error" style={indent}>{listing.message}</p>
  if (listing.entries.length === 0) return <p className="workspace-tree-note" style={indent}>비어 있는 폴더입니다.</p>
  return (
    <ul className="workspace-tree" style={indent} role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? '폴더 항목' : undefined}>
      {listing.entries.map(entry => <TreeEntry key={entry.name} root={root} relative={joinRelative(relative, entry.name)} entry={entry} depth={depth} label={label} />)}
      {listing.total > listing.entries.length && (
        <li className="workspace-tree-note">{listing.total.toLocaleString()}개 중 {listing.entries.length.toLocaleString()}개 표시</li>
      )}
    </ul>
  )
}

export function WorkspaceFileResults({ root, label, entries }: { root: string; label: string; entries: WorkspaceDirectorySearchResult['entries'] }) {
  return (
    <ul className="workspace-tree workspace-tree-results" role="tree" aria-label="파일·폴더 검색 결과">
      {entries.map(entry => <TreeEntry key={entry.path} root={root} relative={entry.path} entry={entry} depth={0} label={label} showPath />)}
    </ul>
  )
}

type DiffState = { status: 'loading' } | { status: 'error'; message: string } | ({ status: 'ready' } & WorkspaceGitDiff)

/** The diff of one file: in a commit (`hash`), or the work tree against HEAD */
export function GitDiffBlock({ root, file, hash }: { root: string; file: string; hash?: string }) {
  const [state, setState] = useState<DiffState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    const read = window.electronAPI.workspaceGitDiff
    if (!read) {
      setState({ status: 'error', message: '앱을 다시 시작한 뒤에 사용할 수 있습니다.' })
      return
    }
    void read(root, file, hash).then(
      result => { if (active) setState(result.success ? { status: 'ready', text: result.text, truncated: result.truncated, binary: result.binary } : { status: 'error', message: result.error }) },
      () => { if (active) setState({ status: 'error', message: '변경 내용을 읽지 못했습니다.' }) }
    )
    return () => { active = false }
  }, [root, file, hash])
  if (state.status === 'loading') return <p className="workspace-diff-note">변경 내용을 읽는 중…</p>
  if (state.status === 'error') return <p className="workspace-diff-note is-error">{state.message}</p>
  if (state.binary) return <p className="workspace-diff-note">바이너리 파일이라 내용을 비교할 수 없습니다.</p>
  // The header lines (diff --git, index, ---/+++) say nothing the row does not; start at the first hunk
  const lines = state.text.replace(/\n$/, '').split('\n')
  const start = lines.findIndex(line => line.startsWith('@@'))
  const shown = start >= 0 ? lines.slice(start) : []
  if (shown.length === 0) return <p className="workspace-diff-note">내용 변경이 없습니다 (권한이나 이름만 바뀜).</p>
  return (
    <div className="workspace-diff">
      <pre className="workspace-diff-text">
        {shown.map((line, index) => <span key={index} className={`workspace-diff-line is-${diffLineKind(line)}`}>{line || ' '}{'\n'}</span>)}
      </pre>
      {state.truncated && <p className="workspace-diff-note">앞부분만 표시했습니다.</p>}
    </div>
  )
}
