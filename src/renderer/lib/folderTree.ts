import type { Folder } from '../stores/sessionStore'

/** Children of each folder in stored order; top-level folders are under `undefined`. */
export function groupFoldersByParent(folders: readonly Folder[]): Map<string | undefined, Folder[]> {
  const byParent = new Map<string | undefined, Folder[]>()
  for (const folder of folders) {
    byParent.set(folder.parentId, [...(byParent.get(folder.parentId) ?? []), folder])
  }
  return byParent
}

/** Ids of a folder's ancestors, so a tree can open with that folder visible. Stops on parent cycles. */
export function ancestorIds(folders: readonly Folder[], folderId?: string): Set<string> {
  const byId = new Map(folders.map(f => [f.id, f]))
  const result = new Set<string>()
  let parentId = folderId ? byId.get(folderId)?.parentId : undefined
  while (parentId && !result.has(parentId)) {
    result.add(parentId)
    parentId = byId.get(parentId)?.parentId
  }
  return result
}
