import { useState } from 'react'
import { useSftpStore, type FileItem } from '../stores/sftpStore'
import { renameEntry, createFolder, trashLocalSelection, moveEntries, moveDepsFor, type PaneSide } from '../lib/sftpFileOps'

interface Params {
  sessionId: string
  localPath: string
  remotePath: string
  localFiles: FileItem[]
  selectedLocal: Set<string>
  reloadLocal: () => Promise<void>
  reloadRemote: () => Promise<void>
  clearLocalSelection: () => void
}

/**
 * Rename / new folder / Ctrl+L wiring shared by the docked SFTP panel and the SFTP window.
 * Spread `local` / `remote` onto the matching FileList and pass `pathEditRequest` to its PathBar.
 */
export function useSftpPaneActions(params: Params) {
  const { sessionId, localPath, remotePath, reloadLocal, reloadRemote } = params
  const [pathEditRequest, setPathEditRequest] = useState<Record<PaneSide, number>>({ local: 0, remote: 0 })

  const dirOf = (side: PaneSide) => (side === 'local' ? localPath : remotePath)
  const reload = (side: PaneSide) => (side === 'local' ? reloadLocal() : reloadRemote())

  const paneProps = (side: PaneSide) => ({
    onRename: async (oldName: string, newName: string) => {
      const renamed = await renameEntry({ side, sessionId, dirPath: dirOf(side), oldName, newName })
      if (renamed) await reload(side)
      return renamed
    },
    onCreateFolder: async (name: string) => {
      const created = await createFolder({ side, sessionId, dirPath: dirOf(side), name })
      if (created) await reload(side)
      return created
    },
    // Drag and drop inside one list: move entries into a folder row or ".." (asks first)
    onMoveInto: async (names: string[], targetDir: string) => {
      const result = await moveEntries({ side, dirPath: dirOf(side), names, targetDir }, moveDepsFor(side, sessionId))
      if (result.moved.length === 0 && result.failed === 0) return
      // Moved names must not stay selected: a later file with the same name would appear pre-selected
      const store = useSftpStore.getState()
      if (side === 'local') store.clearLocalSelection(sessionId)
      else store.clearRemoteSelection(sessionId)
      // Refresh on failures too: they often mean the listing on screen is stale
      await reload(side)
    },
    onFocusPath: () => setPathEditRequest(prev => ({ ...prev, [side]: prev[side] + 1 }))
  })

  const deleteLocal = async () => {
    const changed = await trashLocalSelection(localPath, params.selectedLocal, params.localFiles)
    if (changed) {
      params.clearLocalSelection()
      await reloadLocal()
    }
  }

  return { local: paneProps('local'), remote: paneProps('remote'), pathEditRequest, deleteLocal }
}
