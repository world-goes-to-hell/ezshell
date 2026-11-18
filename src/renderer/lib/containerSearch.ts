// Finding containers by name in the container panel. Several words match any of them (OR); the
// containers that match go to the top with the matching letters marked, and every other container
// stays in the list below them in its usual order (a search never hides a running container).

const MAX_TERMS = 20
const MAX_TERM_LENGTH = 100

/** The words of a search: split at spaces, commas and `|`, without case, each once */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().split(/[\s,|]+/).map(word => word.slice(0, MAX_TERM_LENGTH)).filter(Boolean)
  return [...new Set(words)].slice(0, MAX_TERMS)
}

export interface NamePart { text: string; isMatch: boolean }

/**
 * The name cut into marked and unmarked parts, or null when no word is in it. Overlapping matches
 * of different words are marked as one stretch.
 */
export function matchName(name: string, terms: readonly string[]): NamePart[] | null {
  if (terms.length === 0) return null
  const lower = name.toLowerCase()
  const marked = new Array<boolean>(name.length).fill(false)
  let found = false
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + 1)) {
      found = true
      for (let i = at; i < at + term.length; i++) marked[i] = true
    }
  }
  if (!found) return null
  const parts: NamePart[] = []
  for (let i = 0; i < name.length; i++) {
    const last = parts[parts.length - 1]
    if (last && last.isMatch === marked[i]) last.text += name[i]
    else parts.push({ text: name[i], isMatch: marked[i] })
  }
  return parts
}

export interface SearchedRow<T> {
  item: T
  /** Marked parts of the name; null when it does not match (or nothing is searched) */
  parts: NamePart[] | null
}

/** Matching containers first, then all the others, each group in the order the server gave */
export function orderBySearch<T extends { name: string }>(items: readonly T[], terms: readonly string[]): SearchedRow<T>[] {
  const rows = items.map(item => ({ item, parts: matchName(item.name, terms) }))
  return [...rows.filter(row => row.parts), ...rows.filter(row => !row.parts)]
}
