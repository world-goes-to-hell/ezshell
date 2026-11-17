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

/**
 * 'file': a look is one SFTP stat. 'command': a look runs a command on the server (a container's
 * log through `docker logs`), which costs it a process each time, so every wait is longer.
 */
export type PaceKind = 'file' | 'command'

interface PaceRule { activeMs: number; idleMs: number; hiddenMs: number; retryMs: number }

const RULES: Record<PaceKind, PaceRule> = {
  file: { activeMs: POLL_ACTIVE_MS, idleMs: POLL_IDLE_MS, hiddenMs: POLL_HIDDEN_MS, retryMs: RETRY_MS },
  command: { activeMs: 1000, idleMs: 5000, hiddenMs: 15000, retryMs: 5000 }
}

export const initialPace = (kind: PaceKind = 'file'): PollPace => ({ waitMs: RULES[kind].idleMs })
export const retryWait = (kind: PaceKind = 'file'): number => RULES[kind].retryMs

/** The pace after a look: new text speeds up to the active pace, a quiet look backs off */
export function nextPace(pace: PollPace, hadNewText: boolean, kind: PaceKind = 'file'): PollPace {
  const rule = RULES[kind]
  if (hadNewText) return { waitMs: rule.activeMs }
  return { waitMs: Math.min(rule.idleMs, pace.waitMs * 2) }
}

/** A window nobody sees keeps the slow pace whatever the log does */
export function waitFor(pace: PollPace, isHidden: boolean, kind: PaceKind = 'file'): number {
  return isHidden ? RULES[kind].hiddenMs : pace.waitMs
}
