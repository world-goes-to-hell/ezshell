/**
 * How long the answer buttons of an approval dialog stay off after it appears, or after the app window
 * gets focus. Requests queue up and the window comes to the front by itself, so without this a double
 * click, or the click that brings the window forward, would answer a request nobody has read.
 */
export const APPROVAL_ARM_DELAY_MS = 800

interface ArmingState {
  /** When the dialog appeared */
  shownAt: number
  /** When the app window last got focus while the dialog was open; null if it has not had focus */
  focusedAt: number | null
  hasFocus: boolean
  now: number
}

/** Whether "허용" / "거부" may be pressed: the window has focus, and has had it (and the dialog) for a moment */
export function isApprovalArmed({ shownAt, focusedAt, hasFocus, now }: ArmingState): boolean {
  if (!hasFocus || focusedAt === null) return false
  return now - Math.max(shownAt, focusedAt) >= APPROVAL_ARM_DELAY_MS
}
