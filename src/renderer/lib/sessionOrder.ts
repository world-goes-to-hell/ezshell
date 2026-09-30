/**
 * Sidebar session ordering. The sidebar shows sessions in their stored order, so reordering
 * only rearranges the list; no separate order field is needed.
 */

export type DropPosition = 'before' | 'after'

interface Orderable {
  id: string
  folderId?: string
}

/**
 * New list with the dragged session placed before or after the target. The dragged session
 * takes the target's folder, so dropping onto a session in another folder also moves it there.
 */
export function reorderSession<T extends Orderable>(
  sessions: T[],
  draggedId: string,
  targetId: string,
  position: DropPosition
): T[] {
  if (draggedId === targetId) return sessions
  const dragged = sessions.find(s => s.id === draggedId)
  const target = sessions.find(s => s.id === targetId)
  if (!dragged || !target) return sessions

  const rest = sessions.filter(s => s.id !== draggedId)
  const targetIndex = rest.findIndex(s => s.id === targetId)
  const insertAt = position === 'before' ? targetIndex : targetIndex + 1
  const moved = { ...dragged, folderId: target.folderId }
  return [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)]
}

/** Top half of the row drops before it, bottom half after it. */
export function getDropPosition(rect: { top: number; height: number }, clientY: number): DropPosition {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}
