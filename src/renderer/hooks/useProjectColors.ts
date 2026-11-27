import { useSyncExternalStore } from 'react'
import { PROJECT_COLORS_EVENT, PROJECT_COLORS_KEY, readProjectColors, type ProjectColorSettings } from '../lib/localProjectColors'

// One parsed copy per stored text: useSyncExternalStore needs the same object while nothing changed
let cachedText: string | null | undefined
let cached: ProjectColorSettings = readProjectColors()

function snapshot(): ProjectColorSettings {
  let text: string | null = null
  try { text = localStorage.getItem(PROJECT_COLORS_KEY) } catch { /* blocked storage: the defaults */ }
  if (text !== cachedText) {
    cachedText = text
    cached = readProjectColors()
  }
  return cached
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === PROJECT_COLORS_KEY) onChange() }
  window.addEventListener(PROJECT_COLORS_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PROJECT_COLORS_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** The local work cards' colour settings, kept current across the windows of the app */
export function useProjectColors(): ProjectColorSettings {
  return useSyncExternalStore(subscribe, snapshot)
}
