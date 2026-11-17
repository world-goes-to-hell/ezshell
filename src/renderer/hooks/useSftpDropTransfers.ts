import { toast } from '../stores/toastStore'
import { joinChildPath } from '../lib/sftpFileOps'
import { sizesByName, type PendingTransfer } from './useSftpTransferBatch'

interface FileEntry {
  name: string
  type: string
}

interface DropTransferOptions {
  sessionId: string
  localPath: string
  remotePath: string
  localFiles: readonly FileEntry[]
  remoteFiles: readonly FileEntry[]
  /** Starts the transfers (with the overwrite check): useSftpTransferBatch().start */
  startTransfers: (transfers: PendingTransfer[]) => Promise<void> | void
  reloadRemote: () => Promise<void> | void
  reloadLocal: () => Promise<void> | void
}

/**
 * Transfers started by dragging entries from one SFTP list onto the other (or onto a folder row of it).
 * Shared by the SFTP panel and the popped-out SFTP window, which used to lack it.
 */
export function useSftpDropTransfers({ sessionId, localPath, remotePath, localFiles, remoteFiles, startTransfers, reloadRemote, reloadLocal }: DropTransferOptions) {
  /**
   * Entries already in a folder that is not on screen, for the overwrite check of a drop onto a folder row.
   * Returns null (and tells the user) when the folder cannot be read.
   */
  const listEntriesIn = async (side: 'local' | 'remote', dirPath: string): Promise<Map<string, number> | null> => {
    try {
      if (side === 'remote') {
        const entries = await window.electronAPI.sftpList(sessionId, dirPath)
        return sizesByName(entries || [])
      }
      const result = await window.electronAPI.localList(dirPath)
      if (!result.success) throw new Error(result.error)
      return sizesByName(result.files || [])
    } catch (error) {
      toast.error('대상 폴더를 읽을 수 없습니다', `${dirPath}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  // targetDir: a local folder row the remote entries were dropped on (default: the local folder on screen)
  const dropOnLocal = async (fileNames: string[], targetDir?: string) => {
    const localBase = targetDir ?? localPath
    const existing = targetDir ? await listEntriesIn('local', targetDir) : undefined
    if (existing === null) return
    const transfers: PendingTransfer[] = []
    const directories: string[] = []
    for (const fileName of fileNames) {
      const file = remoteFiles.find(f => f.name === fileName)
      if (!file) continue
      if (file.type === 'directory') {
        directories.push(fileName)
      } else if (file.type === 'file') {
        transfers.push({
          type: 'download',
          fileName,
          localPath: joinChildPath(localBase, fileName, 'local'),
          remotePath: joinChildPath(remotePath, fileName, 'remote'),
          targetEntries: existing
        })
      }
    }

    // Folders: main walks the remote folder and queues every file in it
    for (const dirName of directories) {
      const downloadFolder = window.electronAPI.sftpDownloadDirectory
      if (typeof downloadFolder !== 'function') {
        toast.info('폴더 다운로드', '앱을 다시 시작한 뒤에 사용할 수 있습니다')
        break
      }
      try {
        const result = await downloadFolder(sessionId, joinChildPath(remotePath, dirName, 'remote'), joinChildPath(localBase, dirName, 'local'))
        const left = result.skipped.length > 0 ? ` · ${result.skipped.length}개 제외 (링크 또는 이 PC 에서 쓸 수 없는 이름)` : ''
        toast.success('폴더 다운로드 시작', `${dirName}: 파일 ${result.files.toLocaleString()}개${left}`)
      } catch (error) {
        toast.error('폴더 다운로드 실패', `${dirName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    if (transfers.length > 0) {
      await startTransfers(transfers)
    } else if (directories.length > 0) {
      await reloadLocal()
    }
  }

  // targetDir: a remote folder row the local entries were dropped on (default: the remote folder on screen)
  const dropOnRemote = async (fileNames: string[], targetDir?: string) => {
    const remoteBase = targetDir ?? remotePath
    const existing = targetDir ? await listEntriesIn('remote', targetDir) : undefined
    if (existing === null) return
    const transfers: PendingTransfer[] = []
    const directories: string[] = []

    for (const fileName of fileNames) {
      const file = localFiles.find(f => f.name === fileName)
      if (!file) continue
      if (file.type === 'directory') {
        directories.push(fileName)
      } else {
        transfers.push({
          type: 'upload',
          fileName,
          localPath: joinChildPath(localPath, fileName, 'local'),
          remotePath: joinChildPath(remoteBase, fileName, 'remote'),
          targetEntries: existing
        })
      }
    }

    for (const dirName of directories) {
      try {
        const localDir = joinChildPath(localPath, dirName, 'local')
        const remoteDir = joinChildPath(remoteBase, dirName, 'remote')
        await window.electronAPI.sftpUploadDirectory?.(sessionId, localDir, remoteDir)
        toast.success('폴더 업로드 완료', dirName)
      } catch (error) {
        toast.error('폴더 업로드 실패', `${dirName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    if (transfers.length > 0) {
      await startTransfers(transfers)
    } else if (directories.length > 0) {
      await reloadRemote()
    }
  }

  return { dropOnLocal, dropOnRemote }
}
