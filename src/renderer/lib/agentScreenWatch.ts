// A screen of the CLI's own over a chat pane (2026-11-26 user report: Claude's "Teach auto mode about your
// environment?" stood in the terminal while the chat showed nothing). The chat cannot draw such screens,
// which differ by CLI and version, so the pane goes to the terminal as for a slash command's screen
// (stores/agentScreenReturnStore.ts) once the composer has stayed gone. Questions are not screens: the
// chat answers them with its own cards.

export interface ScreenWatch {
  /** The composer was seen since watching began */
  seen: boolean
  /** Reads in a row without composer or question */
  missing: number
}

export interface ScreenRead {
  composer: string | null
  approval: unknown
  loginStage?: 'active' | 'continue'
}

export const INITIAL_SCREEN_WATCH: ScreenWatch = { seen: false, missing: 0 }
/** Reads (about a second apart) without the composer it had: a redraw hides it for a moment only */
export const SCREEN_READS = 3
/** Without ever seeing the composer the agent may still be starting, so this waits longer */
export const UNSEEN_SCREEN_READS = 10

export function readScreenWatch(watch: ScreenWatch, screen: ScreenRead | null): { watch: ScreenWatch; open: boolean } {
  if (!screen) return { watch: { ...watch, missing: 0 }, open: false }
  if (screen.loginStage) return { watch: { ...watch, missing: 0 }, open: true }
  if (screen.composer !== null || screen.approval) {
    return { watch: { seen: watch.seen || screen.composer !== null, missing: 0 }, open: false }
  }
  const missing = watch.missing + 1
  const open = missing >= (watch.seen ? SCREEN_READS : UNSEEN_SCREEN_READS)
  return { watch: { seen: watch.seen, missing: open ? 0 : missing }, open }
}
