import { useState, useRef, useEffect } from 'react'
import { RiCloseLine, RiAddLine, RiFolderLine, RiSplitCellsHorizontal } from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSessionLogStore } from '../../stores/sessionLogStore'
import { readableTextColor } from '../../lib/colorContrast'

interface SplitPaneTabBarProps {
  paneType: 'primary' | 'secondary'
  terminalIds: string[]
  activeTerminalId: string | null
  isActivePane: boolean  // 이 pane이 현재 포커스 상태인지
  onTabSelect: (terminalId: string) => void
  onTabClose: (terminalId: string) => void
  onAddTab: (session: any) => void
  onUnsplit?: () => void
  onSftpToggle?: () => void
  sftpOpen?: boolean
  onPaneFocus: () => void
  onTabDragStart?: (terminalId: string) => void
  onTabDragEnd?: () => void
  onTabDrop?: (terminalId: string) => void
  draggingTabId?: string | null
}

export function SplitPaneTabBar({
  terminalIds,
  activeTerminalId,
  isActivePane,
  onTabSelect,
  onTabClose,
  onAddTab,
  onUnsplit,
  onSftpToggle,
  sftpOpen,
  onPaneFocus,
  onTabDragStart,
  onTabDragEnd,
  onTabDrop,
  draggingTabId
}: SplitPaneTabBarProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const terminals = useTerminalStore(state => state.terminals)
  const sessionLogFiles = useSessionLogStore(state => state.files)
  const { sessions } = useSessionStore()

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownOpen && dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dropdownOpen])

  const handleSessionSelect = (session: any) => {
    setDropdownOpen(false)
    onAddTab(session)
  }

  // 활성 탭의 색상으로 header border 표시 (활성 패인일 때만)
  const activeTerminal = activeTerminalId ? terminals.get(activeTerminalId) : null
  const headerBorderColor = isActivePane && activeTerminal?.color ? activeTerminal.color : undefined

  return (
    <div
      className={`split-pane-header ${isActivePane ? 'is-active-pane' : ''}`}
      onMouseDown={onPaneFocus}
      style={headerBorderColor ? { borderBottomColor: headerBorderColor } : undefined}
    >
      <div
        className={`split-pane-tabs ${isDragOver ? 'drag-over' : ''}`}
        onDragOver={(e) => {
          if (draggingTabId && !terminalIds.includes(draggingTabId)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setIsDragOver(true)
          }
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragOver(false)
          const droppedId = e.dataTransfer.getData('text/plain')
          if (droppedId && !terminalIds.includes(droppedId)) {
            onTabDrop?.(droppedId)
          }
        }}
      >
        {terminalIds.map(terminalId => {
          const terminal = terminals.get(terminalId)
          if (!terminal) return null

          const isActive = terminalId === activeTerminalId
          const displayName = terminal.title || `${terminal.username}@${terminal.host}`

          // Session color is an identity cue (e.g. dev vs prod), not a selection cue:
          // - active tab of the focused pane: filled with the session color
          // - every other tab: a 3px strip on the left, so it never looks like the selection border
          // Text color for the non-filled states comes from CSS so it stays readable in light themes.
          const tabStyle = isActive && isActivePane && terminal.color
            ? {
                backgroundColor: terminal.color,
                borderColor: terminal.color,
                color: readableTextColor(terminal.color)
              }
            : terminal.color
            ? { boxShadow: `inset 3px 0 0 ${terminal.color}` }
            : undefined

          return (
            <div
              key={terminalId}
              className={`split-pane-tab-item ${isActive ? 'active' : ''} ${draggingTabId === terminalId ? 'dragging' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', terminalId)
                e.dataTransfer.effectAllowed = 'move'
                onTabDragStart?.(terminalId)
              }}
              onDragEnd={() => onTabDragEnd?.()}
              onClick={() => onTabSelect(terminalId)}
              title={displayName}
              style={tabStyle}
            >
              <span className="split-pane-tab-name">{displayName}</span>
              {terminalId in sessionLogFiles && <span className="tab-log-indicator" role="img" aria-label="로그 저장 중" title={`로그 저장 중: ${sessionLogFiles[terminalId]}`} />}
              {terminalIds.length > 1 && (
                <button
                  className="split-pane-tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    onTabClose(terminalId)
                  }}
                  title="탭 닫기"
                >
                  <RiCloseLine size={16} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="split-pane-actions">
        {/* Add tab dropdown */}
        <div className="split-new-dropdown-container" ref={dropdownRef}>
          <button
            className="split-pane-btn"
            onClick={() => setDropdownOpen(!dropdownOpen)}
            title="새 세션 추가"
          >
            <RiAddLine size={16} />
          </button>
          {dropdownOpen && (
            <div className="split-new-dropdown">
              <div className="split-new-dropdown-title">세션 선택</div>
              {sessions.length > 0 ? (
                sessions.map(session => (
                  <div
                    key={session.id}
                    className="split-new-dropdown-item"
                    onClick={() => handleSessionSelect(session)}
                  >
                    {session.name || `${session.username}@${session.host}`}
                  </div>
                ))
              ) : (
                <div className="split-new-dropdown-empty">저장된 세션 없음</div>
              )}
            </div>
          )}
        </div>

        {/* SFTP toggle */}
        {onSftpToggle && (
          <button
            className={`split-pane-btn ${sftpOpen ? 'active' : ''}`}
            onClick={onSftpToggle}
            title={sftpOpen ? 'SFTP 닫기' : 'SFTP 열기'}
          >
            <RiFolderLine size={16} />
          </button>
        )}

        {/* Unsplit button */}
        {onUnsplit && (
          <button
            className="split-pane-btn"
            onClick={onUnsplit}
            title="분할 해제"
          >
            <RiSplitCellsHorizontal size={16} />
          </button>
        )}
      </div>
    </div>
  )
}
