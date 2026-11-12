import { useEffect, useState } from 'react'
import { RiCloseLine, RiComputerLine, RiFolderOpenLine, RiHistoryLine, RiServerLine, RiSplitCellsHorizontal } from 'react-icons/ri'
import { formatBytes } from '../../lib/mcpLabels'
import { formatClock } from '../../lib/remoteFileText'
import { entryKey, readBackupEntry, type BackupEntry } from '../../lib/backupCompare'
import { toast } from '../../stores/toastStore'
import './RemoteCompare.css'

// A <pre> with megabytes of text makes the panel slow; the editor gets the whole text
const PREVIEW_CHARS = 100_000

interface RemoteBackupPanelProps {
  docId: string
  /** Both kinds of backup, newest first (null while loading) */
  entries: BackupEntry[] | null
  error: string | null
  /** Backup to show selected (the one last compared) */
  selectedKey: string | null
  onSelect: (key: string) => void
  /** Put the backup's text into the editor (nothing is saved until the user saves) */
  onRestore: (content: string) => void
  /** Open the side-by-side comparison with this backup */
  onCompare: (key: string) => void
  onClose: () => void
}

/** Short label of where a backup lives, for the list and the comparison */
export function BackupSourceIcon({ entry, size = 14 }: { entry: BackupEntry; size?: number }) {
  return entry.source === 'app'
    ? <RiComputerLine size={size} className="backup-source-icon is-app" aria-label="앱 백업 (이 PC)" />
    : <RiServerLine size={size} className="backup-source-icon is-server" aria-label="서버의 백업 파일" />
}

/**
 * Copies of the file, newest first: the app's own backups (taken before each save, kept on this PC)
 * and backup files left beside it on the server. Opening one shows its text; it can be compared
 * side by side or replace the editor's text.
 */
export function RemoteBackupPanel({ docId, entries, error, selectedKey, onSelect, onRestore, onCompare, onClose }: RemoteBackupPanelProps) {
  const [preview, setPreview] = useState<{ key: string; content: string } | null>(null)
  const selected = entries?.find(e => entryKey(e) === selectedKey) ?? null

  useEffect(() => {
    if (!selected || preview?.key === entryKey(selected)) return
    let isCurrent = true
    void readBackupEntry(docId, selected).then((result) => {
      if (!isCurrent) return
      if ('content' in result) setPreview({ key: entryKey(selected), content: result.content })
      else toast.error('백업을 열지 못했습니다', result.error)
    })
    return () => { isCurrent = false }
  }, [docId, selected, preview?.key])

  const openFolder = async () => {
    const result = await window.electronAPI.remoteFileOpenBackupFolder?.(docId)
    if (result && !result.success) toast.error('백업 폴더를 열지 못했습니다', result.error)
  }

  const shown = preview && selected && preview.key === entryKey(selected) ? preview : null

  return (
    <aside className="remote-backup-panel" aria-label="백업">
      <div className="remote-backup-header">
        <RiHistoryLine size={15} aria-hidden="true" />
        <span className="remote-backup-title">백업</span>
        <button type="button" className="remote-file-icon-btn" onClick={() => void openFolder()} title="앱 백업 폴더 열기 (이 PC)" aria-label="앱 백업 폴더 열기">
          <RiFolderOpenLine size={15} />
        </button>
        <button type="button" className="remote-file-icon-btn" onClick={onClose} title="닫기" aria-label="백업 닫기">
          <RiCloseLine size={16} />
        </button>
      </div>
      <dl className="backup-legend">
        <div className="backup-legend-row">
          <RiComputerLine size={15} className="backup-source-icon is-app" aria-hidden="true" />
          <dt>앱 백업</dt>
          <dd>저장하기 직전의 서버 내용입니다. 이 PC 에 평문으로 최근 20개를 남깁니다.</dd>
        </div>
        <div className="backup-legend-row">
          <RiServerLine size={15} className="backup-source-icon is-server" aria-hidden="true" />
          <dt>서버 파일</dt>
          <dd>같은 폴더에 있는 <code>이름.bak_날짜</code> 같은 파일입니다.</dd>
        </div>
      </dl>
      {error && <p className="remote-backup-empty">{error}</p>}
      {entries && entries.length === 0 && <p className="remote-backup-empty">아직 백업이 없습니다. 저장하면 생깁니다.</p>}
      <ul className="remote-backup-list">
        {entries?.map(entry => {
          const key = entryKey(entry)
          return (
            <li key={key}>
              <button
                type="button"
                className={`remote-backup-item backup-entry is-${entry.source}${key === selectedKey ? ' is-selected' : ''}`}
                onClick={() => onSelect(key)}
                onDoubleClick={() => onCompare(key)}
                title={entry.source === 'server' ? `서버: ${entry.name}` : '앱 백업 (이 PC)'}
              >
                <BackupSourceIcon entry={entry} />
                <span className="backup-entry-main">
                  <span className="remote-backup-time">
                    {formatClock(entry.time)}
                    {entry.timeFrom === 'modified' && <span className="backup-entry-note">수정 시각</span>}
                  </span>
                  {entry.source === 'server' && <span className="backup-entry-name">{entry.name}</span>}
                </span>
                <span className="remote-backup-size">{formatBytes(entry.size)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {selected && (
        <div className="remote-backup-preview">
          <pre className="remote-backup-text">{shown ? shown.content.slice(0, PREVIEW_CHARS) : '읽는 중…'}</pre>
          {shown && shown.content.length > PREVIEW_CHARS && <p className="remote-backup-hint">앞부분만 표시했습니다. 비교와 바꾸기는 전체 내용으로 합니다.</p>}
          <div className="backup-preview-actions">
            <button type="button" className="btn-primary backup-compare-btn" onClick={() => onCompare(entryKey(selected))}>
              <RiSplitCellsHorizontal size={14} aria-hidden="true" /> 현재와 비교
            </button>
            <button type="button" className="btn-secondary backup-restore-btn" disabled={!shown} onClick={() => shown && onRestore(shown.content)}>
              전체 바꾸기
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}
