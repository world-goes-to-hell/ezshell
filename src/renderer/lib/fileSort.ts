import type { FileItem } from '../stores/sftpStore'

export type FileSortKey = 'name' | 'owner' | 'permissions' | 'modifyTime' | 'size'
export type SortDirection = 'asc' | 'desc'

export interface FileSort {
  key: FileSortKey
  direction: SortDirection
}

export const DEFAULT_SORT: FileSort = { key: 'name', direction: 'asc' }

// Newest / largest first is what people look for, like Windows Explorer
const INITIAL_DIRECTION: Record<FileSortKey, SortDirection> = {
  name: 'asc',
  owner: 'asc',
  permissions: 'asc',
  modifyTime: 'desc',
  size: 'desc'
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' })

function sortValue(item: FileItem, key: FileSortKey): string | number | undefined {
  // Folder sizes are not meaningful; folders then fall back to name order
  if (key === 'size') return item.type === 'directory' ? 0 : item.size
  return item[key]
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return collator.compare(String(a), String(b))
}

/**
 * Sorted copy for the SFTP file list. Folders always come before files (in either direction),
 * entries missing the sort value go last, and ties fall back to name order.
 */
export function sortFileItems(files: readonly FileItem[], sort: FileSort): FileItem[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  return [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1

    const va = sortValue(a, sort.key)
    const vb = sortValue(b, sort.key)
    const aMissing = va === undefined || va === ''
    const bMissing = vb === undefined || vb === ''
    if (aMissing !== bMissing) return aMissing ? 1 : -1

    const primary = aMissing ? 0 : compareValues(va!, vb!) * sign
    if (primary !== 0) return primary
    const byName = sort.key === 'name' ? 0 : collator.compare(a.name, b.name)
    if (byName !== 0) return byName
    // The collator ignores case ("README" vs "readme"); code points keep the order stable
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/** Sort after clicking a column header: same column flips, another column starts in its natural direction. */
export function nextSort(current: FileSort, key: FileSortKey): FileSort {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  }
  return { key, direction: INITIAL_DIRECTION[key] }
}
