import type { AgentChatItem } from '../types'

/** Items a chat view keeps; past this the oldest go (scrolling up reads them again only after reopening) */
export const MAX_CHAT_ITEMS = 3000

/**
 * The view's items after a frame: `reset` starts over, `append` adds at the end, `older` adds before.
 * An item already there is replaced in place (a tool gets its result on a later line).
 */
export function mergeChatItems(current: readonly AgentChatItem[], incoming: readonly AgentChatItem[], mode: 'reset' | 'append' | 'older'): AgentChatItem[] {
  if (mode === 'reset') return incoming.slice(-MAX_CHAT_ITEMS)
  const at = new Map(current.map((item, index) => [item.id, index]))
  const next = current.slice()
  const fresh: AgentChatItem[] = []
  for (const item of incoming) {
    const index = at.get(item.id)
    if (index !== undefined) next[index] = item
    else {
      at.set(item.id, -1)
      fresh.push(item)
    }
  }
  if (mode === 'append') {
    const all = next.concat(fresh)
    return all.length > MAX_CHAT_ITEMS ? all.slice(-MAX_CHAT_ITEMS) : all
  }
  // Older items fill only the room left: the newest of them, next to what is shown
  const room = Math.max(0, MAX_CHAT_ITEMS - next.length)
  return fresh.slice(fresh.length - Math.min(room, fresh.length)).concat(next)
}

/** The latest live agent of a local shell (a shell can have run several, one after another) */
export function shellAgentOf<T extends { active: boolean; shellId: string }>(agents: readonly T[], shellId: string): T | undefined {
  for (let index = agents.length - 1; index >= 0; index--) {
    if (agents[index].active && agents[index].shellId === shellId) return agents[index]
  }
  return undefined
}

/** A diff line's look: added, removed, a hunk or file header, or context */
export function diffLineKind(line: string): 'add' | 'remove' | 'hunk' | 'context' {
  if (line.startsWith('@@') || line.startsWith('***')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  return 'context'
}
