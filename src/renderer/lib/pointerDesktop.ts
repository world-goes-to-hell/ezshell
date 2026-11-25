import { effectInk } from './pointerInk'
import { getPointerPrefs, subscribePointerPrefs, type PointerPrefs } from './pointerPrefs'
import { canReplaceSystemPointer } from './pointerSystem'

export type DesktopPointerConfig = Pick<PointerPrefs, 'move' | 'click' | 'moveLevel' | 'clickLevel' | 'set' | 'size'> & {
  enabled: boolean
  ink: string
  dark: boolean
  reduced: boolean
}

export type DesktopPointerFrame =
  | { type: 'config'; config: DesktopPointerConfig }
  | { type: 'move' | 'press'; x: number; y: number }
  | { type: 'clear' | 'leave' }

/** The unlocked main window sends the desktop effect choices when preferences, theme or motion change. */
export function startDesktopPointerEffects(): () => void {
  const configure = window.electronAPI?.pointerEffectsConfigure
  if (!canReplaceSystemPointer() || !configure) return () => {}
  const root = document.documentElement
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  let last = ''
  let disposed = false

  const sync = () => {
    const { effectsOutsideApp: enabled, move, click, moveLevel, clickLevel, set, size } = getPointerPrefs()
    const { ink, dark } = effectInk(getComputedStyle(root))
    const config: DesktopPointerConfig = { enabled, move, click, moveLevel, clickLevel, ink, dark, reduced: motion.matches, set, size }
    const key = JSON.stringify(config)
    if (key === last) return
    last = key
    void configure(config).then(accepted => {
      if (!disposed && key === last) root.dataset.desktopPointerEffects = accepted ? (enabled ? 'on' : 'off') : 'refused'
    }).catch(() => {})
  }

  const unsubscribe = subscribePointerPrefs(sync)
  const theme = new MutationObserver(sync)
  theme.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
  motion.addEventListener('change', sync)
  sync()
  return () => {
    disposed = true
    unsubscribe()
    theme.disconnect()
    motion.removeEventListener('change', sync)
    delete root.dataset.desktopPointerEffects
  }
}
