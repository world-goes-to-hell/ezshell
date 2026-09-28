import { useState } from 'react'
import { RiDownload2Line, RiUpload2Line, RiCheckLine, RiFolderLine, RiFileTextLine } from 'react-icons/ri'
import { useSessionStore } from '../../stores/sessionStore'
import { useToastStore } from '../../stores/toastStore'
import './SessionBackup.css'

export function SessionBackup() {
  const { sessions, folders } = useSessionStore()
  const addToast = useToastStore(state => state.addToast)
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const [isExporting, setIsExporting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)

  const toggleSessionSelection = (sessionId: string) => {
    const newSelection = new Set(selectedSessions)
    if (newSelection.has(sessionId)) {
      newSelection.delete(sessionId)
    } else {
      newSelection.add(sessionId)
    }
    setSelectedSessions(newSelection)
  }

  const toggleSelectAll = () => {
    if (selectedSessions.size === sessions.length) {
      setSelectedSessions(new Set())
    } else {
      setSelectedSessions(new Set(sessions.map(s => s.id)))
    }
  }

  const handleExport = async () => {
    if (selectedSessions.size === 0) {
      addToast({ type: 'error', title: '선택된 세션이 없습니다' })
      return
    }

    setIsExporting(true)
    try {
      const exportData = {
        sessions: sessions.filter(s => selectedSessions.has(s.id)),
        folders: folders,
        exportDate: new Date().toISOString(),
        version: '1.0'
      }

      const result = await window.electronAPI.exportSessions(exportData)
      if (result.success) {
        addToast({ type: 'success', title: `${selectedSessions.size}개 세션이 내보내졌습니다` })
      } else {
        addToast({ type: 'error', title: '세션 내보내기 실패' })
      }
    } catch (error) {
      console.error('Export error:', error)
      addToast({ type: 'error', title: '세션 내보내기 중 오류 발생' })
    } finally {
      setIsExporting(false)
    }
  }

  const handleImport = async () => {
    setIsImporting(true)
    try {
      const result = await window.electronAPI.importSessions(importMode)
      if (result.success) {
        addToast({ type: 'success', title: `${result.count}개 세션이 가져와졌습니다` })
        // Reload sessions from backend
        await useSessionStore.getState().loadFromBackend()
      } else if (result.cancelled) {
        // User cancelled, do nothing
      } else {
        addToast({ type: 'error', title: '세션 가져오기 실패' })
      }
    } catch (error) {
      console.error('Import error:', error)
      addToast({ type: 'error', title: '세션 가져오기 중 오류 발생' })
    } finally {
      setIsImporting(false)
    }
  }

  // Get folder name by id
  const getFolderName = (folderId?: string): string => {
    if (!folderId) return '폴더 없음'
    const folder = folders.find(f => f.id === folderId)
    return folder?.name || '알 수 없음'
  }

  return (
    <div className="session-backup">
      {/* Export Section */}
      <div className="backup-section">
        <div className="backup-section-header">
          <h4>세션 내보내기</h4>
          <p>선택한 세션을 JSON 파일로 내보냅니다</p>
        </div>

        <div className="session-selection">
          <div className="session-select-header">
            <label className="session-checkbox-label">
              <input
                type="checkbox"
                checked={selectedSessions.size === sessions.length && sessions.length > 0}
                onChange={toggleSelectAll}
                className="session-checkbox"
              />
              <span>모두 선택 ({selectedSessions.size}/{sessions.length})</span>
            </label>
          </div>

          <div className="session-list">
            {sessions.length === 0 ? (
              <div className="session-list-empty">
                <RiFileTextLine size={32} />
                <p>저장된 세션이 없습니다</p>
              </div>
            ) : (
              sessions.map(session => (
                <label key={session.id} className="session-item">
                  <div className="session-item-left">
                    <input
                      type="checkbox"
                      checked={selectedSessions.has(session.id)}
                      onChange={() => toggleSessionSelection(session.id)}
                      className="session-checkbox"
                    />
                    <div className="session-info">
                      <div className="session-name">{session.name}</div>
                      <div className="session-details">
                        {session.username}@{session.host}:{session.port}
                        {session.folderId && (
                          <span className="session-folder">
                            <RiFolderLine size={16} />
                            {getFolderName(session.folderId)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {selectedSessions.has(session.id) && (
                    <RiCheckLine size={20} className="session-check-icon" />
                  )}
                </label>
              ))
            )}
          </div>
        </div>

        <button
          className="backup-btn backup-btn-primary"
          onClick={handleExport}
          disabled={selectedSessions.size === 0 || isExporting}
        >
          <RiDownload2Line size={20} />
          {isExporting ? '내보내는 중...' : `선택한 세션 내보내기 (${selectedSessions.size})`}
        </button>
      </div>

      {/* Import Section */}
      <div className="backup-section">
        <div className="backup-section-header">
          <h4>세션 가져오기</h4>
          <p>JSON 파일에서 세션을 가져옵니다</p>
        </div>

        <div className="import-options">
          <label className="import-option">
            <input
              type="radio"
              name="importMode"
              value="merge"
              checked={importMode === 'merge'}
              onChange={(e) => setImportMode(e.target.value as 'merge' | 'replace')}
            />
            <div className="import-option-content">
              <div className="import-option-title">병합</div>
              <div className="import-option-desc">기존 세션을 유지하고 새 세션을 추가합니다</div>
            </div>
          </label>

          <label className="import-option">
            <input
              type="radio"
              name="importMode"
              value="replace"
              checked={importMode === 'replace'}
              onChange={(e) => setImportMode(e.target.value as 'merge' | 'replace')}
            />
            <div className="import-option-content">
              <div className="import-option-title">교체</div>
              <div className="import-option-desc">기존 세션을 모두 삭제하고 새 세션으로 교체합니다</div>
            </div>
          </label>
        </div>

        <button
          className="backup-btn backup-btn-secondary"
          onClick={handleImport}
          disabled={isImporting}
        >
          <RiUpload2Line size={20} />
          {isImporting ? '가져오는 중...' : '세션 가져오기'}
        </button>
      </div>

      {/* Info Box */}
      <div className="backup-info">
        <h5>주의사항</h5>
        <ul>
          <li>내보낸 파일에는 비밀번호가 포함되어 있습니다. 안전하게 보관하세요.</li>
          <li>교체 모드는 기존 세션을 모두 삭제합니다. 신중하게 선택하세요.</li>
          <li>폴더 정보도 함께 내보내지고 가져와집니다.</li>
        </ul>
      </div>
    </div>
  )
}
