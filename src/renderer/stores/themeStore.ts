import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { PRESET_THEMES } from '../themes/presets'
import { ThemeDefinition, TerminalColors } from '../types/theme'
import { colorSchemeFor } from '../lib/colorScheme'
import { normalizeTheme, sanitizeStoredThemes } from '../lib/themeValidation'
import { detectDefaultThemeId } from '../lib/defaultTheme'
import { clampWindowOpacity, effectiveSurface, parseSurface, type SurfaceStyle } from '../lib/appearance'

interface ThemeState {
  currentThemeId: string
  customThemes: ThemeDefinition[]
  /** Flat (solid panels) or glass (translucent, blurred); independent of the color theme */
  surface: SurfaceStyle
  /** 0.5 to 1: the whole window made see-through */
  windowOpacity: number
  setSurface: (surface: SurfaceStyle) => void
  setWindowOpacity: (opacity: number) => void
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
function applyThemeToDocument(theme: ThemeDefinition, surface: SurfaceStyle) {
  const root = document.documentElement
  root.setAttribute('data-theme', theme.id)
  // CSS motion effects use the selected palette, including values from custom themes.
  root.style.setProperty('--motion-accent', theme.colors.accent)
  root.style.setProperty('--terminal-background', theme.terminal.background)
  root.style.setProperty('--terminal-foreground', theme.terminal.foreground)
  // Surface style (styles/glass.css) and the scheme it needs to pick its edge color
  const drawn = effectiveSurface(theme.id, surface)
  const scheme = colorSchemeFor(theme.colors.bgPrimary) ?? 'dark'
  root.setAttribute('data-surface', drawn)
  root.setAttribute('data-scheme', scheme)
  syncNativeBackdrop(drawn, scheme)
  // data-chrome switches shape rules (title bar layout, field style) that colors alone cannot express
  if (theme.chrome) root.setAttribute('data-chrome', theme.chrome)
  else root.removeAttribute('data-chrome')
  root.style.colorScheme = colorSchemeFor(theme.colors.bgPrimary) ?? ''
}

type BackdropApi = {
  setAppearance?: (value: { surface: SurfaceStyle; scheme: 'light' | 'dark' }) => void
  getBackdrop?: () => Promise<{ active: boolean; supported: boolean }>
}

/**
 * Glass with the real desktop behind it (Windows acrylic). Main can only give a window that material
 * when it creates it, so: tell main what is chosen (for the next start), and mark the document when
 * this window already has it. `data-backdrop`: "native" = acrylic is behind this window (glass.css
 * drops the painted wash), "restart" = it will be after a restart, absent = not available here.
 */
function syncNativeBackdrop(surface: SurfaceStyle, scheme: 'light' | 'dark') {
  const root = document.documentElement
  const api = (window as unknown as { electronAPI?: BackdropApi }).electronAPI
  if (typeof api?.setAppearance !== 'function' || typeof api.getBackdrop !== 'function') {
    root.removeAttribute('data-backdrop')
    return
  }
  try {
    api.setAppearance({ surface, scheme })
    void api.getBackdrop()
      .then(state => {
        if (surface === 'glass' && state?.active) root.setAttribute('data-backdrop', 'native')
        else if (surface === 'glass' && state?.supported) root.setAttribute('data-backdrop', 'restart')
        else root.removeAttribute('data-backdrop')
      })
      .catch(() => root.removeAttribute('data-backdrop'))
  } catch {
    root.removeAttribute('data-backdrop')
  }
}

/** Asks main to make this window see-through; an app built before this existed has no such call */
function applyWindowOpacity(opacity: number) {
  try {
    const api = (window as unknown as { electronAPI?: { setWindowOpacity?: (value: number) => void } }).electronAPI
    if (typeof api?.setWindowOpacity === 'function') api.setWindowOpacity(clampWindowOpacity(opacity))
  } catch {
    // The window stays opaque
  }
}

// Window focus as an attribute, so CSS can gray the mac-style window buttons of a background window
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const markFocus = () => document.documentElement.toggleAttribute('data-window-blurred', !document.hasFocus())
  window.addEventListener('focus', markFocus)
  window.addEventListener('blur', markFocus)
  markFocus()
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      // First run only: a saved choice replaces this in merge below
      currentThemeId: detectDefaultThemeId(),
      customThemes: [],
      surface: 'flat',
      windowOpacity: 1,

      setSurface: (surface: SurfaceStyle) => {
        set({ surface })
        applyThemeToDocument(get().getCurrentTheme(), surface)
      },

      setWindowOpacity: (opacity: number) => {
        const windowOpacity = clampWindowOpacity(opacity)
        set({ windowOpacity })
        applyWindowOpacity(windowOpacity)
      },

      setTheme: (themeId: string) => {
        const theme = get().getAllThemes().find(t => t.id === themeId)
        if (!theme) return

        set({ currentThemeId: themeId })

        // Apply theme to DOM
        applyThemeToDocument(theme, get().surface)

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
        applyThemeToDocument(get().getCurrentTheme(), get().surface)
        applyWindowOpacity(get().windowOpacity)
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
          get().setTheme(detectDefaultThemeId())
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
        customThemes: state.customThemes,
        surface: state.surface,
        windowOpacity: state.windowOpacity
      }),
      // Stored custom themes may predate validation (or be edited by hand): repair or drop them before use,
      // and fall back to the default theme if the chosen one did not survive
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<Pick<ThemeState, 'currentThemeId' | 'customThemes' | 'surface' | 'windowOpacity'>>
        const customThemes = sanitizeStoredThemes(stored.customThemes)
        const chosen = stored.currentThemeId
        const isKnown = [...PRESET_THEMES, ...customThemes].some(theme => theme.id === chosen)
        return {
          ...current,
          customThemes,
          currentThemeId: isKnown && chosen ? chosen : current.currentThemeId,
          surface: parseSurface(stored.surface),
          windowOpacity: clampWindowOpacity(stored.windowOpacity)
        }
      },
    }
  )
)
