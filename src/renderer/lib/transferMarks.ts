import type { Transfer } from '../stores/sftpStore'

export type MarkableTransfer = Pick<Transfer, 'id' | 'type' | 'localPath' | 'remotePath' | 'status' | 'error' | 'progress'>

export type TransferMarkState = 'queued' | 'transferring' | 'paused' | 'done' | 'error'

export interface TransferMark {
  direction: 'upload' | 'download'
  state: TransferMarkState
  /** 0..100, while queued / transferring / paused */
  progress?: number
  error?: string
}

type Side = 'local' | 'remote'

const STATE_OF: Record<Transfer['status'], TransferMarkState> = {
  queued: 'queued',
  paused: 'paused',
  active: 'transferring',
  completed: 'done',
  error: 'error'
}

const isFinished = (status: Transfer['status']) => status === 'completed' || status === 'error'

const clampProgress = (value: number) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0)

function markOf(transfer: MarkableTransfer): TransferMark {
  const state = STATE_OF[transfer.status]
  if (state === 'error') return { direction: transfer.type, state, error: transfer.error }
  if (state === 'done') return { direction: transfer.type, state }
  return { direction: transfer.type, state, progress: clampProgress(transfer.progress) }
}

/** Uploads land on the remote side, downloads on the local side */
function targetPathOn(transfer: MarkableTransfer, side: Side): string | undefined {
  if (side === 'remote') return transfer.type === 'upload' ? transfer.remotePath : undefined
  return transfer.type === 'download' ? transfer.localPath : undefined
}

function splitTarget(targetPath: string): { dir: string; name: string } {
  const cut = Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf('\\'))
  return { dir: targetPath.slice(0, cut + 1), name: targetPath.slice(cut + 1) }
}

/** Comparable folder key: no trailing separator; Windows paths case-insensitive with backslashes */
function folderKey(dirPath: string): string {
  const isWindows = /^[A-Za-z]:/.test(dirPath)
  const unified = isWindows ? dirPath.replace(/\//g, '\\').toLowerCase() : dirPath
  return unified.replace(/[\\/]+$/, '')
}

function landsIn(transfer: MarkableTransfer, side: Side, dirKey: string): string | null {
  const target = targetPathOn(transfer, side)
  if (!target) return null
  const { dir, name } = splitTarget(target)
  return name && folderKey(dir) === dirKey ? name : null
}

/**
 * Names in `dirPath` that this session sent there, with direction and state.
 * When the same name was sent more than once the latest transfer wins.
 */
export function transferMarksFor(transfers: readonly MarkableTransfer[], side: Side, dirPath: string): Map<string, TransferMark> {
  const dirKey = folderKey(dirPath)
  const entries = transfers.flatMap(transfer => {
    const name = landsIn(transfer, side, dirKey)
    if (!name) return []
    return [[name, markOf(transfer)] as const]
  })
  return new Map(entries)
}

/** True when a transfer into `dirPath` finished (completed or failed) between two queue snapshots */
export function finishedInto(prev: readonly MarkableTransfer[], next: readonly MarkableTransfer[], side: Side, dirPath: string): boolean {
  const dirKey = folderKey(dirPath)
  const wasFinished = new Set(prev.filter(t => isFinished(t.status)).map(t => t.id))
  return next.some(t => isFinished(t.status) && !wasFinished.has(t.id) && landsIn(t, side, dirKey) !== null)
}

/**
 * True when a transfer into `dirPath` started between two queue snapshots. The target file exists from
 * that moment, so re-reading the list shows its row (and its progress) before the transfer ends.
 */
export function startedInto(prev: readonly MarkableTransfer[], next: readonly MarkableTransfer[], side: Side, dirPath: string): boolean {
  const dirKey = folderKey(dirPath)
  const wasActive = new Set(prev.filter(t => t.status === 'active').map(t => t.id))
  return next.some(t => t.status === 'active' && !wasActive.has(t.id) && landsIn(t, side, dirKey) !== null)
}
