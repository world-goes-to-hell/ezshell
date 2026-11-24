import type { BrowserBookmarkEntry, BrowserBookmarkFolder } from '../types'

export interface BookmarkNode {
  entry: BrowserBookmarkEntry
  key: string
  parents: BrowserBookmarkFolder[]
  children: BookmarkNode[]
  contextOnly?: boolean
}

export function bookmarkTree(entries: readonly BrowserBookmarkEntry[], parents: BrowserBookmarkFolder[] = [], prefix = ''): BookmarkNode[] {
  const occurrences = new Map<string, number>()
  return entries.map(entry => {
    const part = entry.kind === 'folder' ? JSON.stringify([entry.id]) : JSON.stringify([entry.url, entry.title])
    const occurrence = occurrences.get(part) ?? 0
    occurrences.set(part, occurrence + 1)
    const key = `${prefix}${part}#${occurrence}/`
    const children = entry.kind === 'folder' ? bookmarkTree(entry.children, [...parents, entry], key) : []
    return { entry, key, parents, children }
  })
}

/** Keep the path to each match. A matching folder also shows its contents. */
export function searchBookmarkTree(nodes: BookmarkNode[], search: string): BookmarkNode[] {
  if (!search) return nodes
  return nodes.flatMap(node => {
    const { entry } = node
    const text = entry.kind === 'folder' ? entry.title : `${entry.title} ${entry.url}`
    if (text.toLowerCase().includes(search)) return [node]
    const children = searchBookmarkTree(node.children, search)
    return children.length ? [{ ...node, children, contextOnly: true }] : []
  })
}

export function* bookmarkNodes(nodes: readonly BookmarkNode[]): Generator<BookmarkNode> {
  for (const node of nodes) {
    yield node
    yield* bookmarkNodes(node.children)
  }
}

export function* visibleBookmarkNodes(nodes: readonly BookmarkNode[], isOpen: (key: string) => boolean): Generator<BookmarkNode> {
  for (const node of nodes) {
    yield node
    if (node.entry.kind === 'folder' && isOpen(node.key)) yield* visibleBookmarkNodes(node.children, isOpen)
  }
}
