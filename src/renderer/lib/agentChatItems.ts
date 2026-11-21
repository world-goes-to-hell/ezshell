import type { AgentChatItem, AgentChatSubagentActivity } from '../types'

/** Items a chat view keeps; past this the oldest go (scrolling up reads them again only after reopening) */
export const MAX_CHAT_ITEMS = 3000

export interface ChatEcho {
  id: string
  text: string
  time: number
  hasImage: boolean
}

const LEGACY_IMAGE_PROMPT = '첨부 이미지를 열어 확인해 주세요.'
const NATIVE_IMAGE_PREFIX = /^(?:\[Image #[1-9]\d*\]\s*)+/
const STORED_IMAGE_PATH = /(?:^|[/\\])ezshell-clipboard-[\w-]+[/\\][a-f0-9-]{36}\.png$/i

/** An older main process can send the token or the prefix clipped by the transcript reader. */
export function subagentDisplayText(value: string, kind: 'claude' | 'codex' | null): string {
  if (kind !== 'codex') return value
  return /^gAAAA[A-Za-z0-9_-]{65,}={0,2}(?:\s*…)?$/.test(value.trim()) ? '' : value
}

type ReadSubagentActivity = (shellId: string, agentId: string) => Promise<AgentChatSubagentActivity[]>
export type SubagentActivityResult = AgentChatSubagentActivity[] | 'restart-required' | 'unavailable'

export async function readSubagentActivity(read: ReadSubagentActivity | undefined, shellId: string, agentId: string): Promise<SubagentActivityResult> {
  if (!read) return 'restart-required'
  try {
    return await read(shellId, agentId)
  } catch (error) {
    return /no handler registered for ['"]agent-chat-subagent-preview['"]/i.test(String(error)) ? 'restart-required' : 'unavailable'
  }
}

function isEchoOf(item: AgentChatItem, echo: ChatEcho, reset: boolean): boolean {
  // A first read can include an older, identical message. Providers may round to whole seconds.
  if (item.time === null ? reset : item.time < echo.time - 1000) return false
  const message = item.text?.replace(/\r\n?/g, '\n').trim() ?? ''
  if (!echo.hasImage) return !item.hasImage && message === echo.text

  const tokens = NATIVE_IMAGE_PREFIX.exec(message)?.[0]
  const text = tokens ? message.slice(tokens.length) : message
  const native = Boolean(tokens || item.hasImage)
  if (native && text === echo.text) return true
  const attached = text === LEGACY_IMAGE_PROMPT || text.startsWith(LEGACY_IMAGE_PROMPT + '\n')
    ? text.slice(LEGACY_IMAGE_PROMPT.length).trim() : text
  if (native && attached === echo.text) return true

  const [paths, ...body] = attached.split('\n\n')
  return paths.split('\n').every(path => STORED_IMAGE_PATH.test(path)) && body.join('\n\n').trim() === echo.text
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

function matchChatEchoes(known: Set<string>, incoming: AgentChatItem[], echoes: ChatEcho[], reset: boolean) {
  const recorded = new Map<string, AgentChatItem>()
  if (!echoes.length) return recorded
  for (const item of incoming) {
    if (item.kind !== 'user' || known.has(item.id)) continue
    known.add(item.id)
    const echo = echoes.find(entry => !recorded.has(entry.id) && isEchoOf(item, entry, reset))
    if (echo) recorded.set(echo.id, item)
  }
  return recorded
}

function insertChatEchoes(items: AgentChatItem[], current: AgentChatItem[], echoes: ChatEcho[]) {
  if (!echoes.length) return items
  const retained = new Map(current.map(item => [item.id, item]))
  for (const echo of echoes) {
    const item = retained.get(echo.id)
    if (!item) continue
    const next = items.findIndex(entry => entry.time !== null && entry.time > echo.time)
    if (next < 0) items.push(item)
    else items.splice(next, 0, item)
  }
  return items
}

/** Turn immediate echoes into transcript items without appending a second copy. */
export function reconcileChatEchoes(current: AgentChatItem[], incoming: AgentChatItem[], mode: 'reset' | 'append' | 'older', echoes: ChatEcho[]) {
  if (!echoes.length || mode === 'older') {
    return { items: mergeChatItems(current, incoming, mode), echoes, recorded: new Map<string, AgentChatItem>() }
  }
  const recorded = matchChatEchoes(new Set(current.map(item => item.id)), incoming, echoes, mode === 'reset')
  const unmatched = echoes.filter(echo => !recorded.has(echo.id))
  const localIds = new Set(echoes.map(echo => echo.id))
  const items = insertChatEchoes(mergeChatItems(current.filter(item => !localIds.has(item.id)), incoming, mode), current, unmatched)
  const shown = items.slice(-MAX_CHAT_ITEMS)
  const shownIds = new Set(shown.map(item => item.id))
  return { items: shown, echoes: unmatched.filter(echo => shownIds.has(echo.id)), recorded }
}

export function chatTextForClipboard(transcript: AgentChatItem[], visible: AgentChatItem[], echoes: ChatEcho[], agentName: string): string {
  const recorded = matchChatEchoes(new Set(), transcript, echoes, true)
  const items = insertChatEchoes(transcript.slice(), visible, echoes.filter(echo => !recorded.has(echo.id)))
  return items.flatMap(({ kind, text, hasImage }) => {
    if (kind === 'user' && hasImage && !text) return ['나\n스크린샷 첨부']
    if (!text?.trim()) return []
    if (kind === 'user') return ['나\n' + text]
    if (kind === 'assistant') return [agentName + '\n' + text]
    return kind === 'notice' ? [text] : []
  }).join('\n\n')
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
