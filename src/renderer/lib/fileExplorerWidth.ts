// Width of the file explorer drawer on the left of the terminal.
// Stored per viewer in localStorage; the drag handle clamps against the terminal body width.

export const FILE_EXPLORER_DEFAULT_WIDTH = 220
export const FILE_EXPLORER_MIN_WIDTH = 160
export const FILE_EXPLORER_MAX_WIDTH = 800
/** The explorer never takes more than this share of the terminal body, so the shell stays usable. */
export const FILE_EXPLORER_MAX_SHARE = 0.7
export const FILE_EXPLORER_WIDTH_KEY = 'fileExplorerWidth'

export function clampExplorerWidth(width: number, containerWidth?: number): number {
  if (!Number.isFinite(width)) return FILE_EXPLORER_DEFAULT_WIDTH
  const shareLimit = containerWidth && containerWidth > 0
    ? Math.floor(containerWidth * FILE_EXPLORER_MAX_SHARE)
    : FILE_EXPLORER_MAX_WIDTH
  const max = Math.max(FILE_EXPLORER_MIN_WIDTH, Math.min(FILE_EXPLORER_MAX_WIDTH, shareLimit))
  return Math.round(Math.min(max, Math.max(FILE_EXPLORER_MIN_WIDTH, width)))
}

export function parseExplorerWidth(raw: string | null | undefined): number {
  if (!raw) return FILE_EXPLORER_DEFAULT_WIDTH
  const value = Number(raw)
  return Number.isFinite(value) ? clampExplorerWidth(value) : FILE_EXPLORER_DEFAULT_WIDTH
}

export function loadExplorerWidth(): number {
  try {
    return parseExplorerWidth(localStorage.getItem(FILE_EXPLORER_WIDTH_KEY))
  } catch {
    return FILE_EXPLORER_DEFAULT_WIDTH
  }
}

export function saveExplorerWidth(width: number): void {
  try {
    localStorage.setItem(FILE_EXPLORER_WIDTH_KEY, String(width))
  } catch {
    // Storage may be unavailable; the width just won't be remembered.
  }
}
