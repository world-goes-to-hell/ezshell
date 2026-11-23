// The color a saved session shows: its own, or else the nearest folder color up its folder chain
// (the rule the session list, the tab and the MCP approval dialog already use).

interface ColoredFolder { id: string; parentId?: string; backgroundColor?: string }
interface ColoredSession { backgroundColor?: string; folderId?: string }

export function effectiveSessionColor(session: ColoredSession | undefined, folders: readonly ColoredFolder[]): string | undefined {
  if (!session) return undefined
  if (session.backgroundColor) return session.backgroundColor
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const seen = new Set<string>()
  for (let id = session.folderId; id && !seen.has(id); id = byId.get(id)?.parentId) {
    seen.add(id)
    const color = byId.get(id)?.backgroundColor
    if (color) return color
  }
  return undefined
}
