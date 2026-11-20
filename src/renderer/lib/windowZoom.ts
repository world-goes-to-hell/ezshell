// The UI zoom of a detached window (server file, SFTP, terminal, DB, MCP activity), set with Ctrl +
// wheel in that window alone. Each kind of window keeps its own: the next window of that kind opens
// with it. The main window's zoom (uiStore.appZoom) is separate. Electron applies a zoom factor to
// the one window it is set in (checked: two windows of the same page keep their own factors).
import { DEFAULT_ZOOM, snapZoom } from './appZoom'

export type ZoomWindowKind = 'remoteFile' | 'sftp' | 'terminal' | 'db' | 'mcpActivity' | 'pinnedReply'

const KINDS: readonly ZoomWindowKind[] = ['remoteFile', 'sftp', 'terminal', 'db', 'mcpActivity', 'pinnedReply']
const STORAGE_PREFIX = 'windowZoom:'

export const windowZoomKey = (kind: ZoomWindowKind): string => `${STORAGE_PREFIX}${kind}`

export function isZoomWindowKind(value: unknown): value is ZoomWindowKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

/** The stored zoom of a kind of window, snapped to a preset; 100% when none or unreadable */
export function parseWindowZoom(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_ZOOM
  const value = Number(raw)
  return Number.isFinite(value) ? snapZoom(value) : DEFAULT_ZOOM
}

export function readWindowZoom(kind: ZoomWindowKind): number {
  try {
    return parseWindowZoom(localStorage.getItem(windowZoomKey(kind)))
  } catch {
    return DEFAULT_ZOOM
  }
}

export function writeWindowZoom(kind: ZoomWindowKind, factor: number): void {
  try {
    localStorage.setItem(windowZoomKey(kind), String(snapZoom(factor)))
  } catch {
    // Not remembered this time; the window still zooms
  }
}
