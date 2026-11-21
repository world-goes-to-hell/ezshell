import { useEffect, useState } from 'react'
import { RiArrowRightSLine, RiCloseLine, RiComputerLine, RiFolderOpenLine, RiGitCommitLine, RiHistoryLine, RiServerLine, RiSplitCellsHorizontal } from 'react-icons/ri'
import { formatBytes } from '../../lib/mcpLabels'
import { formatClock } from '../../lib/remoteFileText'
import { entryKey, gitRevisionLabel, readBackupEntry, type BackupEntry } from '../../lib/backupCompare'
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
  /** A file on this PC: the list holds its Git revisions. */
  isLocal?: boolean
}

/** Short label of where a backup lives, for the list and the comparison */
export function BackupSourceIcon({ entry, size = 14 }: { entry: BackupEntry; size?: number }) {
  if (entry.timeFrom === 'git') return <RiGitCommitLine size={size} className="backup-source-icon is-git" aria-label="Git 에 커밋된 내용" />
  return entry.source === 'app'
    ? <RiComputerLine size={size} className="backup-source-icon is-app" aria-label="앱 백업 (이 PC)" />
    : <RiServerLine size={size} className="backup-source-icon is-server" aria-label="서버의 백업 파일" />
}

/**
 * Copies of the file, newest first: the app's own backups (taken before each save, kept on this PC)
 * and backup files left beside it on the server. Opening one shows its text; it can be compared
 * side by side or replace the editor's text.
 */
export function RemoteBackupPanel({ docId, entries, error, selectedKey, onSelect, onRestore, onCompare, onClose, isLocal = false }: RemoteBackupPanelProps) {
  const [preview, setPreview] = useState<({ key: string } & ({ content: string } | { error: string })) | null>(null)
  const selected = entries?.find(e => entryKey(e) === selectedKey) ?? null

  useEffect(() => {
    if (!selected || preview?.key === entryKey(selected)) return
    let isCurrent = true
    void readBackupEntry(docId, selected).then((result) => {
      if (!isCurrent) return
      setPreview({ key: entryKey(selected), ...result })
    })
    return () => { isCurrent = false }
  }, [docId, selected, preview?.key])

  const openFolder = async () => {
    const result = await window.electronAPI.remoteFileOpenBackupFolder?.(docId)
    if (result && !result.success) toast.error('백업 폴더를 열지 못했습니다', result.error)
  }

  const shown = preview && selected && preview.key === entryKey(selected) ? preview : null
  const content = shown && 'content' in shown ? shown.content : null
  const panelTitle = isLocal ? 'Git 비교' : '백업'

  return (
    <aside className="remote-backup-panel" aria-label={panelTitle}>
      <div className={`remote-backup-header${isLocal ? ' is-git-compare' : ''}`}>
        {isLocal
          ? <RiGitCommitLine size={15} className="backup-source-icon is-git" aria-hidden="true" />
          : <RiHistoryLine size={15} aria-hidden="true" />}
        {isLocal ? (
          <div className="backup-git-heading">
            <span className="remote-backup-title">{panelTitle}</span>
            <p className="backup-git-description">이 파일의 커밋을 선택해 현재 내용과 비교합니다.</p>
          </div>
        ) : <span className="remote-backup-title">{panelTitle}</span>}
        {!isLocal && (
          <button type="button" className="remote-file-icon-btn" onClick={() => void openFolder()} title="앱 백업 폴더 열기 (이 PC)" aria-label="앱 백업 폴더 열기">
            <RiFolderOpenLine size={15} />
          </button>
        )}
        <button type="button" className="remote-file-icon-btn" onClick={onClose} title="닫기" aria-label={`${panelTitle} 닫기`}>
          <RiCloseLine size={16} />
        </button>
      </div>
      {!isLocal && (
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
      )}
      {error && <p className="remote-backup-empty">{error}</p>}
      {!entries && !error && <p className="remote-backup-empty" role="status">{isLocal ? 'Git 이력을 불러오는 중…' : '백업을 불러오는 중…'}</p>}
      {entries?.length === 0 && !error && <p className="remote-backup-empty">{isLocal ? '이 파일의 Git 커밋 이력이 없습니다.' : '아직 백업이 없습니다. 저장하면 생깁니다.'}</p>}
      <ul className="remote-backup-list">
        {entries?.map(entry => {
          const key = entryKey(entry)
          const isGit = entry.timeFrom === 'git'
          const isHead = isGit && entry.name === 'HEAD'
          const gitTitle = entry.deleted ? '파일 삭제' : entry.subject
          return (
            <li key={key}>
              <button
                type="button"
                className={`remote-backup-item backup-entry is-${entry.source}${isGit ? ' is-git' : ''}${key === selectedKey ? ' is-selected' : ''}`}
                onClick={() => onSelect(key)}
                onDoubleClick={() => onCompare(key)}
                title={isHead ? '현재 체크아웃한 커밋 (HEAD)' : isGit ? [entry.name, gitTitle].filter(Boolean).join(' · ') : entry.source === 'server' ? `서버: ${entry.name}` : '앱 백업 (이 PC)'}
              >
                <BackupSourceIcon entry={entry} />
                <span className="backup-entry-main">
                  {isGit && (
                    <span className="backup-git-revision">
                      <span className={isHead ? 'backup-head-label' : 'backup-entry-name'}>{gitRevisionLabel(entry)}</span>
                      <span className="backup-git-subject">{isHead ? '현재 기준 버전' : gitTitle || '제목 없는 커밋'}</span>
                    </span>
                  )}
                  <span className="remote-backup-time">
                    {formatClock(entry.time)}
                    {entry.timeFrom === 'modified' && <span className="backup-entry-note">수정 시각</span>}
                  </span>
                  {!isGit && entry.source === 'server' && <span className="backup-entry-name">{entry.name}</span>}
                </span>
                {entry.size !== undefined && <span className="remote-backup-size">{formatBytes(entry.size)}</span>}
                {isGit && <RiArrowRightSLine size={15} className="backup-entry-chevron" aria-hidden="true" />}
              </button>
            </li>
          )
        })}
      </ul>
      {selected && (
        <div className="remote-backup-preview">
          <pre className="remote-backup-text">{shown && 'error' in shown ? shown.error : content === null ? '읽는 중…' : selected.deleted ? '이 커밋에서 파일이 삭제되었습니다.' : content.slice(0, PREVIEW_CHARS)}</pre>
          {content !== null && content.length > PREVIEW_CHARS && <p className="remote-backup-hint">앞부분만 표시했습니다. 비교와 바꾸기는 전체 내용으로 합니다.</p>}
          <div className="backup-preview-actions">
            <button type="button" className="btn-primary backup-compare-btn" onClick={() => onCompare(entryKey(selected))}>
              <RiSplitCellsHorizontal size={14} aria-hidden="true" /> 현재와 비교
            </button>
            <button type="button" className="btn-secondary backup-restore-btn" disabled={content === null} onClick={() => content !== null && onRestore(content)}>
              전체 바꾸기
            </button>
          </div>
        </div>
      )}
    </aside>
  )
}
