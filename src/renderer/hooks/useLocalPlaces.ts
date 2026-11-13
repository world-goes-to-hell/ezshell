import { useCallback, useEffect, useState } from 'react'

export type LocalPlace = { kind: 'desktop' | 'home' | 'documents' | 'downloads' | 'pictures' | 'music' | 'videos'; label: string; path: string }
export type LocalDrive = { path: string; label: string; kind: 'local' | 'removable' | 'network' | 'cd' }
export interface LocalPlaces { places: LocalPlace[]; drives: LocalDrive[] }

const EMPTY: LocalPlaces = { places: [], drives: [] }
// Shared by every path bar; main remembers its answer for 30s, so asking again is cheap
let last: LocalPlaces = EMPTY

/**
 * The usual folders and the drives of this PC (main's src/localPlaces.js), for the local path bar.
 * `refresh` asks again (a USB drive may have been plugged in since).
 */
export function useLocalPlaces(enabled: boolean): { places: LocalPlaces; refresh: () => void } {
  const [places, setPlaces] = useState<LocalPlaces>(last)

  const refresh = useCallback(() => {
    const read = window.electronAPI.localPlaces
    if (typeof read !== 'function') return
    read()
      .then((next) => {
        last = next
        setPlaces(next)
      })
      .catch(() => { /* the bar works without the list */ })
  }, [])

  useEffect(() => {
    if (enabled) refresh()
  }, [enabled, refresh])

  return { places, refresh }
}
