// The work panel ("작업 공간"): docked at the right of the main area, beside the terminals (not over
// them), so it stays in view while typing. Remembered: open or not and its width.

export const WORKSPACE_PANEL_KEY = 'workspacePanel'
export const WORKSPACE_MIN_WIDTH = 280
export const WORKSPACE_MAX_WIDTH = 720
export const WORKSPACE_DEFAULT_WIDTH = 380

export type WorkspaceSection = 'history' | 'files' | 'git'

export interface WorkspacePanelPrefs {
  isOpen: boolean
  width: number
}

export const DEFAULT_WORKSPACE_PREFS: WorkspacePanelPrefs = { isOpen: false, width: WORKSPACE_DEFAULT_WIDTH }

/** Keeps the terminals usable: at most half the window, within the panel's own limits */
export function clampWorkspaceWidth(width: number, windowWidth: number): number {
  const max = Math.max(WORKSPACE_MIN_WIDTH, Math.min(WORKSPACE_MAX_WIDTH, Math.floor(windowWidth / 2)))
  if (!Number.isFinite(width)) return Math.min(WORKSPACE_DEFAULT_WIDTH, max)
  return Math.round(Math.min(max, Math.max(WORKSPACE_MIN_WIDTH, width)))
}

export function parseWorkspacePrefs(raw: string | null): WorkspacePanelPrefs {
  try {
    const data: unknown = JSON.parse(raw ?? 'null')
    if (!data || typeof data !== 'object') return DEFAULT_WORKSPACE_PREFS
    const { isOpen, width } = data as Record<string, unknown>
    return {
      isOpen: isOpen === true,
      width: typeof width === 'number' && Number.isFinite(width)
        ? Math.min(WORKSPACE_MAX_WIDTH, Math.max(WORKSPACE_MIN_WIDTH, Math.round(width)))
        : WORKSPACE_DEFAULT_WIDTH
    }
  } catch {
    return DEFAULT_WORKSPACE_PREFS
  }
}
