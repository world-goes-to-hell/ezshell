export type HistoryDirection = 'back' | 'forward'

export interface DirectoryHistory {
  back: string[]
  forward: string[]
  /** Last path that actually finished loading; null until the first visit */
  current: string | null
  /** A back/forward step that was requested but has not landed yet */
  pending: { direction: HistoryDirection; target: string } | null
}

export const MAX_HISTORY = 50

export const createDirectoryHistory = (): DirectoryHistory => ({
  back: [],
  forward: [],
  current: null,
  pending: null
})

const pushCapped = (stack: string[], path: string): string[] =>
  [...stack, path].slice(-MAX_HISTORY)

/**
 * Record a path that finished loading. Call this only after a successful load so
 * failed navigations (which revert to the previous path) never enter the history.
 */
export function recordVisit(state: DirectoryHistory, path: string): DirectoryHistory {
  const { current, pending } = state
  if (!current) return { ...state, current: path || null, pending: null }
  if (path === current) return { ...state, pending: null }

  if (pending && pending.target === path) {
    if (pending.direction === 'back') {
      return {
        back: state.back.slice(0, -1),
        forward: pushCapped(state.forward, current),
        current: path,
        pending: null
      }
    }
    return {
      back: pushCapped(state.back, current),
      forward: state.forward.slice(0, -1),
      current: path,
      pending: null
    }
  }

  return { back: pushCapped(state.back, current), forward: [], current: path, pending: null }
}

/**
 * Mark a back/forward step as pending and return the path to navigate to.
 * Stacks only change once `recordVisit` sees the target load.
 */
export function requestStep(
  state: DirectoryHistory,
  direction: HistoryDirection
): { state: DirectoryHistory; target: string | null } {
  const stack = direction === 'back' ? state.back : state.forward
  const target = stack[stack.length - 1] ?? null
  if (!target) return { state, target: null }
  return { state: { ...state, pending: { direction, target } }, target }
}
