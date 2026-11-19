// The side-by-side Markdown view of the file window: the share of the width the editor takes.
// Kept per viewer in localStorage ('remoteMarkdownSplit'); a missing or odd value gives half.

export const MARKDOWN_SPLIT_KEY = 'remoteMarkdownSplit'
export const DEFAULT_SPLIT = 0.5
const MIN = 0.2
const MAX = 0.8

export const clampSplit = (ratio: number): number => (Number.isFinite(ratio) ? Math.min(MAX, Math.max(MIN, ratio)) : DEFAULT_SPLIT)

export function readSplit(raw: string | null): number {
  const value = raw === null ? NaN : Number(raw)
  return Number.isFinite(value) ? clampSplit(value) : DEFAULT_SPLIT
}

/** The editor's share when the divider is at `x` in a body starting at `left` and `width` wide */
export const splitAt = (x: number, left: number, width: number): number => (width > 0 ? clampSplit((x - left) / width) : DEFAULT_SPLIT)

export function loadSplit(): number {
  try {
    return readSplit(localStorage.getItem(MARKDOWN_SPLIT_KEY))
  } catch {
    return DEFAULT_SPLIT
  }
}

export function saveSplit(ratio: number): void {
  try {
    localStorage.setItem(MARKDOWN_SPLIT_KEY, String(Math.round(clampSplit(ratio) * 1000) / 1000))
  } catch {
    // Not kept (private window or blocked storage): the next window starts at half
  }
}
