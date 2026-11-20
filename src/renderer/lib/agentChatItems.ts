import type { AgentChatItem } from '../types'

/** Items a chat view keeps; past this the oldest go (scrolling up reads them again only after reopening) */
export const MAX_CHAT_ITEMS = 3000

export interface ChatEcho {
  id: string
  text: string
  time: number
  hasImage: boolean
}

const IMAGE_PROMPT = '첨부 이미지를 열어 확인해 주세요.\n'

function isEchoOf(item: AgentChatItem, echo: ChatEcho, reset: boolean): boolean {
  // A first read can include an older, identical message. Providers may round to whole seconds.
  if (item.time === null ? reset : item.time < echo.time - 1000) return false
  let text = item.text?.replace(/\r\n?/g, '\n').trim() ?? ''
  if (echo.hasImage) {
    if (!text.startsWith(IMAGE_PROMPT)) return false
    const body = text.indexOf('\n\n', IMAGE_PROMPT.length)
    text = body === -1 ? '' : text.slice(body + 2).trim()
  }
  return text === echo.text
}

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

/** Turn immediate echoes into transcript items without appending a second copy. */
export function reconcileChatEchoes(current: AgentChatItem[], incoming: AgentChatItem[], mode: 'reset' | 'append' | 'older', echoes: ChatEcho[]) {
  const recorded = new Map<string, AgentChatItem>()
  if (!echoes.length || mode === 'older') return { items: mergeChatItems(current, incoming, mode), echoes, recorded }

  const known = new Set(current.map(item => item.id))
  for (const item of incoming) {
    if (item.kind !== 'user' || known.has(item.id)) continue
    known.add(item.id)
    const echo = echoes.find(entry => !recorded.has(entry.id) && isEchoOf(item, entry, mode === 'reset'))
    if (echo) recorded.set(echo.id, item)
  }

  const unmatched = echoes.filter(echo => !recorded.has(echo.id))
  const localIds = new Set(echoes.map(echo => echo.id))
  const retained = new Map(current.filter(item => localIds.has(item.id)).map(item => [item.id, item]))
  const items = mergeChatItems(current.filter(item => !localIds.has(item.id)), incoming, mode)
  for (const echo of unmatched) {
    const item = retained.get(echo.id)
    if (!item) continue
    const next = items.findIndex(entry => entry.time !== null && entry.time > echo.time)
    if (next < 0) items.push(item)
    else items.splice(next, 0, item)
  }
  const shown = items.slice(-MAX_CHAT_ITEMS)
  const shownIds = new Set(shown.map(item => item.id))
  return { items: shown, echoes: unmatched.filter(echo => shownIds.has(echo.id)), recorded }
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
