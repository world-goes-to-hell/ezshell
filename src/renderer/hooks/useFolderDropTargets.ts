import { useEffect, useState } from 'react'
import type React from 'react'

type PaneType = 'local' | 'remote'

interface ActiveDrag {
  type: PaneType
  sessionId: string
  /** Folder the dragged entries are listed in */
  dirPath: string
  fileNames: string[]
}

/** MIME type of the drag payload every file list sets on dragstart */
export const FILE_LIST_DRAG_TYPE = 'application/json'

// dataTransfer cannot be read during dragover, so the drag started by any file list in this window
// is kept here. Split panes can show two sessions' SFTP panels at once, so the session and folder
// are recorded too: entries are only ever moved or transferred within their own session.
let activeDrag: ActiveDrag | null = null

const clearActiveDrag = () => { activeDrag = null }

interface Options {
  type: PaneType
  sessionId: string
  /** Folder this list shows */
  dirPath: string
  /** Drop from this same list onto a folder: move the entries there */
  onMoveInto?: (names: string[], targetDir: string) => void
  /** Drop from the other list of the same session onto a folder: transfer the entries into that folder */
  onTransferInto?: (names: string[], targetDir: string) => void
  /** A folder row took over the drag (entered or dropped): the list-wide highlight should go */
  onRowActivity?: () => void
}

/**
 * Folder rows (and "..") of a file list as drop targets.
 * Same list = move (dropEffect "move"), other list of the same session = upload/download into that folder ("copy").
 */
export function useFolderDropTargets({ type, sessionId, dirPath, onMoveInto, onTransferInto, onRowActivity }: Options) {
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null)

  // dragend fires on the source row only, and not at all when that row unmounts mid-drag (list refresh).
  // Clearing on the window keeps a stale drag from being mistaken for a later one.
  useEffect(() => {
    const clear = () => {
      clearActiveDrag()
      setDropTargetKey(null)
    }
    window.addEventListener('dragend', clear)
    return () => window.removeEventListener('dragend', clear)
  }, [])

  const startDrag = (fileNames: string[]) => {
    activeDrag = { type, sessionId, dirPath, fileNames }
  }

  const endDrag = () => {
    clearActiveDrag()
    setDropTargetKey(null)
  }

  /** The drag carries this app's file list payload (not files from Explorer) */
  const isFileListDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(FILE_LIST_DRAG_TYPE) && !e.dataTransfer.types.includes('Files')

  /** A drag that started in this same list (such drops on empty space do nothing) */
  const isDraggingWithinList = () =>
    activeDrag !== null && activeDrag.type === type && activeDrag.sessionId === sessionId && activeDrag.dirPath === dirPath

  /** The drag may be dropped onto this list at all: same session, and not another folder's listing of the same side */
  const isDragFromThisSession = () =>
    activeDrag !== null && activeDrag.sessionId === sessionId && (activeDrag.type !== type || activeDrag.dirPath === dirPath)

  /**
   * Handlers for one folder row. `key` identifies the row for highlighting; `ownName` is the row's
   * own entry name, so a folder cannot be dropped onto itself.
   */
  const rowDropProps = (key: string, targetDir: string | null, ownName?: string) => {
    const accepts = (e: React.DragEvent) => {
      if (!activeDrag || !targetDir || !isFileListDrag(e) || !isDragFromThisSession()) return false
      const sameList = activeDrag.type === type
      if (sameList && ownName !== undefined && activeDrag.fileNames.includes(ownName)) return false
      return sameList ? Boolean(onMoveInto) : Boolean(onTransferInto)
    }

    return {
      onDragOver: (e: React.DragEvent) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = activeDrag!.type === type ? 'move' : 'copy'
        if (dropTargetKey !== key) setDropTargetKey(key)
        onRowActivity?.()
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDropTargetKey(current => (current === key ? null : current))
      },
      onDrop: (e: React.DragEvent) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.stopPropagation()
        const drag = activeDrag!
        endDrag()
        onRowActivity?.()
        if (drag.type === type) onMoveInto?.(drag.fileNames, targetDir!)
        else onTransferInto?.(drag.fileNames, targetDir!)
      }
    }
  }

  return { dropTargetKey, startDrag, endDrag, isDraggingWithinList, isDragFromThisSession, rowDropProps }
}
