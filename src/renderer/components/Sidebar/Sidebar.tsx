import { useMemo, useState } from 'react'
import { RiAddFill, RiFolderFill, RiArrowLeftDoubleLine, RiPushpinLine, RiFolderAddFill, RiFlashlightFill, RiBarChartFill, RiTerminalBoxFill, RiListUnordered, RiClipboardFill, RiPlugLine } from 'react-icons/ri'
import { motion } from 'framer-motion'
import { SessionList } from './SessionList'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { useMcpActivityStore } from '../../stores/mcpActivityStore'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { SPRINGS } from '../../lib/animation/config'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useShortcutsStore } from '../../stores/shortcutsStore'
import { useSidebarPeek } from '../../hooks/useSidebarPeek'
import './SidebarTree.css'

const TOGGLE_SHORTCUT_ID = 'toggle-sidebar'

interface SidebarProps {
  onNewConnection: () => void
  onQuickConnect: (session: any) => void
  onEditSession?: (session: any) => void
  onDuplicateSession?: (session: any) => void
  onOpenQuickConnect?: () => void
  onAddSession?: (folderId?: string) => void
  /** Opens "텍스트로 세션 추가" for the given folder (undefined = top level) */
  onImportSession?: (folderId?: string) => void
  onStatsClick?: () => void
  onBatchClick?: () => void
}

export function Sidebar({ onNewConnection, onQuickConnect, onEditSession, onDuplicateSession, onOpenQuickConnect, onAddSession, onImportSession, onStatsClick, onBatchClick }: SidebarProps) {
  const { sidebarMode, toggleSidebarMode, setSidebarMode } = useUIStore()
  const { addFolder, saveToBackend } = useSessionStore()
  // Folded: a narrow rail of status dots that opens over the terminal while the pointer is on it
  const isFolded = sidebarMode === 'compact'
  const { sidebarRef, isPeekOpen, peekHandlers } = useSidebarPeek(isFolded)
  // The rail shows the small buttons; the open sidebar (pinned or peeking) shows everything
  const isCompact = isFolded && !isPeekOpen
  // The rail has no buttons (pointing at it opens the whole sidebar first): it shows the state of
  // the SSH tabs and of MCP requests instead
  const connectedTabs = useTerminalStore(state => {
    let count = 0
    state.terminals.forEach(t => { if (t.connected && !t.db && !t.local) count++ })
    return count
  })
  const lostTabs = useTerminalStore(state => {
    let count = 0
    state.terminals.forEach(t => { if (!t.connected && !t.db && !t.local) count++ })
    return count
  })
  const mcpBusy = useMcpActivityStore(state => state.items.filter(item => item.state === 'running' || item.state === 'waiting').length)
  const [isAddingFolder, setIsAddingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const reducedMotion = useReducedMotion()
  const toggleShortcut = useShortcutsStore(state => state.formatKeys(state.getEffectiveKeys(TOGGLE_SHORTCUT_ID)))
  const toggleTitle = `${isFolded ? '사이드바 펼쳐 두기' : '사이드바 접기'} (${toggleShortcut})`
  // One shape per state. The old pair was a mirrored icon that was also turned 180 degrees when
  // folded, which made both states look the same.
  // The strip itself has no button: pointing at it opens the sidebar before the button can be
  // pressed, and the opened sidebar shows the pin. So the button exists only on an open sidebar.
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
      role="navigation"
      aria-label="SSH session navigation"
      {...peekHandlers}
    >
      <div className="sidebar-panel">
      {!isCompact && (
      <div className="sidebar-header">
        <h2>연결 목록</h2>
        <motion.button
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
      )}
      {!isCompact && (
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
      )}
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
      {isFolded && (
        // Stands in for the list and the buttons on the folded rail; pointing at it opens the whole sidebar
        <div className="rail-summary" aria-hidden="true">
          <div className="rail-group" title={`세션 · 연결된 탭 ${connectedTabs}개${lostTabs > 0 ? ` · 끊긴 탭 ${lostTabs}개` : ''}`}>
            <RiListUnordered size={16} />
            <span className="rail-label">세션</span>
            {connectedTabs > 0 && <span className="rail-count is-connected">{connectedTabs}</span>}
            {lostTabs > 0 && <span className="rail-count is-lost">{lostTabs}</span>}
          </div>
          {mcpBusy > 0 && (
            <div className="rail-group" title={`MCP 요청 진행 중 ${mcpBusy}개`}>
              <RiPlugLine size={16} />
              <span className="rail-label">MCP</span>
              <span className="rail-count is-busy">{mcpBusy}</span>
            </div>
          )}
        </div>
      )}
      <SessionList onQuickConnect={onQuickConnect} onEditSession={onEditSession} onDuplicateSession={onDuplicateSession} onAddSession={onAddSession} onImportSession={onImportSession} />
      {(onBatchClick || onStatsClick) && (
        <div className="sidebar-footer">
          {onBatchClick && (
            <button className="sidebar-footer-btn" onClick={onBatchClick} title="배치 명령 실행" aria-label="배치 명령 실행">
              <RiTerminalBoxFill size={18} />
            </button>
          )}
          {onStatsClick && (
            <button className="sidebar-footer-btn" onClick={onStatsClick} title="세션 통계" aria-label="세션 통계">
              <RiBarChartFill size={18} />
            </button>
          )}
        </div>
      )}
      </div>
    </aside>
  )
}
