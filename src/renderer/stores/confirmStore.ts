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
  /** SSH session affected by this action */
  server?: { name: string; color?: string }
  /** Destructive action: red confirm button */
  danger?: boolean
  /**
   * Focus starts on the confirm button even for a destructive action, so Enter confirms. For questions the user
   * asked for by choosing the action itself (closing a local tab from its menu); a destructive question that comes
   * up on its own keeps cancel first.
   */
  enterConfirms?: boolean
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
