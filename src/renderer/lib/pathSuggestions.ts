import type { PathSuggestion } from '../components/Sftp/PathBookmarkSuggestions'
import type { LocalDrive, LocalPlace } from '../hooks/useLocalPlaces'

/**
 * The list under a path input: bookmarks first, then (local side only) the usual folders and the
 * drives, like the Windows explorer's address bar. Typing filters by name or path; a path already
 * listed is not repeated (a bookmark wins).
 */
export function buildPathSuggestions({ bookmarks, places, drives, query, isLocal }: {
  bookmarks: string[]
  places: LocalPlace[]
  drives: LocalDrive[]
  query: string
  isLocal: boolean
}): PathSuggestion[] {
  const all: PathSuggestion[] = [
    ...bookmarks.map(path => ({ section: 'bookmark' as const, path, label: path })),
    ...(isLocal ? places.map(place => ({ section: 'place' as const, path: place.path, label: place.label, kind: place.kind })) : []),
    ...(isLocal ? drives.map(drive => ({ section: 'drive' as const, path: drive.path, label: drive.label, kind: drive.kind })) : [])
  ]
  const seen = new Set<string>()
  const unique = all.filter((item) => {
    const key = item.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const q = query.trim().toLowerCase()
  if (!q) return unique
  return unique.filter(item => item.label.toLowerCase().includes(q) || item.path.toLowerCase().includes(q))
}
