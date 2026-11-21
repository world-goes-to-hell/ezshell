import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { resolveInitialZoom, snapZoom } from '../lib/appZoom'
import { DEFAULT_BROWSER_TAB_WIDTH, normalizeBrowserTabWidth } from '../lib/browserTabWidth'

/**
 * Chromium's current zoom, read before React mounts so a zoom kept from the old
 * implementation is adopted without a flash of 100% or a zoom popup at startup.
 */
function readActualZoom(): number | undefined {
  if (typeof window === 'undefined') return undefined
  const read = window.electronAPI?.getAppZoomFactor
  return typeof read === 'function' ? read() : undefined
}

interface UIState {
  sidebarMode: 'compact' | 'expanded'
  zenMode: boolean
  /** Whole-app zoom factor (Ctrl + mouse wheel) */
  appZoom: number
  browserTabMaxWidth: number
  setAppZoom: (factor: number) => void
  setBrowserTabMaxWidth: (width: number) => void
  setSidebarMode: (mode: 'compact' | 'expanded') => void
  toggleSidebarMode: () => void
  setZenMode: (enabled: boolean) => void
  toggleZenMode: () => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarMode: 'expanded',
      zenMode: false,
      appZoom: resolveInitialZoom(undefined, readActualZoom()),
      browserTabMaxWidth: DEFAULT_BROWSER_TAB_WIDTH,
      setAppZoom: (factor) => set({ appZoom: snapZoom(factor) }),
      setBrowserTabMaxWidth: (width) => set({ browserTabMaxWidth: normalizeBrowserTabWidth(width) }),
      setSidebarMode: (mode) => set({ sidebarMode: mode }),
      toggleSidebarMode: () => set((state) => ({
        sidebarMode: state.sidebarMode === 'compact' ? 'expanded' : 'compact'
      })),
      setZenMode: (enabled) => set({ zenMode: enabled }),
      toggleZenMode: () => set((state) => ({ zenMode: !state.zenMode })),
    }),
    {
      name: 'ui-store',
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<UIState>
        return {
          ...current, ...stored,
          appZoom: resolveInitialZoom(stored.appZoom, readActualZoom()),
          browserTabMaxWidth: normalizeBrowserTabWidth(stored.browserTabMaxWidth)
        }
      }
    }
  )
)
