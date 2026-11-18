// The split shells that are on screen, by tab and pane, so a shell can be handed over when its
// pane is moved out to a tab of its own (lib/paneToTab.ts). Each SplitTerminal registers itself.

import type { PaneId } from './splitTree'

export interface SplitShellHandle {
  /** The shell's channel id, or null while it is still opening (or failed) */
  streamId: () => string | null
  /**
   * Gives the shell up: resolves with the screen as it is once everything received so far is drawn,
   * and from then on the pane neither shows the shell's output nor closes the shell when it goes away.
   */
  detach: () => Promise<string>
}

const handles = new Map<string, SplitShellHandle>()
const keyOf = (sessionId: string, pane: PaneId) => `${sessionId}\n${pane}`

/** Returns the function that removes the registration (only if it is still this handle) */
export function registerSplitShell(sessionId: string, pane: PaneId, handle: SplitShellHandle): () => void {
  const key = keyOf(sessionId, pane)
  handles.set(key, handle)
  return () => {
    if (handles.get(key) === handle) handles.delete(key)
  }
}

export const splitShellOf = (sessionId: string, pane: PaneId): SplitShellHandle | undefined => handles.get(keyOf(sessionId, pane))

const mainScreens = new Map<string, (screen: string) => void>()

export function registerMainScreen(sessionId: string, replace: (screen: string) => void): () => void {
  mainScreens.set(sessionId, replace)
  return () => {
    if (mainScreens.get(sessionId) === replace) mainScreens.delete(sessionId)
  }
}

export const mainScreenOf = (sessionId: string) => mainScreens.get(sessionId)
