/**
 * Rate limits for work driven by dragging a divider. A drag fires many mouse moves and a layout change
 * per frame; doing the expensive part (a React update, refitting a terminal) on every one of them made
 * resizing stutter.
 */

/** How often a terminal is refitted while its size keeps changing (a drag) */
export const REFIT_INTERVAL_MS = 60

export interface Throttled<Args extends unknown[]> {
  (...args: Args): void
  /** Drops a pending call */
  cancel: () => void
}

/**
 * Runs at once, then at most once per `ms` while calls keep coming, and once more at the end with the
 * latest arguments (so the final size is always applied).
 */
export function throttle<Args extends unknown[]>(fn: (...args: Args) => void, ms: number): Throttled<Args> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: Args | null = null
  let lastRun = Number.NEGATIVE_INFINITY

  const run = (args: Args) => {
    lastRun = Date.now()
    fn(...args)
  }

  const throttled = (...args: Args) => {
    const wait = ms - (Date.now() - lastRun)
    if (wait <= 0 && !timer) {
      run(args)
      return
    }
    pending = args
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const latest = pending
      pending = null
      if (latest) run(latest)
    }, Math.max(0, wait))
  }

  throttled.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
  }
  return throttled
}

/** At most one call per animation frame, with the latest arguments (for state driven by mouse moves) */
export function perFrame<Args extends unknown[]>(fn: (...args: Args) => void): Throttled<Args> {
  let frame = 0
  let pending: Args | null = null

  const throttled = (...args: Args) => {
    pending = args
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      const latest = pending
      pending = null
      if (latest) fn(...latest)
    })
  }

  throttled.cancel = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    pending = null
  }
  return throttled
}
