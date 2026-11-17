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
 * The folder directly under `dirPath` that a transfer landed somewhere inside (a file of a folder that
 * was sent whole), in the spelling the transfer used. Null when it landed in `dirPath` itself or elsewhere.
 */
function folderUnder(transfer: MarkableTransfer, side: Side, dirPath: string): string | null {
  const target = targetPathOn(transfer, side)
  if (!target) return null
  const isWindows = /^[A-Za-z]:/.test(dirPath)
  const segments = (value: string) => value.split(/[\\/]+/).filter(Boolean)
  const same = (a: string, b: string) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b)
  const base = segments(dirPath)
  const parts = segments(target)
  // base folders + the folder + at least the file name
  if (parts.length < base.length + 2) return null
  return base.every((segment, index) => same(segment, parts[index])) ? parts[base.length] : null
}

/** One mark for a folder from the marks of everything sent into it */
function folderMark(marks: readonly TransferMark[]): TransferMark {
  const { direction } = marks[0]
  const pending = marks.filter(mark => mark.state === 'queued' || mark.state === 'transferring' || mark.state === 'paused')
  if (pending.length > 0) {
    const done = marks.length - pending.length
    const progress = (done * 100 + pending.reduce((sum, mark) => sum + (mark.progress ?? 0), 0)) / marks.length
    const state = pending.some(mark => mark.state === 'transferring') ? 'transferring' : pending.some(mark => mark.state === 'queued') ? 'queued' : 'paused'
    return { direction, state, progress: clampProgress(progress) }
  }
  const failed = marks.filter(mark => mark.state === 'error')
  if (failed.length > 0) return { direction, state: 'error', error: `${marks.length}개 중 ${failed.length}개 실패` }
  return { direction, state: 'done' }
}

/**
 * Names in `dirPath` that this session sent there, with direction and state.
 * A file: its own transfer (when the same name was sent more than once the latest wins).
 * A folder: everything this session sent into it, summed up (transferring until all of it is through).
 */
export function transferMarksFor(transfers: readonly MarkableTransfer[], side: Side, dirPath: string): Map<string, TransferMark> {
  const dirKey = folderKey(dirPath)
  const marks = new Map<string, TransferMark>()
  const inFolders = new Map<string, TransferMark[]>()
  for (const transfer of transfers) {
    const name = landsIn(transfer, side, dirKey)
    if (name) {
      marks.set(name, markOf(transfer))
      continue
    }
    const folder = folderUnder(transfer, side, dirPath)
    if (folder) inFolders.set(folder, [...(inFolders.get(folder) ?? []), markOf(transfer)])
  }
  for (const [folder, sent] of inFolders) {
    if (!marks.has(folder)) marks.set(folder, folderMark(sent))
  }
  return marks
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
