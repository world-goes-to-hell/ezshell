import { useMemo, useState, type JSX, type KeyboardEvent } from 'react'
import { RiArrowDownSFill, RiArrowRightSFill, RiFolderFill, RiHome4Line } from 'react-icons/ri'
import type { Folder } from '../../stores/sessionStore'
import { ancestorIds, groupFoldersByParent } from '../../lib/folderTree'
import './FolderTree.css'

interface FolderTreeProps {
  folders: Folder[]
  /** Folder shown with the badge (the current location, or the current choice); undefined = top level */
  markedFolderId?: string
  /** Badge text on the marked row, e.g. "현재" or "선택됨" */
  markLabel: string
  /** Label of the top-level row */
  rootLabel: string
  /** Whether the marked row can be picked (a "move to" menu skips it: it is where the session already is) */
  canPickMarked?: boolean
  onPick: (folderId: string | undefined) => void
}

/**
 * Folder tree with a top-level row, used by the sidebar's "폴더로 이동" panel and the connection form's
 * folder picker. Opens down to the marked folder. Rows take keyboard focus: Enter / Space pick,
 * → / ← expand / collapse.
 */
export function FolderTree({ folders, markedFolderId, markLabel, rootLabel, canPickMarked = false, onPick }: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => ancestorIds(folders, markedFolderId))
  const childrenOf = useMemo(() => groupFoldersByParent(folders), [folders])

  const setFolderExpanded = (folderId: string, value: boolean) => {
    setExpanded(prev => {
      if (prev.has(folderId) === value) return prev
      const next = new Set(prev)
      if (value) next.add(folderId)
      else next.delete(folderId)
      return next
    })
  }

  const pick = (folderId: string | undefined, isMarked: boolean) => {
    if (isMarked && !canPickMarked) return
    onPick(folderId)
  }

  const rowKeyDown = (e: KeyboardEvent, folderId: string | undefined, isMarked: boolean, hasChildren: boolean) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(folderId, isMarked)
    } else if (folderId && hasChildren && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault()
      setFolderExpanded(folderId, e.key === 'ArrowRight')
    }
  }

  const row = (
    folderId: string | undefined,
    depth: number,
    icon: JSX.Element,
    name: string,
    toggle: JSX.Element | null,
    hasChildren: boolean,
    isExpanded: boolean
  ) => {
    const isMarked = folderId === markedFolderId
    const isDisabled = isMarked && !canPickMarked
    return (
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isMarked}
        aria-disabled={isDisabled || undefined}
        className={`folder-tree-item ${isMarked ? 'is-marked' : ''} ${isDisabled ? 'is-disabled' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => pick(folderId, isMarked)}
        onKeyDown={e => rowKeyDown(e, folderId, isMarked, hasChildren)}
      >
        {toggle ?? <span className="folder-tree-toggle" aria-hidden="true" />}
        {icon}
        <span className="folder-tree-name">{name}</span>
        {isMarked && <span className="folder-tree-badge">{markLabel}</span>}
      </div>
    )
  }

  const renderLevel = (parentId: string | undefined, depth: number): JSX.Element[] =>
    (childrenOf.get(parentId) ?? []).map(folder => {
      const hasChildren = (childrenOf.get(folder.id) ?? []).length > 0
      const isExpanded = expanded.has(folder.id)
      const toggle = hasChildren ? (
        <button
          type="button"
          className="folder-tree-toggle"
          aria-label={isExpanded ? '접기' : '펼치기'}
          tabIndex={-1}
          onClick={e => {
            e.stopPropagation()
            setFolderExpanded(folder.id, !isExpanded)
          }}
        >
          {isExpanded ? <RiArrowDownSFill size={16} /> : <RiArrowRightSFill size={16} />}
        </button>
      ) : null
      const icon = (
        <RiFolderFill size={16} className="folder-tree-icon" style={folder.backgroundColor ? { color: folder.backgroundColor } : undefined} />
      )
      return (
        <div key={folder.id} role="none">
          {row(folder.id, depth, icon, folder.name, toggle, hasChildren, isExpanded)}
          {hasChildren && isExpanded && <div role="group">{renderLevel(folder.id, depth + 1)}</div>}
        </div>
      )
    })

  return (
    <>
      {row(undefined, 0, <RiHome4Line size={16} className="folder-tree-icon is-root" />, rootLabel, null, false, false)}
      {renderLevel(undefined, 0)}
    </>
  )
}
