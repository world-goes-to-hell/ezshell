import { useState, type DragEvent, type ReactElement } from 'react'
import {
  RiFolderFill, RiFolderOpenFill, RiServerLine, RiKey2Line, RiRouteLine, RiLockLine, RiCloseLine, RiCheckboxBlankLine,
  RiCheckboxFill, RiCheckboxIndeterminateFill, RiArrowRightSLine, RiArrowDownSLine
} from 'react-icons/ri'
import type { Folder, Session } from '../../stores/sessionStore'
import { folderCheckState, mergeOrder, sessionsUnder, type Anchor, type ImportNode, type ImportResult, type Stage } from '../../lib/externalImport'
import { getDropPosition, type DropPosition } from '../../lib/sessionOrder'

/** Drag data of a folder or session from the imported side */
export const DRAG_TYPE = 'application/x-ezshell-import'

// ---------- Imported side ----------

interface ImportTreeProps {
  result: ImportResult
  selected: ReadonlySet<string>
  duplicates: ReadonlySet<string>
  staged: ReadonlySet<string>
  onToggle: (ids: string[], on: boolean) => void
}

function Check({ state, onClick, label }: { state: 'all' | 'some' | 'none' | 'empty'; onClick: () => void; label: string }) {
  const Icon = state === 'all' ? RiCheckboxFill : state === 'some' ? RiCheckboxIndeterminateFill : RiCheckboxBlankLine
  return (
    <button type="button" className={`xi-check is-${state}`} onClick={onClick} disabled={state === 'empty'} aria-label={label}
      aria-pressed={state === 'all' ? true : state === 'some' ? 'mixed' : false}>
      <Icon size={16} />
    </button>
  )
}

function startDrag(event: DragEvent, node: ImportNode) {
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(node))
  event.dataTransfer.effectAllowed = 'copy'
}

/** The sessions read from another program: checkboxes, marks, and rows to drag across */
export function ImportTree({ result, selected, duplicates, staged, onToggle }: ImportTreeProps) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const toggleOpen = (id: string) => setClosed(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const renderFolder = (folderId: string | null, depth: number, seen: Set<string>): ReactElement[] => {
    const rows: ReactElement[] = []
    for (const folder of result.folders.filter(f => f.parentId === folderId)) {
      if (seen.has(folder.id)) continue
      seen.add(folder.id)
      const state = folderCheckState(result, folder.id, selected)
      const isOpen = !closed.has(folder.id)
      const ids = sessionsUnder(result, folder.id)
      rows.push(
        <div key={folder.id} className="xi-row is-folder" style={{ paddingLeft: 8 + depth * 16 }} draggable={state !== 'empty'}
          onDragStart={(e) => startDrag(e, { type: 'folder', id: folder.id })} title="끌어서 왼쪽 내 세션 폴더에 넣기">
          <button type="button" className="xi-twist" onClick={() => toggleOpen(folder.id)} aria-label={isOpen ? '접기' : '펼치기'}>
            {isOpen ? <RiArrowDownSLine size={14} /> : <RiArrowRightSLine size={14} />}
          </button>
          <Check state={state} onClick={() => onToggle(ids, state !== 'all')} label={`${folder.name} 폴더 선택`} />
          {isOpen ? <RiFolderOpenFill size={15} className="xi-folder-icon" /> : <RiFolderFill size={15} className="xi-folder-icon" />}
          <span className="xi-name">{folder.name}</span>
          <span className="xi-count">{ids.length}</span>
        </div>
      )
      if (isOpen) rows.push(...renderFolder(folder.id, depth + 1, seen))
    }
    for (const session of result.sessions.filter(s => s.folderId === folderId)) {
      const isOn = selected.has(session.id)
      const isStaged = staged.has(session.id)
      rows.push(
        <div key={session.id} className={`xi-row is-session${isStaged ? ' is-staged' : ''}`} style={{ paddingLeft: 30 + depth * 16 }} draggable
          onDragStart={(e) => startDrag(e, { type: 'session', id: session.id })}
          title={`${session.username ? `${session.username}@` : ''}${session.host}:${session.port}`}>
          <Check state={isOn ? 'all' : 'none'} onClick={() => onToggle([session.id], !isOn)} label={`${session.name} 선택`} />
          <RiServerLine size={14} className="xi-session-icon" />
          <span className="xi-name">{session.name}</span>
          <span className="xi-address">{session.username ? `${session.username}@` : ''}{session.host}{session.port !== 22 ? `:${session.port}` : ''}</span>
          <span className="xi-marks">
            {session.hasSavedPassword && <span className="xi-mark is-password" title="원래 프로그램에 비밀번호가 저장돼 있었습니다. 비밀번호는 가져오지 않으니 접속할 때 입력하세요."><RiLockLine size={12} /> 비밀번호 다시 입력</span>}
            {session.authType === 'privateKey' && <span className="xi-mark is-key" title={session.keyNote || session.privateKeyPath}><RiKey2Line size={12} /> 키</span>}
            {session.jump && <span className="xi-mark is-jump" title={`점프 호스트 ${session.jump.username ? `${session.jump.username}@` : ''}${session.jump.host}:${session.jump.port}`}><RiRouteLine size={12} /> 점프</span>}
            {duplicates.has(session.id) && <span className="xi-mark is-dup" title="같은 호스트·포트·계정의 세션이 이미 있습니다">이미 있음</span>}
            {isStaged && <span className="xi-mark is-staged">넣음</span>}
          </span>
        </div>
      )
    }
    return rows
  }

  return <div className="xi-tree" role="tree">{renderFolder(null, 0, new Set())}</div>
}

