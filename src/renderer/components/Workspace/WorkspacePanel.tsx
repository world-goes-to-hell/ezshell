import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { RiChatHistoryLine, RiCloseLine, RiFileEditLine, RiFolder3Line, RiGitBranchLine } from 'react-icons/ri'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import { WORKSPACE_DEFAULT_WIDTH, clampWorkspaceWidth, type WorkspaceSection } from '../../lib/workspacePanel'
import { AgentHistoryPanel } from '../AgentHistory/AgentHistoryPanel'
import { useWorkspaceDirectory } from '../../hooks/useWorkspaceDirectory'
import { WorkspaceFiles, WorkspaceGit, WorkspaceNote } from './WorkspaceBrowser'
import { WorkspaceChanges } from './WorkspaceChanges'
import { relativeInside } from '../../lib/workspaceDetails'
import { prefetchWorkspaceGit } from '../../lib/workspaceGitReads'
import './Workspace.css'

const SECTIONS: ReadonlyArray<{ id: WorkspaceSection; label: string; Icon: typeof RiChatHistoryLine }> = [
  { id: 'history', label: '대화 기록', Icon: RiChatHistoryLine },
  { id: 'files', label: '파일', Icon: RiFolder3Line },
  { id: 'changes', label: '변경', Icon: RiFileEditLine },
  { id: 'git', label: 'Git 기록', Icon: RiGitBranchLine }
]
const KEY_STEP = 24
const REVEAL_WAIT_MS = 3000
const PREFETCH_DELAY_MS = 250

/**
 * "작업 공간": docked right of the main area for work in local shells. It sits beside the terminals
 * instead of over them, so it stays in view while typing.
 */
export function WorkspacePanel() {
  const isOpen = useWorkspacePanelStore(state => state.isOpen)
  const width = useWorkspacePanelStore(state => state.width)
  const section = useWorkspacePanelStore(state => state.section)
  const close = useWorkspacePanelStore(state => state.close)
  const setWidth = useWorkspacePanelStore(state => state.setWidth)
  const setSection = useWorkspacePanelStore(state => state.setSection)
  // Read on every tab (also the history): the other tabs then open on a folder already known
  const { folder, shellId, isLoading, settled } = useWorkspaceDirectory(isOpen)
  // What the Git tabs show first is read ahead, a moment after the folder is known (not competing with
  // what the panel draws when it opens)
  useEffect(() => {
    if (!isOpen || !folder) return
    const timer = window.setTimeout(() => void prefetchWorkspaceGit(folder).catch(() => undefined), PREFETCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [isOpen, folder])
  const reveal = useWorkspacePanelStore(state => state.reveal)
  const finishReveal = useWorkspacePanelStore(state => state.finishReveal)
  // A chat's folder link: shown in the tree once the panel's folder is that chat's shell's folder
  const ready = Boolean(reveal && folder && settled && shellId === reveal.shellId)
  const revealRelative = ready && reveal && folder ? relativeInside(folder, reveal.folder) : null
  useEffect(() => {
    if (!reveal) return
    if (ready) {
      // Outside the panel's folder: the file manager, as before
      if (revealRelative === null) {
        finishReveal(reveal.seq)
        reveal.fallback()
      }
      return
    }
    // The chat's shell never became the panel's (or its folder was not read): the file manager
    const timer = window.setTimeout(() => {
      if (useWorkspacePanelStore.getState().reveal?.seq !== reveal.seq) return
      finishReveal(reveal.seq)
      reveal.fallback()
    }, Math.max(0, REVEAL_WAIT_MS - (Date.now() - reveal.at)))
    return () => window.clearTimeout(timer)
  }, [reveal, ready, revealRelative, finishReveal])
  // The latest dragged width: the pointer-up handler may still belong to the render before it
  const drag = useRef<{ startX: number; startWidth: number; width?: number } | null>(null)

  if (!isOpen) return null
  const shown = clampWorkspaceWidth(width, window.innerWidth)

  // The moves are heard on the window: the pointer soon leaves the thin edge (over a terminal, which
  // keeps its own pointer handling), and pointer capture did not hold for it
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    drag.current = { startX: event.clientX, startWidth: shown }
    const onMove = (move: globalThis.PointerEvent) => {
      if (!drag.current) return
      // Dragging the left edge to the left makes the panel wider
      const next = clampWorkspaceWidth(drag.current.startWidth - (move.clientX - drag.current.startX), window.innerWidth)
      drag.current.width = next
      setWidth(next, false)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const dragged = drag.current?.width
      drag.current = null
      if (dragged !== undefined) setWidth(dragged, true)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setWidth(clampWorkspaceWidth(shown + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP), window.innerWidth), true)
  }

  return (
    <aside className="workspace-panel" style={{ width: shown }} aria-label="작업 공간">
      <div
        className="workspace-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="작업 공간 폭"
        aria-valuenow={shown}
        tabIndex={0}
        title="끌어서 폭 조절 · 두 번 누르면 기본 폭"
        onPointerDown={onPointerDown}
        onDoubleClick={() => setWidth(clampWorkspaceWidth(WORKSPACE_DEFAULT_WIDTH, window.innerWidth), true)}
        onKeyDown={onKeyDown}
      />
      <header className="workspace-header">
        <div className="workspace-sections" role="tablist" aria-label="작업 공간 구역">
          {SECTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`workspace-tab-${id}`}
              aria-label={label}
              title={label}
              aria-selected={section === id}
              aria-controls="workspace-content"
              className={`workspace-section${section === id ? ' is-active' : ''}`}
              onClick={() => setSection(id)}
            >
              <Icon size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
        <button type="button" className="workspace-close" onClick={close} aria-label="작업 공간 닫기" title="닫기">
          <RiCloseLine size={16} />
        </button>
      </header>
      <div className="workspace-content" id="workspace-content" role="tabpanel" aria-labelledby={`workspace-tab-${section}`}>
        {section === 'history' ? <AgentHistoryPanel />
          : folder ? (section === 'files' ? <WorkspaceFiles key={folder} folder={folder} onRevealed={finishReveal}
              reveal={reveal && revealRelative !== null ? { relative: revealRelative, seq: reveal.seq } : null} />
            : section === 'changes' ? <WorkspaceChanges folder={folder} /> : <WorkspaceGit folder={folder} />)
          : <WorkspaceNote>{isLoading ? '작업 폴더를 확인하는 중…' : shellId
            ? '현재 작업 폴더를 읽지 못했습니다.'
            : '로컬 터미널을 선택하면 작업 폴더를 볼 수 있습니다.'}</WorkspaceNote>}
      </div>
    </aside>
  )
}
