// The order tabs were last brought to the front, so closing the tab in front shows the one seen just before it
// (A B C: B, then C, close C → B, not the last or first in the strip). terminalStore notes each front tab;
// removeTerminal and the work groups' "stay in the closed tab's work" (useTabGroups) ask for the most recent.
// Kept outside the store's state: only read when a tab closes, so no render follows it.
const viewed = new Map<string, number>()
let clock = 0

export function noteTabViewed(id: string) {
  viewed.set(id, ++clock)
}

export function forgetTab(id: string) {
  viewed.delete(id)
}

/** The candidate seen most recently; null when none of them has been in front yet */
export function lastViewedTab(candidates: readonly string[]): string | null {
  let best: string | null = null
  let at = 0
  for (const id of candidates) {
    const seen = viewed.get(id) ?? 0
    if (seen > at) { best = id; at = seen }
  }
  return best
}

/** For tests */
export function resetTabRecency() {
  viewed.clear()
  clock = 0
}
