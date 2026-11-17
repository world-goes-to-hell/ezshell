/** Height of the SFTP transfer queue, set by dragging its header (panel and popped-out window alike) */

export const QUEUE_HEIGHT_STORAGE_KEY = 'sftpTransferQueueHeight'
export const DEFAULT_QUEUE_HEIGHT = 120
/** The header plus about one transfer row */
export const MIN_QUEUE_HEIGHT = 60
/** What the rest of the SFTP area keeps: its bar, the path bars and a few file rows */
export const LISTS_MIN_HEIGHT = 130

/** The tallest the queue can be inside a container of this height */
export function maxQueueHeight(containerHeight: number): number {
  return Math.max(MIN_QUEUE_HEIGHT, Math.floor(containerHeight - LISTS_MIN_HEIGHT))
}

/** A dragged height kept between one row and what the container can give */
export function clampQueueHeight(height: number, containerHeight: number): number {
  if (!Number.isFinite(height)) return DEFAULT_QUEUE_HEIGHT
  return Math.round(Math.min(maxQueueHeight(containerHeight), Math.max(MIN_QUEUE_HEIGHT, height)))
}

/** The stored height, or the default for anything unreadable */
export function parseQueueHeight(raw: string | null | undefined): number {
  const value = Number(raw)
  if (!raw || !Number.isFinite(value) || value < MIN_QUEUE_HEIGHT || value > 4000) return DEFAULT_QUEUE_HEIGHT
  return Math.round(value)
}
