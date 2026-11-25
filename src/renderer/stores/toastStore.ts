import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'warning' | 'info'
export type ToastPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top-center' | 'bottom-center'

export interface Toast {
  id: string
  type: ToastType
  title: string
  message?: string
  duration?: number  // ms, 0 = no auto-dismiss
  dismissible?: boolean
  action?: { label: string; run: () => void }
}

interface ToastState {
  toasts: Toast[]
  position: ToastPosition
  maxToasts: number
  addToast: (toast: Omit<Toast, 'id'>) => string
  removeToast: (id: string) => void
  clearAll: () => void
  setPosition: (position: ToastPosition) => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  position: 'bottom-right',
  maxToasts: 5,

  addToast: (toast) => {
    const id = crypto.randomUUID()
    const newToast: Toast = {
      id,
      duration: 4000,
      dismissible: true,
      ...toast,
    }

    set((state) => {
      const toasts = [...state.toasts, newToast]
      // Limit max toasts
      if (toasts.length > state.maxToasts) {
        toasts.shift()
      }
      return { toasts }
    })

    // Auto-dismiss
    if (newToast.duration && newToast.duration > 0) {
      setTimeout(() => {
        get().removeToast(id)
      }, newToast.duration)
    }

    return id
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }))
  },

  clearAll: () => {
    set({ toasts: [] })
  },

  setPosition: (position) => {
    set({ position })
  },
}))

// Alias for convenience
export const useToast = useToastStore

// Helper functions for common toast types
export const toast = {
  success: (title: string, message?: string) =>
    useToastStore.getState().addToast({ type: 'success', title, message }),
  error: (title: string, message?: string) =>
    useToastStore.getState().addToast({ type: 'error', title, message, duration: 6000 }),
  warning: (title: string, message?: string) =>
    useToastStore.getState().addToast({ type: 'warning', title, message }),
  info: (title: string, message?: string) =>
    useToastStore.getState().addToast({ type: 'info', title, message }),
}
