import { useEffect, useMemo, useRef, useState } from 'react'
import { RiArrowDownSLine, RiArrowRightSLine, RiFolderLine } from 'react-icons/ri'
import { buildBackupRows, checkState, toggleMany, type CheckState } from '../../lib/backupTree'

interface TreeFolder {
  id: string
  name: string
  parentId?: string
}

interface TreeSession {
  id: string
  name?: string
  host: string
  port?: number
  username: string
  folderId?: string
}

interface BackupSessionTreeProps {
  folders: readonly TreeFolder[]
  sessions: readonly TreeSession[]
  selected: ReadonlySet<string>
  onChange: (selected: Set<string>) => void
}

/** A checkbox that can also show "some of them" (the indeterminate state has no HTML attribute) */
function TriCheckbox({ state, onToggle, label }: { state: CheckState; onToggle: () => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      className="session-checkbox"
      checked={state === 'all'}
      onChange={onToggle}
      aria-label={label}
    />
  )
}

/** The sessions to export, grouped by folder: one checkbox picks a whole folder */
export function BackupSessionTree({ folders, sessions, selected, onChange }: BackupSessionTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const rows = useMemo(() => buildBackupRows(folders, sessions, collapsed), [folders, sessions, collapsed])

  const toggleCollapsed = (folderId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  return (
    <div className="backup-tree" role="tree" aria-label="내보낼 세션">
      {rows.map(row => {
        const indent = { paddingLeft: 8 + row.depth * 18 }
        if (row.kind === 'folder') {
          const state = checkState(row.sessionIds, selected)
          const picked = row.sessionIds.filter(id => selected.has(id)).length
          const isCollapsed = collapsed.has(row.id)
          const Arrow = isCollapsed ? RiArrowRightSLine : RiArrowDownSLine
          return (
            <div key={`folder-${row.id}`} className="backup-tree-row is-folder" style={indent} role="treeitem" aria-expanded={!isCollapsed}>
              <button
                type="button"
                className="backup-tree-arrow"
                onClick={() => toggleCollapsed(row.id)}
                aria-label={isCollapsed ? `${row.name} 펼치기` : `${row.name} 접기`}
              >
                <Arrow size={16} />
              </button>
              <TriCheckbox state={state} onToggle={() => onChange(toggleMany(row.sessionIds, selected))} label={`${row.name} 폴더 전체 선택`} />
              <button type="button" className="backup-tree-folder" onClick={() => toggleCollapsed(row.id)}>
                <RiFolderLine size={15} />
                <span className="backup-tree-name">{row.name}</span>
              </button>
              <span className="backup-tree-count">{picked}/{row.sessionIds.length}</span>
            </div>
          )
        }
        const { session } = row
        const isSelected = selected.has(session.id)
        return (
          <label key={`session-${session.id}`} className={`backup-tree-row is-session ${isSelected ? 'is-selected' : ''}`} style={indent} role="treeitem">
            <span className="backup-tree-arrow" aria-hidden="true" />
            <input
              type="checkbox"
              className="session-checkbox"
              checked={isSelected}
              onChange={() => onChange(toggleMany([session.id], selected))}
            />
            <span className="backup-tree-name">{session.name || `${session.username}@${session.host}`}</span>
            <span className="backup-tree-address">{session.username}@{session.host}:{session.port ?? 22}</span>
          </label>
        )
      })}
    </div>
  )
}
