import { create } from 'zustand'
import { updateNoticeKey } from '../lib/updateCheck'

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateInfo {
  status: UpdateStatus
  version?: string
  releaseDate?: string
  releaseNotes?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  errorMessage?: string
}

interface UpdateState {
  info: UpdateInfo
  /** The notice the user closed (state and version); a newer version or the next step shows again */
  dismissedKey: string | null
  appVersion: string

  setInfo: (info: Partial<UpdateInfo>) => void
  /** Close the notice shown now */
  dismissCurrent: () => void
  /** A manual check: show what it finds even if that notice was closed before */
  clearDismissed: () => void
  setAppVersion: (version: string) => void
  reset: () => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  info: { status: 'idle' },
  dismissedKey: null,
  appVersion: '1.0.0',

  // The app checks again every half hour; the same update found again must not undo a close
  setInfo: (info) => set((state) => ({ info: { ...state.info, ...info } })),

  dismissCurrent: () => set((state) => ({ dismissedKey: updateNoticeKey(state.info) })),
  clearDismissed: () => set({ dismissedKey: null }),
  setAppVersion: (appVersion) => set({ appVersion }),
  reset: () => set({ info: { status: 'idle' }, dismissedKey: null })
}))
