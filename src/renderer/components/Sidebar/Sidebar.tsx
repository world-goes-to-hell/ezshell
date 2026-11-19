import { useMemo, useState } from 'react'
import { RiAddFill, RiFolderFill, RiArrowLeftDoubleLine, RiArrowRightLine, RiPushpinLine, RiFolderAddFill, RiFlashlightFill, RiListUnordered, RiClipboardFill, RiPlugLine, RiComputerLine } from 'react-icons/ri'
import { motion } from 'framer-motion'
import { SessionList } from './SessionList'
import { LocalTerminalList } from './LocalTerminalList'
import { SessionSearchBox } from './SessionSearchBox'
import { sessionSearchTerms, searchSessions, stepMatch } from '../../lib/sessionSearch'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore, type Session } from '../../stores/sessionStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { useMcpActivityStore } from '../../stores/mcpActivityStore'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { SPRINGS } from '../../lib/animation/config'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useShortcutsStore } from '../../stores/shortcutsStore'
import { useSidebarPeek } from '../../hooks/useSidebarPeek'
import { useSidebarConnectionMotion } from '../../hooks/useSidebarConnectionMotion'
import { useProjectServers } from '../../hooks/useProjectServers'
import { railCounts, linkedSessionIdsOf } from '../../lib/sidebarRail'
import './SidebarTree.css'

const TOGGLE_SHORTCUT_ID = 'toggle-sidebar'

interface SidebarProps {
  onNewConnection: () => void
  onQuickConnect: (session: Session, source?: HTMLElement) => void
  onEditSession?: (session: any) => void
  onDuplicateSession?: (session: any) => void
  onOpenQuickConnect?: () => void
  onAddSession?: (folderId?: string) => void
  /** Opens "텍스트로 세션 추가" for the given folder (undefined = top level) */
  onImportSession?: (folderId?: string) => void
  /** Opens a new local terminal tab (the + of the local terminal list) */
  onLocalTerminal?: (button: HTMLButtonElement) => void
  /** Opens a local terminal in a worktree of the local tree */
  onLocalFolder?: (cwd: string, workspaceLabel: string) => void
  /** Closes a tab; used by the local terminal list */
  onCloseTerminal?: (terminalId: string) => void
}

