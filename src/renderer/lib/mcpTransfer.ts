import type { McpActivityState, McpTransferProgress } from '../types'
import { formatBytes } from './mcpLabels'
import { formatElapsed, isActiveState } from './mcpActivity'

/** Speed and time left are guesses until the transfer has run this long */
const MIN_ELAPSED_MS = 1000

export interface TransferView {
  status: 'active' | 'done' | 'stopped'
  label: string
  /** 0 to 100, rounded down so 100 shows only when every byte arrived */
  percent: number
  amount: string
  speed: string | null
  remaining: string | null
}

const LABELS = {
  upload: { active: '올리는 중', done: '올림 완료', stopped: '올리기 중단됨' },
  download: { active: '내려받는 중', done: '내려받기 완료', stopped: '내려받기 중단됨' }
} as const

/** What the progress bar of an upload_file / download_file request shows at `now` */
export function describeTransfer(transfer: McpTransferProgress, state: McpActivityState, now: number): TransferView {
  const status = isActiveState(state) ? 'active' : state === 'done' ? 'done' : 'stopped'
  const label = LABELS[transfer.direction === 'download' ? 'download' : 'upload'][status]
  if (status === 'done') {
    return { status, label, percent: 100, amount: formatBytes(transfer.size), speed: null, remaining: null }
  }
  const done = Math.min(transfer.done, transfer.size)
  const percent = transfer.size > 0 ? Math.floor((done / transfer.size) * 100) : 100
  const amount = `${formatBytes(done)} / ${formatBytes(transfer.size)}`
  const elapsed = now - transfer.startedAt
  if (status !== 'active' || elapsed < MIN_ELAPSED_MS || done <= 0) {
    return { status, label, percent, amount, speed: null, remaining: null }
  }
  const perSecond = done / (elapsed / 1000)
  const leftMs = ((transfer.size - done) / perSecond) * 1000
  return { status, label, percent, amount, speed: `${formatBytes(perSecond)}/s`, remaining: formatElapsed(leftMs) }
}
