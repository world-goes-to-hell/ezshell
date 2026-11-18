// Shells handed to a split pane instead of being opened by it: a tab merged into another tab's
// pane (lib/tabToPane.ts). The shell's channel already exists and already sends output under its
// new stream id, before the pane that will show it is on screen. That output is held here, with
// the screen the tab had, until the pane's SplitTerminal claims the shell.

import type { PaneId } from './splitTree'

interface Incoming {
  streamId: string
  /** The screen as the tab showed it (serialized), drawn once by the pane */
  screen: string
  /** Output received while no pane holds the shell */
  held: string[]
  isClaimed: boolean
  isDead: boolean
  abandonTimer: ReturnType<typeof setTimeout> | null
}

export interface ClaimedShell {
  streamId: string
  screen: string
  /** Output that arrived after the screen was taken, in order */
  output: string
}

// A pane lets its shell go when its effect is torn down. In development React tears every effect
// down once right after mounting (StrictMode) and runs it again: the shell must survive that, so it
// is closed only if nobody claims it again within this time.
const ABANDON_AFTER_MS = 1500

const byPane = new Map<string, Incoming>()
const keyOf = (tabId: string, pane: PaneId) => `${tabId}\n${pane}`
let stopListening: (() => void) | null = null

function listen(): void {
  if (stopListening) return
  const offData = window.electronAPI.onSshSplitData((data: { streamId: string; data: string }) => {
    for (const incoming of byPane.values()) {
      if (incoming.streamId === data.streamId && !incoming.isClaimed) incoming.held.push(data.data)
    }
  })
  const offClosed = window.electronAPI.onSshSplitClosed((data: { streamId: string }) => {
    for (const incoming of byPane.values()) {
      if (incoming.streamId === data.streamId) incoming.isDead = true
    }
  })
  stopListening = () => {
    offData?.()
    offClosed?.()
    stopListening = null
  }
}

function forget(key: string): void {
  const incoming = byPane.get(key)
  if (incoming?.abandonTimer) clearTimeout(incoming.abandonTimer)
  byPane.delete(key)
  if (byPane.size === 0) stopListening?.()
}

/**
 * Starts holding the output of a shell that is about to be given to a pane. Call it in the same
 * tick the main process answers with the stream id, so nothing arrives unheard.
 */
export function expectIncomingShell(tabId: string, pane: PaneId, streamId: string): void {
  listen()
  byPane.set(keyOf(tabId, pane), { streamId, screen: '', held: [], isClaimed: false, isDead: false, abandonTimer: null })
}

/** The screen the shell's tab showed, known a moment after `expectIncomingShell` */
export function setIncomingScreen(tabId: string, pane: PaneId, screen: string): void {
  const incoming = byPane.get(keyOf(tabId, pane))
  if (incoming) incoming.screen = screen
}

/** The shell waiting for this pane, if any. From here on the pane receives its output itself. */
export function claimIncomingShell(tabId: string, pane: PaneId): ClaimedShell | null {
  const key = keyOf(tabId, pane)
  const incoming = byPane.get(key)
  if (!incoming) return null
  if (incoming.isDead) {
    forget(key)
    return null
  }
  if (incoming.abandonTimer) clearTimeout(incoming.abandonTimer)
  incoming.abandonTimer = null
  incoming.isClaimed = true
  const output = incoming.held.join('')
  incoming.held = []
  return { streamId: incoming.streamId, screen: incoming.screen, output }
}

/** The pane drew the screen: a later claim (after a remount) must not draw it again */
export function markIncomingDrawn(tabId: string, pane: PaneId, screen: string): void {
  const incoming = byPane.get(keyOf(tabId, pane))
  if (incoming) incoming.screen = screen
}

/**
 * The pane's effect was torn down while it held the shell. The shell is kept for a moment in case
 * the pane mounts again (then `screen` is what it shows next, followed by `unshown`), and closed otherwise.
 */
export function releaseIncomingShell(tabId: string, pane: PaneId, screen: string, unshown = ''): void {
  const key = keyOf(tabId, pane)
  const incoming = byPane.get(key)
  if (!incoming) return
  incoming.isClaimed = false
  incoming.screen = screen || incoming.screen
  // What the pane received but never drew (torn down before its terminal existed) is still owed
  if (unshown) incoming.held = [unshown]
  incoming.abandonTimer = setTimeout(() => {
    if (byPane.get(key) !== incoming || incoming.isClaimed) return
    if (!incoming.isDead) window.electronAPI.sshSplitClose(incoming.streamId)
    forget(key)
  }, ABANDON_AFTER_MS)
}

/** The shell is no longer this pane's to keep track of (closed, or moved out to a tab again) */
export function forgetIncomingShell(tabId: string, pane: PaneId): void {
  forget(keyOf(tabId, pane))
}

export const isIncomingShell = (tabId: string, pane: PaneId, streamId: string | null): boolean =>
  streamId !== null && byPane.get(keyOf(tabId, pane))?.streamId === streamId
