import type { AgentChatItem } from '../types'
import { waitingItemIds, type ChatEcho } from './agentChatItems'
import { isSlashCommand } from './slashCommands'

/** Use the current chat's own text. Queued lines get priority over the turn being interrupted. */
export function chatLinesToTakeBack(items: readonly AgentChatItem[], echoes: readonly ChatEcho[], held: readonly string[]) {
  const waiting = waitingItemIds(items, echoes, held, 'working')
  const eligible = (item: AgentChatItem) => {
    const echo = echoes.find(echo => echo.id === item.id)
    const text = echo?.text ?? item.text
    const sentAt = echo?.time ?? item.sentAt
    if (sentAt === undefined || !text?.trim() || item.inboxNotice || item.hasImage || echo?.hasImage) return []
    if (!waiting.has(item.id) && isSlashCommand(text)) return []
    return [{ id: item.id, text, sentAt, optimistic: Boolean(echo) }]
  }
  if (waiting.size) return { queued: true, lines: items.filter(item => waiting.has(item.id)).flatMap(eligible) }
  const latest = [...items].reverse().find(item => item.kind === 'user' || item.interrupted)
  return { queued: false, lines: latest?.kind === 'user' ? eligible(latest) : [] }
}

type TakeBack = (texts: string[]) => Promise<{ ok: boolean; reason?: string }>

// Answers that will not change by asking again
const FINAL_REASONS = new Set(['invalid', 'locked', 'not-agent', 'write-failed', 'not-cleared'])

export interface TakeBackOptions {
  tries?: number
  delayMs?: number
  wait?: (ms: number) => Promise<void>
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The CLI may redraw the recovered lines a moment after Esc. Main clears only an exact match. */
export async function takeBackQueued(take: TakeBack, texts: string[], { tries = 12, delayMs = 200, wait = sleep }: TakeBackOptions = {}): Promise<boolean> {
  if (!texts.length) return false
  for (let attempt = 0; attempt < tries; attempt++) {
    await wait(delayMs)
    try {
      const result = await take(texts)
      if (result.ok) return true
      if (result.reason && FINAL_REASONS.has(result.reason)) return false
    } catch {
      return false
    }
  }
  return false
}

/** The chat box after taking lines back: they come first, then whatever was being typed */
export function draftWithTakenBack(texts: string[], draft: string): string {
  return [...texts, draft].filter(text => text.trim()).join('\n')
}
