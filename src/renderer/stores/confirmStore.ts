import { create } from 'zustand'

/**
 * In-app confirmation dialog (instead of window.confirm, which shows the OS dialog and blocks the renderer).
 * Call `await confirmDialog({...})` anywhere; <ConfirmDialogHost /> shows the open question.
 */
export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  /** Destructive action: red confirm button */
  danger?: boolean
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (confirmed: boolean) => void
}

interface ConfirmState {
  request: ConfirmRequest | null
  ask: (options: ConfirmOptions) => Promise<boolean>
  answer: (confirmed: boolean) => void
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,

  ask: (options) => new Promise<boolean>(resolve => {
    // Only one question at a time: a newer one cancels the one still open
    get().request?.resolve(false)
    set({ request: { ...options, resolve } })
  }),

  answer: (confirmed) => {
    const request = get().request
    if (!request) return
    set({ request: null })
    request.resolve(confirmed)
  }
}))

export const confirmDialog = (options: ConfirmOptions): Promise<boolean> => useConfirmStore.getState().ask(options)