// ---------- My side ----------

interface MyTreeProps {
  folders: Folder[]
  sessions: Session[]
  stage: Stage
  /** Where "선택 항목 넣기" and "새 폴더" put things (null = top level) */
  target: string | null
  onTarget: (folderId: string | null) => void
  /** Dropped on a folder (or the top), or on a session row: then before or after that session */
  onDrop: (node: ImportNode, folderId: string | null, anchor?: Anchor) => void
  onRemove: (node: ImportNode) => void
}

type Over = { kind: 'folder'; id: string | null } | { kind: 'session'; id: string; position: DropPosition }

function readNode(e: DragEvent): ImportNode | null {
  try {
    const node = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as ImportNode
    return (node.type === 'folder' || node.type === 'session') && typeof node.id === 'string' ? node : null
  } catch {
    return null
  }
}

/**
 * The user's own folders and sessions, with what is staged, in the order they will be saved. A
 * folder (or the top) takes drops into it; a session row takes drops before or after it (top half /
 * bottom half), shown by a line.
 */
export function MyTree({ folders, sessions, stage, target, onTarget, onDrop, onRemove }: MyTreeProps) {
  const [over, setOver] = useState<Over | null>(null)
  const allFolders = [...folders, ...stage.folders]
  const stagedFolders = new Set(stage.folders.map(f => f.id))
  const stagedSessions = new Set(stage.sessions.map(s => s.id))
  const ordered = mergeOrder(sessions, stage.sessions)
  const known = new Set(allFolders.map(f => f.id))

  const accept = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return false
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    return true
  }

  const folderDrop = (folderId: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (accept(e)) setOver({ kind: 'folder', id: folderId })
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => {
      if (!accept(e)) return
      setOver(null)
      const node = readNode(e)
      if (node) onDrop(node, folderId)
    }
  })

  const sessionDrop = (session: Session) => ({
    onDragOver: (e: DragEvent) => {
      if (!accept(e)) return
      const position = getDropPosition(e.currentTarget.getBoundingClientRect(), e.clientY)
      setOver({ kind: 'session', id: session.id, position })
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => {
      if (!accept(e)) return
      const position = getDropPosition(e.currentTarget.getBoundingClientRect(), e.clientY)
      setOver(null)
      const node = readNode(e)
      const folderId = session.folderId && known.has(session.folderId) ? session.folderId : null
      if (node) onDrop(node, folderId, { id: session.id, position })
    }
  })

  const isOverFolder = (id: string | null) => over?.kind === 'folder' && over.id === id

  const renderLevel = (parentId: string | null, depth: number, seen: Set<string>): ReactElement[] => {
    const rows: ReactElement[] = []
    const isTop = (f: Folder) => (parentId === null ? !f.parentId || !known.has(f.parentId) : f.parentId === parentId)
    for (const folder of allFolders.filter(isTop)) {
      if (seen.has(folder.id)) continue
      seen.add(folder.id)
      const isStaged = stagedFolders.has(folder.id)
      rows.push(
        <div key={folder.id} className={`xi-row is-folder is-target${isOverFolder(folder.id) ? ' is-over' : ''}${target === folder.id ? ' is-selected' : ''}${isStaged ? ' is-staged' : ''}`}
          style={{ paddingLeft: 8 + depth * 16 }} onClick={() => onTarget(folder.id)} {...folderDrop(folder.id)}>
          <RiFolderFill size={15} className="xi-folder-icon" />
          <span className="xi-name">{folder.name}</span>
          {isStaged && <span className="xi-mark is-new">새로</span>}
          {isStaged && (
            <button type="button" className="xi-remove" onClick={(e) => { e.stopPropagation(); onRemove({ type: 'folder', id: folder.id }) }} aria-label={`${folder.name} 빼기`}>
              <RiCloseLine size={14} />
            </button>
          )}
        </div>
      )
      rows.push(...renderLevel(folder.id, depth + 1, seen))
    }
    const inHere = ordered.filter(s => (parentId === null ? !s.folderId || !known.has(s.folderId) : s.folderId === parentId))
    for (const session of inHere) {
      const isStaged = stagedSessions.has(session.id)
      const line = over?.kind === 'session' && over.id === session.id ? ` is-drop-${over.position}` : ''
      rows.push(
        <div key={session.id} className={`xi-row is-session is-place${isStaged ? ' is-staged' : ' is-mine'}${line}`} style={{ paddingLeft: 30 + depth * 16 }}
          title="끌어 놓으면 이 세션의 위(앞) 또는 아래(뒤)에 들어갑니다" {...sessionDrop(session)}>
          <RiServerLine size={14} className="xi-session-icon" />
          <span className="xi-name">{session.name}</span>
          {isStaged && <span className="xi-mark is-new">새로</span>}
          {isStaged && (
            <button type="button" className="xi-remove" onClick={() => onRemove({ type: 'session', id: session.id })} aria-label={`${session.name} 빼기`}>
              <RiCloseLine size={14} />
            </button>
          )}
        </div>
      )
    }
    return rows
  }

  return (
    <div className={`xi-tree is-mine${isOverFolder(null) ? ' is-over-root' : ''}`} role="tree" {...folderDrop(null)}>
      <div className={`xi-row is-root is-target${target === null ? ' is-selected' : ''}${isOverFolder(null) ? ' is-over' : ''}`} onClick={() => onTarget(null)}>
        <span className="xi-name">최상위</span>
        <span className="xi-hint">폴더 안이나 세션 사이에 끌어 놓으세요</span>
      </div>
      {renderLevel(null, 0, new Set())}
    </div>
  )
}
