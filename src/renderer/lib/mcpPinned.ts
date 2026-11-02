import type { McpActivityItem, McpOutputPart } from '../types'
import { cleanTerminalText, isActiveState } from './mcpActivity'

/** A command that ends at once is not pinned: its card would appear and vanish, shaking the log below */
export const PIN_AFTER_MS = 3000
export const PINNED_OUTPUT_LINES = 3
/** Output is kept up to 512KB per request and this runs on every render, so only the end is read */
const OUTPUT_TAIL_CHARS = 16 * 1024

/** Requests still in progress after a moment, longest running first so a new one does not move the others */
export function pinnedRequests(items: McpActivityItem[], now: number): McpActivityItem[] {
  return items
    .filter(item => isActiveState(item.state) && now - item.startedAt >= PIN_AFTER_MS)
    .sort((a, b) => a.startedAt - b.startedAt)
}

/** The last lines a request printed, without blank ones */
export function lastOutputLines(parts: McpOutputPart[] | undefined, max: number = PINNED_OUTPUT_LINES): string[] {
  let tail = ''
  for (let index = (parts?.length ?? 0) - 1; index >= 0 && tail.length < OUTPUT_TAIL_CHARS; index -= 1) {
    tail = parts![index].text + tail
  }
  return cleanTerminalText(tail.slice(-OUTPUT_TAIL_CHARS))
    .split('\n')
    .filter(line => line.trim() !== '')
    .slice(-max)
}
