import { useEffect } from 'react'
import { useThemeStore } from '../stores/themeStore'
import { THEME_STORAGE_KEY, themeIdFromStorageValue } from '../lib/themeSync'

/**
 * Theme for a popped-out window (terminal / SFTP): apply the saved theme on start, and follow theme
 * changes made in another window. Each window is its own renderer, but they share localStorage, so a
 * change elsewhere arrives here as a `storage` event.
 */
export function usePopoutTheme() {
  useEffect(() => {
    useThemeStore.getState().initializeTheme()

    const handleStorage = async (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return
      const themeId = themeIdFromStorageValue(e.newValue)
      if (!themeId) return
      // Re-read the store so custom themes created in the other window are known here too
      await useThemeStore.persist.rehydrate()
      useThemeStore.getState().initializeTheme()
      // Terminals listen for this to repaint with the new colors
      window.dispatchEvent(new CustomEvent('theme-changed', { detail: { themeId } }))
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])
}
