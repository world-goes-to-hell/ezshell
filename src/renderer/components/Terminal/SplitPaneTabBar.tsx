import type { MouseEvent, ReactNode } from 'react'
import { RiCloseLine, RiDatabase2Line, RiFolderLine, RiSplitCellsHorizontal, RiComputerLine, RiGlobalLine } from 'react-icons/ri'
import { useTerminalStore } from '../../stores/terminalStore'
import { AgentTabMessages } from './AgentMessages'
import { useSessionLogStore } from '../../stores/sessionLogStore'
import { readableTextColor } from '../../lib/colorContrast'
import type { WorktreeNode } from '../Sidebar/LocalProjectsTree'
import { TabWorktreeBadge } from './TabWorktreeBadge'
import { useTabStripScroll } from '../../hooks/useTabStripScroll'
import { DevelopmentTabDots } from './DevelopmentRunStatus'

interface SplitPaneTabBarProps {
  paneType: 'primary' | 'secondary'
  terminalIds: string[]
  activeTerminalId: string | null
  isActivePane: boolean  // 이 pane이 현재 포커스 상태인지
  onTabSelect: (terminalId: string) => void
  onTabClose: (terminalId: string) => void
  onTabContextMenu?: (event: MouseEvent, terminalId: string) => void
  workSelector?: ReactNode
  /** The + menu shown right after the tabs (same menu as the single tab bar) */
  newTabMenu?: ReactNode
  worktreeForFolder: (cwd: string) => WorktreeNode | undefined
  onUnsplit?: () => void
  onSftpToggle?: () => void
  sftpOpen?: boolean
  onPaneFocus: () => void
  onTabDragStart?: (terminalId: string) => void
  onTabDragEnd?: () => void
  draggingTabId?: string | null
}

export function SplitPaneTabBar({
  terminalIds,
  activeTerminalId,
  isActivePane,
  onTabSelect,
  onTabClose,
  onTabContextMenu,
  workSelector,
  newTabMenu,
  worktreeForFolder,
  onUnsplit,
  onSftpToggle,
  sftpOpen,
  onPaneFocus,
  onTabDragStart,
  onTabDragEnd,
  draggingTabId
}: SplitPaneTabBarProps) {
  const terminals = useTerminalStore(state => state.terminals)
  const sessionLogFiles = useSessionLogStore(state => state.files)

  // 활성 탭의 색상으로 header border 표시 (활성 패인일 때만)
  const activeTerminal = activeTerminalId ? terminals.get(activeTerminalId) : null
  const headerBorderColor = isActivePane && activeTerminal?.color ? activeTerminal.color : undefined
  // The tabs scroll sideways when they do not fit; the + menu stays outside the scrolling strip
  const stripRef = useTabStripScroll(activeTerminalId)

  return (
    <div
      className={`split-pane-header ${isActivePane ? 'is-active-pane' : ''}`}
      onMouseDown={onPaneFocus}
      style={headerBorderColor ? { borderBottomColor: headerBorderColor } : undefined}
    >
      {workSelector}
      <div ref={stripRef} className="split-pane-tabs">
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
              data-tab-id={terminalId}
              data-browser-tab={terminal.browser ? '' : undefined}
              className={`split-pane-tab-item ${isActive ? 'active' : ''} ${draggingTabId === terminalId ? 'dragging' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', terminalId)
                e.dataTransfer.effectAllowed = 'move'
                onTabDragStart?.(terminalId)
              }}
              onDragEnd={() => onTabDragEnd?.()}
              onClick={() => onTabSelect(terminalId)}
              onContextMenu={event => onTabContextMenu?.(event, terminalId)}
              title={displayName}
              style={tabStyle}
            >
              {terminal.db && <RiDatabase2Line size={12} className="tab-db-icon" aria-label="DB" />}
              {terminal.local && <RiComputerLine size={12} className="tab-local-icon" aria-label="로컬" />}
              {terminal.browser && <RiGlobalLine size={12} className="tab-local-icon" aria-hidden />}
              <span className="split-pane-tab-name" data-tab-label>{displayName}</span>
              {terminal.local && <DevelopmentTabDots tabId={terminalId} />}
              {terminal.local?.cwd && <TabWorktreeBadge cwd={terminal.local.cwd} worktree={worktreeForFolder(terminal.local.cwd)} />}
              {terminal.local && <AgentTabMessages tabId={terminalId} />}
              {terminalId in sessionLogFiles && <span className="tab-log-indicator" role="img" aria-label="로그 저장 중" title={`로그 저장 중: ${sessionLogFiles[terminalId]}`} />}
              {/* Shown on a pane's only tab too: closing it ends the split (removeTerminalFromPane) */}
              <button
                className="split-pane-tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  onTabClose(terminalId)
                }}
                title="탭 닫기"
                aria-label="탭 닫기"
              >
                <RiCloseLine size={16} />
              </button>
            </div>
          )
        })}
      </div>
      {newTabMenu}

      <div className="split-pane-actions">
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
