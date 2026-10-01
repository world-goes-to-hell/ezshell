import { useId, useRef } from 'react'
import { RiArrowDownSLine, RiArrowUpSLine, RiFolderFill, RiHome4Line } from 'react-icons/ri'
import type { Folder } from '../../stores/sessionStore'
import { FolderTree } from '../FolderTree/FolderTree'
import { getFolderPath } from '../../lib/folderPath'
import './FolderPicker.css'

interface FolderPickerProps {
  folders: Folder[]
  /** Chosen folder; undefined or '' = top level */
  value?: string
  onChange: (folderId: string | undefined) => void
  /** Controlled so the dialog can let Esc close the tree instead of the whole form */
  open: boolean
  onOpenChange: (open: boolean) => void
}

const ROOT_LABEL = '폴더 없음 (최상위)'

/**
 * Connection form folder field: a button showing the chosen folder's path; it unfolds the same folder
 * tree as the sidebar's "폴더로 이동" right below it (inline, so the scrolling dialog never clips it).
 */
export function FolderPicker({ folders, value, onChange, open, onOpenChange }: FolderPickerProps) {
  const panelId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const chosen = value ? folders.find(folder => folder.id === value) : undefined
  // A folder deleted while the form was open falls back to the top level
  const label = chosen ? getFolderPath(folders, chosen.id) : ROOT_LABEL

  const pick = (folderId: string | undefined) => {
    onChange(folderId)
    onOpenChange(false)
    triggerRef.current?.focus()
  }

  return (
    <div className={`folder-picker ${open ? 'is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="folder-picker-trigger"
        aria-haspopup="tree"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`폴더: ${label}`}
        onClick={() => onOpenChange(!open)}
      >
        {chosen ? (
          <RiFolderFill size={16} className="folder-picker-icon" style={chosen.backgroundColor ? { color: chosen.backgroundColor } : undefined} />
        ) : (
          <RiHome4Line size={16} className="folder-picker-icon is-root" />
        )}
        <span className="folder-picker-label" title={label}>{label}</span>
        {open ? <RiArrowUpSLine size={18} /> : <RiArrowDownSLine size={18} />}
      </button>

      {open && (
        <div id={panelId} className="folder-picker-panel" role="tree" aria-label="폴더 선택">
          <FolderTree
            folders={folders}
            markedFolderId={chosen?.id}
            markLabel="선택됨"
            rootLabel={ROOT_LABEL}
            canPickMarked
            onPick={pick}
          />
        </div>
      )}
    </div>
  )
}
