import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileItem } from '../stores/sftpStore'
import type { OverwriteAction } from '../components/Sftp/OverwriteModal'
import { runTransferBatch, resolveTarget, type OverwriteAnswer } from '../lib/transferBatch'
import { toast } from '../stores/toastStore'

export interface PendingTransfer {
  type: 'upload' | 'download'
  fileName: string
  localPath: string
  remotePath: string
  /** Sizes by name of what is already in the target folder, when it is not the folder on screen (drop on a folder row) */
  targetEntries?: Map<string, number>
}

interface Options {
  sessionId: string
  localFiles: FileItem[]
  remoteFiles: FileItem[]
  /** Called once the batch has been queued (or cancelled) */
  onDone: () => Promise<void> | void
}

export function sizesByName(files: ReadonlyArray<{ name: string; size?: number }>): Map<string, number> {
  return new Map(files.map(file => [file.name, file.size ?? -1]))
}

/**
 * Overwrite dialog as a promise, so a batch can wait for the answer in a plain loop.
 * Closing the dialog (or unmounting) answers null.
 */
function useOverwritePrompt() {
  const [fileName, setFileName] = useState<string | null>(null)
  const resolveRef = useRef<((answer: OverwriteAnswer | null) => void) | null>(null)

  const settle = useCallback((answer: OverwriteAnswer | null) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setFileName(null)
    resolve?.(answer)
  }, [])

  const ask = useCallback((name: string) => new Promise<OverwriteAnswer | null>(resolve => {
    resolveRef.current?.(null)
    resolveRef.current = resolve
    setFileName(name)
  }), [])

  useEffect(() => () => resolveRef.current?.(null), [])

  const modalProps = {
    open: fileName !== null,
    fileName: fileName ?? '',
    onClose: () => settle(null),
    onConfirm: (action: OverwriteAction, applyToAll: boolean) => settle({ action, applyToAll })
  }
  return { ask, modalProps }
}

/**
 * Queues multi-file uploads/downloads, asking about each name that already exists in the target folder.
 */
export function useSftpTransferBatch({ sessionId, localFiles, remoteFiles, onDone }: Options) {
  const prompt = useOverwritePrompt()
  // The batch can wait on the dialog across renders; refresh with the paths of the latest render
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const start = async (transfers: PendingTransfer[]) => {
    if (transfers.length === 0) return
    const onScreen = {
      upload: sizesByName(remoteFiles),
      download: sizesByName(localFiles)
    }
    const targetEntriesOf = (transfer: PendingTransfer) => transfer.targetEntries ?? onScreen[transfer.type]
    // Names this batch puts into the target folder, so a renamed copy never lands on another file of the batch
    let reserved: ReadonlySet<string> = new Set(transfers.map(transfer => transfer.fileName))

    const queue = async (transfer: PendingTransfer, action: OverwriteAction) => {
      const source = (transfer.type === 'upload' ? localFiles : remoteFiles).find(f => f.name === transfer.fileName)
      const targetPath = resolveTarget({
        fileName: transfer.fileName,
        plannedTarget: transfer.type === 'upload' ? transfer.remotePath : transfer.localPath,
        sourceSize: source?.size,
        existing: targetEntriesOf(transfer)
      }, action, reserved)
      if (!targetPath) return
      reserved = new Set([...reserved, baseName(targetPath)])

      try {
        if (transfer.type === 'upload') {
          await window.electronAPI.sftpQueueUpload(sessionId, transfer.localPath, targetPath)
        } else {
          await window.electronAPI.sftpQueueDownload(sessionId, transfer.remotePath, targetPath)
        }
      } catch (error) {
        console.error('Transfer failed:', error)
        toast.error('전송 실패', `${transfer.fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    const result = await runTransferBatch(transfers, {
      hasConflict: transfer => targetEntriesOf(transfer).has(transfer.fileName),
      ask: transfer => prompt.ask(transfer.fileName),
      run: queue
    })
    if (result.cancelled) {
      toast.info('전송 취소', `${transfers.length - result.processed}개 파일은 전송하지 않았습니다`)
    }
    await onDoneRef.current()
  }

  return { start, overwriteModalProps: prompt.modalProps }
}

function baseName(filePath: string): string {
  return filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
}
