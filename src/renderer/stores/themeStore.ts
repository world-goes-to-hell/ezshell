import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { PRESET_THEMES } from '../themes/presets'
import { ThemeDefinition, TerminalColors } from '../types/theme'

interface ThemeState {
  currentThemeId: string
  customThemes: ThemeDefinition[]
  setTheme: (themeId: string) => void
  getCurrentTheme: () => ThemeDefinition
  getTerminalTheme: () => TerminalColors
  initializeTheme: () => void
  saveCustomTheme: (theme: ThemeDefinition) => void
  deleteCustomTheme: (id: string) => void
  exportTheme: (id: string) => string | null
  importTheme: (json: string) => boolean
  getAllThemes: () => ThemeDefinition[]
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      currentThemeId: 'minimal-dark',
      customThemes: [],

      setTheme: (themeId: string) => {
        const theme = get().getAllThemes().find(t => t.id === themeId)
        if (!theme) return

        set({ currentThemeId: themeId })

        // Apply theme to DOM
        document.documentElement.setAttribute('data-theme', themeId)

        // Dispatch event for terminal sync
        window.dispatchEvent(new CustomEvent('theme-changed', { detail: { themeId } }))
      },

      getCurrentTheme: () => {
        const { currentThemeId } = get()
        const allThemes = get().getAllThemes()
        return allThemes.find(t => t.id === currentThemeId) || PRESET_THEMES[0]
      },

      getTerminalTheme: () => {
        const theme = get().getCurrentTheme()
        return theme.terminal
      },

      initializeTheme: () => {
        const { currentThemeId } = get()
        document.documentElement.setAttribute('data-theme', currentThemeId)
      },

      saveCustomTheme: (theme: ThemeDefinition) => {
        set((state) => {
          const existingIndex = state.customThemes.findIndex(t => t.id === theme.id)
          if (existingIndex >= 0) {
            // Update existing theme
            const updated = [...state.customThemes]
            updated[existingIndex] = theme
            return { customThemes: updated }
          } else {
            // Add new theme
            return { customThemes: [...state.customThemes, theme] }
          }
        })
      },

      deleteCustomTheme: (id: string) => {
        set((state) => ({
          customThemes: state.customThemes.filter(t => t.id !== id)
        }))

        // If deleted theme was active, switch to default
        if (get().currentThemeId === id) {
          get().setTheme('minimal-dark')
        }
      },

      exportTheme: (id: string) => {
        const theme = get().getAllThemes().find(t => t.id === id)
        if (!theme) return null
        return JSON.stringify(theme, null, 2)
      },

      importTheme: (json: string) => {
        try {
          const theme = JSON.parse(json) as ThemeDefinition

          // Validate theme structure
          if (!theme.id || !theme.name || !theme.colors || !theme.terminal) {
            return false
          }

          // Generate new ID to avoid conflicts
          const newTheme = {
            ...theme,
            id: `custom-${Date.now()}`
          }

          get().saveCustomTheme(newTheme)
          return true
        } catch (error) {
          console.error('Failed to import theme:', error)
          return false
        }
      },

      getAllThemes: () => {
        return [...PRESET_THEMES, ...get().customThemes]
      },
    }),
    {
      name: 'theme-store',
      partialize: (state) => ({
        currentThemeId: state.currentThemeId,
        customThemes: state.customThemes
      }),
    }
  )
)
