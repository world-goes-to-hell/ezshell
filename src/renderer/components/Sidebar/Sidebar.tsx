import { useMemo, useState } from 'react'
import { RiAddFill, RiFolderFill, RiMenuFoldFill, RiMenuUnfoldFill, RiFolderAddFill, RiFlashlightFill, RiBarChartFill, RiTerminalBoxFill } from 'react-icons/ri'
import { motion } from 'framer-motion'
import { SessionList } from './SessionList'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { SPRINGS } from '../../lib/animation/config'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useShortcutsStore } from '../../stores/shortcutsStore'
import './SidebarCompact.css'

const TOGGLE_SHORTCUT_ID = 'toggle-sidebar'

interface SidebarProps {
  onNewConnection: () => void
  onQuickConnect: (session: any) => void
  onEditSession?: (session: any) => void
  onDuplicateSession?: (session: any) => void
  onOpenQuickConnect?: () => void
  onAddSession?: (folderId?: string) => void
  onStatsClick?: () => void
  onBatchClick?: () => void
}

export function Sidebar({ onNewConnection, onQuickConnect, onEditSession, onDuplicateSession, onOpenQuickConnect, onAddSession, onStatsClick, onBatchClick }: SidebarProps) {
  const { sidebarMode, toggleSidebarMode, setSidebarMode } = useUIStore()
  const { addFolder, saveToBackend } = useSessionStore()
  const isCompact = sidebarMode === 'compact'
  const [isAddingFolder, setIsAddingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const reducedMotion = useReducedMotion()
  const toggleShortcut = useShortcutsStore(state => state.formatKeys(state.getEffectiveKeys(TOGGLE_SHORTCUT_ID)))
  const toggleTitle = `${isCompact ? '사이드바 펼치기' : '사이드바 접기'} (${toggleShortcut})`

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
      className={`sidebar ${isCompact ? 'compact' : ''}`}
      role="navigation"
      aria-label="SSH session navigation"
    >
      <div className="sidebar-header">
        {!isCompact && <h2>연결 목록</h2>}
        <motion.button
          className="sidebar-toggle"
          onClick={toggleSidebarMode}
          title={toggleTitle}
          aria-label={toggleTitle}
          whileHover={reducedMotion ? undefined : { scale: 1.05 }}
          whileTap={reducedMotion ? undefined : { scale: 0.95 }}
        >
          <motion.div
            animate={{ rotate: isCompact ? 180 : 0 }}
            transition={reducedMotion ? { duration: 0 } : SPRINGS.snappy}
          >
            {isCompact ? <RiMenuUnfoldFill size={18} /> : <RiMenuFoldFill size={18} />}
          </motion.div>
        </motion.button>
      </div>
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
      {isCompact && (
        <div className="sidebar-actions">
          <button className="btn-new-connection-compact" onClick={onNewConnection} title="새 연결" aria-label="새 연결">
            <RiAddFill size={20} />
          </button>
          <button className="btn-compact-action" onClick={onOpenQuickConnect} title="빠른 연결" aria-label="빠른 연결">
            <RiFlashlightFill size={16} />
          </button>
          <button className="btn-compact-action" onClick={handleAddFolder} title="새 폴더" aria-label="새 폴더">
            <RiFolderAddFill size={16} />
          </button>
        </div>
      )}
      <SessionList onQuickConnect={onQuickConnect} onEditSession={onEditSession} onDuplicateSession={onDuplicateSession} onAddSession={onAddSession} isCompact={isCompact} />
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
    </aside>
  )
}
