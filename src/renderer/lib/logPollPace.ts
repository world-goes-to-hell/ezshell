// How long the live log view waits before its next look. While lines arrive it looks again quickly,
// so the log reads like `tail -f`; each quiet look doubles the wait back up to one second, so an idle
// log costs the server what it did before (one SFTP stat per second). Still one look at a time: the
// wait starts only after the previous answer came.

export const POLL_ACTIVE_MS = 200
export const POLL_IDLE_MS = 1000
export const POLL_HIDDEN_MS = 5000
export const RETRY_MS = 3000

export interface PollPace {
  /** Wait before the next look while the window is seen */
  waitMs: number
}

export const INITIAL_PACE: PollPace = { waitMs: POLL_IDLE_MS }

/** The pace after a look: new text speeds up to the active pace, a quiet look backs off */
export function nextPace(pace: PollPace, hadNewText: boolean): PollPace {
  if (hadNewText) return { waitMs: POLL_ACTIVE_MS }
  return { waitMs: Math.min(POLL_IDLE_MS, pace.waitMs * 2) }
}

/** A window nobody sees keeps the slow pace whatever the log does */
export function waitFor(pace: PollPace, isHidden: boolean): number {
  return isHidden ? POLL_HIDDEN_MS : pace.waitMs
}
