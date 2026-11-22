// Esc in the chat view while a sent line waited: the CLI cancels its turn and puts the queued line(s) back
// into its composer a moment later (2026-11-22 user report: the line stayed there, the chat box stayed
// empty, and the next send was refused because the composer was not empty). Asks main to clear the
// composer until the CLI has put the lines back; main clears only an exact match.

type TakeBack = (texts: string[]) => Promise<{ ok: boolean; reason?: string }>

// Answers that will not change by asking again
const FINAL_REASONS = new Set(['invalid', 'locked', 'not-agent', 'write-failed', 'not-cleared'])

export interface TakeBackOptions {
  tries?: number
  delayMs?: number
  wait?: (ms: number) => Promise<void>
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** True once main cleared the composer of exactly these lines */
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
