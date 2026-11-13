import type { QrMatrix } from '../types'

/** Cells of blank space around the code, which scanners need */
export const QR_QUIET_ZONE = 4

/** The dark cells of a QR code as one SVG path (each cell a 1x1 square, runs of cells joined) */
export function qrPath(matrix: QrMatrix): string {
  const { size, cells } = matrix
  if (!Number.isInteger(size) || size <= 0 || cells.length !== size * size) return ''
  const parts: string[] = []
  for (let row = 0; row < size; row++) {
    let start = -1
    for (let column = 0; column <= size; column++) {
      const isDark = column < size && cells[row * size + column] === 1
      if (isDark && start < 0) start = column
      if (!isDark && start >= 0) {
        parts.push(`M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${column - start}v1h-${column - start}z`)
        start = -1
      }
    }
  }
  return parts.join('')
}

/** "1:05" for the time a one-time code has left */
export function remainingLabel(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
