import { throttle } from './throttle'

const BURST_LINES = 100
const BURST_WINDOW_MS = 1000
const BURST_HOLD_MS = 1800
const BURST_UPDATE_MS = 300

/** Reports the total lines in a surge, with one immediate update and then batched updates. */
export function trackLogBurst(publish: (lines: number) => void) {
  let recent: Array<{ at: number; lines: number }> = []
  let total = 0
  let hide: ReturnType<typeof setTimeout> | undefined
  const publishTotal = throttle(() => publish(total), BURST_UPDATE_MS)

  function reset(): void {
    clearTimeout(hide)
    publishTotal.cancel()
    recent = []
    total = 0
  }

  function add(lines: number): void {
    if (lines <= 0) return
    const at = Date.now()
    recent = recent.filter(entry => at - entry.at <= BURST_WINDOW_MS)
    recent.push({ at, lines })
    const inWindow = recent.reduce((sum, entry) => sum + entry.lines, 0)
    if (total === 0 && inWindow < BURST_LINES) return

    total = total === 0 ? inWindow : total + lines
    publishTotal()
    // A few lines after the surge are included, but only another surge extends the notice.
    if (inWindow >= BURST_LINES) {
      clearTimeout(hide)
      hide = setTimeout(() => {
        reset()
        publish(0)
      }, BURST_HOLD_MS)
    }
  }

  return { add, reset }
}