export function Sidebar({ onNewConnection, onQuickConnect, onEditSession, onDuplicateSession, onOpenQuickConnect, onAddSession, onImportSession, onLocalTerminal, onLocalFolder, onCloseTerminal }: SidebarProps) {
  const { sidebarMode, toggleSidebarMode, setSidebarMode } = useUIStore()
  const zenMode = useUIStore(state => state.zenMode)
  const { addFolder, saveToBackend } = useSessionStore()
  const sessions = useSessionStore(state => state.sessions)
  const folders = useSessionStore(state => state.folders)
  // Search: the matching sessions are marked in the tree and the others stay where they are
  const [searchQuery, setSearchQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const searchTerms = useMemo(() => sessionSearchTerms(searchQuery), [searchQuery])
  const searchResult = useMemo(() => searchSessions(sessions, folders, searchTerms), [sessions, folders, searchTerms])
  const currentMatchId = searchResult.matchIds[Math.min(matchIndex, searchResult.matchIds.length - 1)]
  const changeSearch = (query: string) => {
    setSearchQuery(query)
    setMatchIndex(0)
  }
  const connectCurrentMatch = () => {
    const session = sessions.find(item => item.id === currentMatchId)
    if (!session) return
    const row = sidebarRef.current?.querySelector<HTMLElement>(`.session-item[data-session-id="${CSS.escape(session.id)}"]`)
    onQuickConnect(session, row ?? undefined)
  }
  // The folded rail previews its two lists independently over the terminal.
  const isFolded = sidebarMode === 'compact'
  const { sidebarRef, focusTargetRef, peekSection, isPeekOpen, previewTrigger, switchPreview, peekHandlers } = useSidebarPeek(isFolded && !zenMode)
  const isLocalPeek = peekSection === 'local'
  const PreviewDestinationIcon = isLocalPeek ? RiListUnordered : RiComputerLine
  const isCompact = isFolded && !isPeekOpen
  // Tabs of sessions tied to a local project count under local work (lib/sidebarRail.ts)
  const terminals = useTerminalStore(state => state.terminals)
  const projectServers = useProjectServers()
  const rail = useMemo(() => railCounts(terminals, linkedSessionIdsOf(projectServers)), [terminals, projectServers])
  const { connected: connectedTabs, lost: lostTabs } = rail.sessions
  const { terminals: localTabs, connected: localServerTabs, lost: localLostTabs } = rail.local
  const mcpBusy = useMcpActivityStore(state => state.items.filter(item => item.state === 'running' || item.state === 'waiting').length)
  const [isAddingFolder, setIsAddingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const reducedMotion = useReducedMotion()
  // Session dots stay in the rail during a local preview and fly out when sessions become visible.
  useSidebarConnectionMotion(sidebarRef, isFolded && (!isPeekOpen || peekSection !== 'sessions'), !reducedMotion && !zenMode)
  const toggleShortcut = useShortcutsStore(state => state.formatKeys(state.getEffectiveKeys(TOGGLE_SHORTCUT_ID)))
  const toggleTitle = `${isFolded ? '사이드바 펼쳐 두기' : '사이드바 접기'} (${toggleShortcut})`
  const ToggleIcon = isFolded ? RiPushpinLine : RiArrowLeftDoubleLine

  // Stable handlers so the keydown listener is not re-attached on every render
  const shortcutHandlers = useMemo(() => ({ toggleSidebar: toggleSidebarMode }), [toggleSidebarMode])
  useKeyboardShortcuts(shortcutHandlers)

  const handleAddFolder = () => {
    // The folder name input only exists in the expanded sidebar
    setSidebarMode('expanded')
    setIsAddingFolder(true)
    setNewFolderName('')
  }

  const handleFolderSubmit = () => {
    if (newFolderName.trim()) {
      const folder = {
        id: crypto.randomUUID(),
        name: newFolderName.trim()
      }
      addFolder(folder)
      saveToBackend()
    }
    setIsAddingFolder(false)
    setNewFolderName('')
  }

  const handleFolderKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleFolderSubmit()
    } else if (e.key === 'Escape') {
      setIsAddingFolder(false)
      setNewFolderName('')
    }
  }

  return (
    <aside
      ref={sidebarRef}
      className={`sidebar ${isFolded ? 'rail' : ''} ${isPeekOpen ? 'peek-open' : ''}`}
      data-peek-section={peekSection ?? undefined}
      role="navigation"
      aria-label="세션 및 로컬 작업"
      {...peekHandlers}
    >
      <div className="sidebar-panel">
        <div id="sidebar-content" className="sidebar-content" inert={isCompact || zenMode}>
          <div className="sidebar-header">
            <h2>{isLocalPeek ? '로컬 작업' : '연결 목록'}</h2>
            <div className="sidebar-header-actions">
              <motion.button
                ref={focusTargetRef}
                className="sidebar-toggle"
                onClick={toggleSidebarMode}
                title={toggleTitle}
                aria-label={toggleTitle}
                whileHover={reducedMotion ? undefined : { scale: 1.05 }}
                whileTap={reducedMotion ? undefined : { scale: 0.95 }}
              >
                <ToggleIcon size={18} />
              </motion.button>
            </div>
          </div>
          <div className="sidebar-actions">
            <motion.button
              className="btn-new-connection"
              onClick={onNewConnection}
              whileHover={reducedMotion ? undefined : { scale: 1.02, y: -2 }}
              whileTap={reducedMotion ? undefined : { scale: 0.98 }}
              transition={SPRINGS.snappy}
            >
              <RiAddFill size={18} />
              <span>새 연결</span>
            </motion.button>
            <button className="btn-quick-connect" onClick={onOpenQuickConnect} title="빠른 연결">
              <RiFlashlightFill size={18} />
            </button>
            <button className="btn-new-folder" onClick={handleAddFolder} title="새 폴더">
              <RiFolderAddFill size={18} />
            </button>
            {onImportSession && (
              <button className="btn-new-folder" onClick={() => onImportSession()} title="텍스트로 세션 추가" aria-label="텍스트로 세션 추가">
                <RiClipboardFill size={18} />
              </button>
            )}
          </div>
          {!isCompact && isAddingFolder && (
            <div className="folder-input-wrapper">
              <RiFolderFill size={16} className="folder-input-icon" />
              <input
                type="text"
                className="folder-input"
                placeholder="폴더 이름"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={handleFolderKeyDown}
                onBlur={handleFolderSubmit}
                autoFocus
              />
            </div>
          )}
          {sessions.length > 0 && (
            <SessionSearchBox
              query={searchQuery}
              onQueryChange={changeSearch}
              matchCount={searchTerms.length > 0 ? searchResult.matchIds.length : null}
              current={Math.min(matchIndex, Math.max(0, searchResult.matchIds.length - 1))}
              onStep={(delta) => setMatchIndex(index => stepMatch(Math.min(index, searchResult.matchIds.length - 1), delta, searchResult.matchIds.length))}
              onConnectCurrent={connectCurrentMatch}
            />
          )}
          {/* The list area: sessions above, the open local terminals (when there are any) below */}
          <div className="sidebar-lists">
            <SessionList search={{ terms: searchTerms, result: searchResult, currentId: currentMatchId }} onQuickConnect={onQuickConnect} onEditSession={onEditSession} onDuplicateSession={onDuplicateSession} onAddSession={onAddSession} onImportSession={onImportSession} />
            {onCloseTerminal && <LocalTerminalList fillAvailableSpace={isLocalPeek} onOpen={onLocalTerminal} onClose={onCloseTerminal} onOpenFolder={onLocalFolder} onConnectSession={session => onQuickConnect(session)} />}
          </div>
          {peekSection && (
            <button
              type="button"
              className="sidebar-peek-switch"
              onClick={() => switchPreview(isLocalPeek ? 'sessions' : 'local')}
            >
              <PreviewDestinationIcon size={16} aria-hidden="true" />
              <span>{isLocalPeek ? '세션 목록으로 전환' : '로컬 작업으로 전환'}</span>
              <RiArrowRightLine size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="rail-summary" inert={!isCompact || zenMode}>
          <button
            type="button"
            className="rail-group"
            data-peek-target="sessions"
            aria-label="세션 목록 미리보기"
            aria-controls="sidebar-content"
            aria-expanded={isPeekOpen && peekSection === 'sessions'}
            title={`세션 · 연결된 탭 ${connectedTabs}개${lostTabs > 0 ? ` · 끊긴 탭 ${lostTabs}개` : ''}`}
            {...previewTrigger('sessions')}
          >
            <RiListUnordered size={16} aria-hidden="true" />
            {connectedTabs > 0 && (
              <span className="rail-count is-connected" aria-hidden="true"><span className="rail-connection-dot" />{connectedTabs}</span>
            )}
            {lostTabs > 0 && <span className="rail-count is-lost" aria-hidden="true">{lostTabs}</span>}
            {mcpBusy > 0 && (
              <span className="rail-mcp-status" title={`MCP 요청 진행 중 ${mcpBusy}개`} aria-hidden="true">
                <RiPlugLine size={16} />
                <span className="rail-count is-busy">{mcpBusy}</span>
              </span>
            )}
          </button>
          <button
            type="button"
            className="rail-group"
            data-peek-target="local"
            aria-label="로컬 작업 미리보기"
            aria-controls="sidebar-content"
            aria-expanded={isPeekOpen && isLocalPeek}
            title={`로컬 작업 · 열린 터미널 ${localTabs}개${localServerTabs > 0 ? ` · 연결된 서버 탭 ${localServerTabs}개` : ''}${localLostTabs > 0 ? ` · 끊긴 서버 탭 ${localLostTabs}개` : ''}`}
            {...previewTrigger('local')}
          >
            <span className="rail-local-mark" aria-hidden="true">
              <RiComputerLine size={19} />
              {localTabs > 0 && <span className="rail-local-shell-count">{localTabs}</span>}
            </span>
            {(localServerTabs > 0 || localLostTabs > 0) && (
              <span className="rail-local-server-states" aria-hidden="true">
                {localServerTabs > 0 && (
                  <span className="rail-count is-connected"><span className="rail-local-connection-dot" />{localServerTabs}</span>
                )}
                {localLostTabs > 0 && (
                  <span className="rail-count is-lost"><span className="rail-local-lost-dot" />{localLostTabs}</span>
                )}
              </span>
            )}
          </button>
        </div>
      </div>
    </aside>
  )
}
