/**
 * Where "insert this command" goes for a connection tab: the pane (main terminal or a split)
 * that had keyboard focus last, falling back to the main terminal. The history panel uses this
 * because clicking the panel takes focus away from the terminal it should type into.
 */

export interface InputTarget {
  insert: (command: string) => void
}

const mainTargets = new Map<string, InputTarget>()
const focusedTargets = new Map<string, InputTarget>()

export function registerMainInputTarget(sessionId: string, target: InputTarget): void {
  mainTargets.set(sessionId, target)
}

export function setFocusedInputTarget(sessionId: string, target: InputTarget): void {
  focusedTargets.set(sessionId, target)
}

/** Removes the target only if it is still the registered one (a remount may have replaced it). */
export function unregisterInputTarget(sessionId: string, target: InputTarget): void {
  if (mainTargets.get(sessionId) === target) mainTargets.delete(sessionId)
  if (focusedTargets.get(sessionId) === target) focusedTargets.delete(sessionId)
}

export function insertIntoSession(sessionId: string, command: string): boolean {
  const target = focusedTargets.get(sessionId) ?? mainTargets.get(sessionId)
  if (!target) return false
  target.insert(command)
  return true
}

/** Test helper */
export function resetInputTargets(): void {
  mainTargets.clear()
  focusedTargets.clear()
}
