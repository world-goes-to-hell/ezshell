import { RiLayoutRightLine } from 'react-icons/ri'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'
import './Workspace.css'

/** Status bar entry that shows or hides the work panel (main window only) */
export function WorkspaceIndicator() {
  const isOpen = useWorkspacePanelStore(state => state.isOpen)
  const toggle = useWorkspacePanelStore(state => state.toggle)
  if (typeof window.electronAPI?.agentHistoryList !== 'function') return null
  return (
    <button
      type="button"
      className={`workspace-indicator${isOpen ? ' is-open' : ''}`}
      onClick={toggle}
      aria-pressed={isOpen}
      title={isOpen ? '작업 공간 닫기' : '작업 공간 열기 (로컬 셸 작업: 대화 기록)'}
    >
      <RiLayoutRightLine size={14} aria-hidden="true" />
      <span>작업 공간</span>
    </button>
  )
}
