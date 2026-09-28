import { useState } from 'react'
import { RiAddFill, RiFolderFill, RiMenuFoldFill, RiMenuUnfoldFill, RiFolderAddFill, RiFlashlightFill, RiBarChartFill, RiTerminalBoxFill } from 'react-icons/ri'
import { motion } from 'framer-motion'
import { SessionList } from './SessionList'
import { useUIStore } from '../../stores/uiStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { SPRINGS } from '../../lib/animation/config'

interface SidebarProps {
  onNewConnection: () => void
  onQuickConnect: (session: any) => void
  onEditSession?: (session: any) => void
  onOpenQuickConnect?: () => void
  onAddSession?: (folderId?: string) => void
  onStatsClick?: () => void
  onBatchClick?: () => void
  activeSessionIds?: Set<string>
}

export function Sidebar({ onNewConnection, onQuickConnect, onEditSession, onOpenQuickConnect, onAddSession, onStatsClick, onBatchClick, activeSessionIds }: SidebarProps) {
  const { sidebarMode, toggleSidebarMode } = useUIStore()
  const { addFolder, saveToBackend } = useSessionStore()
  const isCompact = sidebarMode === 'compact'
  const [isAddingFolder, setIsAddingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const reducedMotion = useReducedMotion()

  const handleAddFolder = () => {
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
          title={isCompact ? '사이드바 펼치기' : '사이드바 접기'}
          whileHover={reducedMotion ? undefined : { scale: 1.05 }}
          whileTap={reducedMotion ? undefined : { scale: 0.95 }}
        >
          <motion.div
            animate={{ rotate: isCompact ? 180 : 0 }}
            transition={reducedMotion ? { duration: 0 } : SPRINGS.snappy}
          >
            {isCompact ? <RiMenuUnfoldFill size={16} /> : <RiMenuFoldFill size={16} />}
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
            <RiAddFill size={16} />
            <span>새 연결</span>
          </motion.button>
          <button className="btn-quick-connect" onClick={onOpenQuickConnect} title="빠른 연결">
            <RiFlashlightFill size={16} />
          </button>
          <button className="btn-new-folder" onClick={handleAddFolder} title="새 폴더">
            <RiFolderAddFill size={16} />
          </button>
        </div>
      )}
      {!isCompact && isAddingFolder && (
        <div className="folder-input-wrapper">
          <RiFolderFill size={14} className="folder-input-icon" />
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
          <button className="btn-new-connection-compact" onClick={onNewConnection} title="새 연결">
            <RiAddFill size={20} />
          </button>
        </div>
      )}
      <SessionList onQuickConnect={onQuickConnect} onEditSession={onEditSession} onAddSession={onAddSession} isCompact={isCompact} activeSessionIds={activeSessionIds} />
      {!isCompact && (
        <div className="sidebar-footer">
          {onBatchClick && (
            <button className="sidebar-footer-btn" onClick={onBatchClick} title="배치 명령 실행">
              <RiTerminalBoxFill size={16} />
            </button>
          )}
          {onStatsClick && (
            <button className="sidebar-footer-btn" onClick={onStatsClick} title="세션 통계">
              <RiBarChartFill size={16} />
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
