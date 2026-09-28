import type { Folder } from '../stores/sessionStore'

/**
 * Full path of a folder, e.g. "개발 / [개발] MBRIS".
 * Guards against parent cycles in stored data.
 */
export function getFolderPath(folders: Folder[], folderId: string): string {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const names: string[] = []
  const visited = new Set<string>()
  let current = byId.get(folderId)
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    names.unshift(current.name)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return names.join(' / ')
}
