export const BROWSER_TAB_WIDTH_MIN = 120
export const BROWSER_TAB_WIDTH_MAX = 480
export const BROWSER_TAB_WIDTH_STEP = 20
export const DEFAULT_BROWSER_TAB_WIDTH = 240

export function normalizeBrowserTabWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BROWSER_TAB_WIDTH
  const rounded = Math.round(value / BROWSER_TAB_WIDTH_STEP) * BROWSER_TAB_WIDTH_STEP
  return Math.max(BROWSER_TAB_WIDTH_MIN, Math.min(BROWSER_TAB_WIDTH_MAX, rounded))
}
