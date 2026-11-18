// What the log view remembers between windows: whether the list of markers and problems is open,
// and whether long lines are folded at the window's width.

export const LOG_VIEW_PREFS_KEY = 'remoteLogViewPrefs'

export interface LogViewPrefs {
  isOutlineOpen: boolean
  isWrapped: boolean
}

export const DEFAULT_LOG_VIEW_PREFS: LogViewPrefs = { isOutlineOpen: true, isWrapped: false }

/** Stored preferences as read from localStorage; anything missing or not understood becomes the default. */
export function parseLogViewPrefs(raw: string | null | undefined): LogViewPrefs {
  if (!raw) return DEFAULT_LOG_VIEW_PREFS
  try {
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null) return DEFAULT_LOG_VIEW_PREFS
    const { isOutlineOpen, isWrapped } = stored as Record<string, unknown>
    return {
      isOutlineOpen: typeof isOutlineOpen === 'boolean' ? isOutlineOpen : DEFAULT_LOG_VIEW_PREFS.isOutlineOpen,
      isWrapped: typeof isWrapped === 'boolean' ? isWrapped : DEFAULT_LOG_VIEW_PREFS.isWrapped
    }
  } catch {
    return DEFAULT_LOG_VIEW_PREFS
  }
}

export function readLogViewPrefs(): LogViewPrefs {
  try {
    return parseLogViewPrefs(localStorage.getItem(LOG_VIEW_PREFS_KEY))
  } catch {
    return DEFAULT_LOG_VIEW_PREFS
  }
}

export function saveLogViewPrefs(prefs: LogViewPrefs): void {
  try {
    localStorage.setItem(LOG_VIEW_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Storage is full or blocked: the choice lasts for this window only
  }
}
