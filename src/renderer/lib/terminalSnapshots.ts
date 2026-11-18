/**
 * Screen contents of terminals, carried across xterm instances of the same SSH session:
 * popping a tab out to its own window, merging it back, and the remount when the layout switches
 * between single and split view. Kept in memory only (never written to storage).
 */

type Serializer = () => string

// Live xterm instances, so a snapshot can be taken right before the tab leaves the window
const serializers = new Map<string, Serializer>()
// Resolves once everything the terminal has received so far is drawn
const flushers = new Map<string, () => Promise<void>>()
// Snapshots waiting for the next terminal of that session to mount
const pending = new Map<string, string>()

/** Rows of scrollback included in a snapshot; keeps IPC payloads bounded */
export const SNAPSHOT_SCROLLBACK_ROWS = 5000

/** Register the serializer of a mounted terminal. Returns an unregister function. */
export function registerTerminalSerializer(sessionId: string, serialize: Serializer, flush?: () => Promise<void>): () => void {
  serializers.set(sessionId, serialize)
  if (flush) flushers.set(sessionId, flush)
  else flushers.delete(sessionId)
  return () => {
    // A remounted terminal may already have replaced this one
    if (serializers.get(sessionId) !== serialize) return
    serializers.delete(sessionId)
    flushers.delete(sessionId)
  }
}

/** Like captureTerminalSnapshot, after the output received so far has been drawn (xterm writes are queued) */
export async function captureDrawnSnapshot(sessionId: string): Promise<string | null> {
  const flush = flushers.get(sessionId)
  if (flush) {
    try { await flush() } catch { /* take what is there */ }
  }
  return captureTerminalSnapshot(sessionId)
}

/** Current screen of the session's terminal, or null when there is none (or nothing on it). */
export function captureTerminalSnapshot(sessionId: string): string | null {
  const serialize = serializers.get(sessionId)
  if (!serialize) return null
  try {
    return serialize() || null
  } catch {
    return null
  }
}

export function setPendingSnapshot(sessionId: string, snapshot: string): void {
  if (snapshot) pending.set(sessionId, snapshot)
}

/** Snapshot for a terminal that is mounting now; handed out only once. */
export function takePendingSnapshot(sessionId: string): string | null {
  const snapshot = pending.get(sessionId) ?? null
  pending.delete(sessionId)
  return snapshot
}

/** Test helper */
export function resetTerminalSnapshots(): void {
  serializers.clear()
  flushers.clear()
  pending.clear()
}
