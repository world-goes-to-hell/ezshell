import { useCallback, useEffect, useState } from 'react'
import { RiCloseLine, RiFolderOpenLine, RiHistoryLine } from 'react-icons/ri'
import type { RemoteFileBackup } from '../../types'
import { formatBytes } from '../../lib/mcpLabels'
import { formatClock } from '../../lib/remoteFileText'
import { toast } from '../../stores/toastStore'

// A <pre> with megabytes of text makes the panel slow; the editor gets the whole text
const PREVIEW_CHARS = 100_000

interface RemoteBackupPanelProps {
  docId: string
  /** Changes after every save, so the list is read again */
  version: number
  /** Put the backup's text into the editor (nothing is saved until the user saves) */
  onRestore: (content: string, backup: RemoteFileBackup) => void
  onClose: () => void
}

/** Copies taken before each save, newest first. Opening one shows its text; it can replace the editor's. */
export function RemoteBackupPanel({ docId, version, onRestore, onClose }: RemoteBackupPanelProps) {
  const [backups, setBackups] = useState<RemoteFileBackup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ backup: RemoteFileBackup; content: string } | null>(null)

  const refresh = useCallback(async () => {
    const result = await window.electronAPI.remoteFileBackups?.(docId)
    if (!result) return
    if (result.success) {
      setBackups(result.backups)
      setError(null)
    } else {
      setError(result.error)
    }
  }, [docId])

  useEffect(() => { void refresh() }, [refresh, version])

  const open = async (backup: RemoteFileBackup) => {
    const result = await window.electronAPI.remoteFileReadBackup?.(docId, backup.name)
    if (!result) return
    if (result.success) setSelected({ backup, content: result.content })
    else toast.error('백업을 열지 못했습니다', result.error)
  }

  const openFolder = async () => {
    const result = await window.electronAPI.remoteFileOpenBackupFolder?.(docId)
    if (result && !result.success) toast.error('백업 폴더를 열지 못했습니다', result.error)
  }

  return (
    <aside className="remote-backup-panel" aria-label="백업">
      <div className="remote-backup-header">
        <RiHistoryLine size={15} aria-hidden="true" />
        <span className="remote-backup-title">백업</span>
        <button type="button" className="remote-file-icon-btn" onClick={() => void openFolder()} title="백업 폴더 열기" aria-label="백업 폴더 열기">
          <RiFolderOpenLine size={15} />
        </button>
        <button type="button" className="remote-file-icon-btn" onClick={onClose} title="닫기" aria-label="백업 닫기">
          <RiCloseLine size={16} />
        </button>
      </div>
      <p className="remote-backup-hint">저장할 때마다 저장 직전의 서버 내용을 PC 에 평문으로 남깁니다 (파일마다 최근 20개). 비밀번호가 든 파일이면 백업 폴더도 조심해서 다뤄 주세요.</p>
      {error && <p className="remote-backup-empty">{error}</p>}
      {backups && backups.length === 0 && <p className="remote-backup-empty">아직 백업이 없습니다. 저장하면 생깁니다.</p>}
      <ul className="remote-backup-list">
        {backups?.map(backup => (
          <li key={backup.name}>
            <button
              type="button"
              className={`remote-backup-item${selected?.backup.name === backup.name ? ' is-selected' : ''}`}
              onClick={() => void open(backup)}
            >
              <span className="remote-backup-time">{formatClock(backup.createdAt)}</span>
              <span className="remote-backup-size">{formatBytes(backup.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="remote-backup-preview">
          <pre className="remote-backup-text">{selected.content.slice(0, PREVIEW_CHARS)}</pre>
          {selected.content.length > PREVIEW_CHARS && <p className="remote-backup-hint">앞부분만 표시했습니다. 바꾸기는 전체 내용으로 합니다.</p>}
          <button type="button" className="btn-primary remote-backup-restore" onClick={() => onRestore(selected.content, selected.backup)}>
            이 내용으로 편집기 바꾸기
          </button>
        </div>
      )}
    </aside>
  )
}
