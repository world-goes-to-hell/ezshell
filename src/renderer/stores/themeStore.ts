import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { PRESET_THEMES } from '../themes/presets'
import { ThemeDefinition, TerminalColors } from '../types/theme'
import { colorSchemeFor } from '../lib/colorScheme'
import { normalizeTheme, sanitizeStoredThemes } from '../lib/themeValidation'

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

/**
 * data-theme picks the CSS variables; color-scheme makes the parts Chromium draws itself
 * (open select lists, color picker, scrollbars, form controls) dark or light to match the theme.
 */
function applyThemeToDocument(themeId: string, background: string) {
  const root = document.documentElement
  root.setAttribute('data-theme', themeId)
  root.style.colorScheme = colorSchemeFor(background) ?? ''
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
        applyThemeToDocument(themeId, theme.colors.bgPrimary)

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
        applyThemeToDocument(currentThemeId, get().getCurrentTheme().colors.bgPrimary)
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
          // Every color is checked and a missing preview / category is derived; a file lacking
          // preview used to be stored as is and blank the app whenever the theme list rendered
          const theme = normalizeTheme(JSON.parse(json))
          if (!theme) return false

          // New id: never replace a preset or an existing custom theme
          get().saveCustomTheme({ ...theme, id: `custom-${Date.now()}` })
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
      // Stored custom themes may predate validation (or be edited by hand): repair or drop them before use,
      // and fall back to the default theme if the chosen one did not survive
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<Pick<ThemeState, 'currentThemeId' | 'customThemes'>>
        const customThemes = sanitizeStoredThemes(stored.customThemes)
        const chosen = stored.currentThemeId
        const isKnown = [...PRESET_THEMES, ...customThemes].some(theme => theme.id === chosen)
        return { ...current, customThemes, currentThemeId: isKnown && chosen ? chosen : current.currentThemeId }
      },
    }
  )
)
