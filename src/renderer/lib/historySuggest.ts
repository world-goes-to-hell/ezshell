/**
 * History autocomplete for the terminal input line: what has been typed so far, which saved
 * commands match it, and what a key does while the suggestion list is open.
 */
import type { CommandHistoryEntry } from '../types'
import { textAfterPrompt, type BufferLike } from './commandCapture'

export const MIN_TYPED_LENGTH = 2
export const MAX_SUGGESTIONS = 8

type LineLike = NonNullable<ReturnType<BufferLike['getLine']>> & {
  translateToString: (trimRight?: boolean, startColumn?: number, endColumn?: number) => string
}

/** The parts of xterm's IBuffer read here (cursor column included) */
export interface CursorBufferLike {
  baseY: number
  cursorY: number
  cursorX: number
  getLine: (y: number) => LineLike | undefined
}

/**
 * Text typed after the prompt up to the cursor, joined across soft-wrapped rows.
 * Null when nothing should be suggested: no shell prompt on the line (password prompts, heredoc
 * bodies, output), the cursor is not at the end of the input, the input starts with a space
 * (kept out of history) or is shorter than MIN_TYPED_LENGTH.
 */
export function readTypedInput(buffer: CursorBufferLike): string | null {
  const cursorRow = buffer.baseY + buffer.cursorY
  const cursorLine = buffer.getLine(cursorRow)
  if (!cursorLine) return null

  // Anything after the cursor (on this row or a wrapped continuation) means the user is editing mid-line
  if (cursorLine.translateToString(true, buffer.cursorX).length > 0) return null
  if (buffer.getLine(cursorRow + 1)?.isWrapped) return null

  let first = cursorRow
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  const rows: string[] = []
  for (let y = first; y < cursorRow; y++) rows.push(buffer.getLine(y)?.translateToString(false) ?? '')
  rows.push(cursorLine.translateToString(false, 0, buffer.cursorX))

  const typed = textAfterPrompt(rows.join(''))
  if (typed === null || typed.startsWith(' ') || typed.trim().length < MIN_TYPED_LENGTH) return null
  return typed
}

/**
 * Saved commands for the input: ones starting with it first, then ones containing it,
 * each group in history order (most recent first). The exact input itself is left out.
 */
export function findSuggestions(entries: readonly CommandHistoryEntry[], typed: string, limit = MAX_SUGGESTIONS): string[] {
  const others = entries.map(entry => entry.command).filter(command => command !== typed)
  const starting = others.filter(command => command.startsWith(typed))
  const containing = others.filter(command => !command.startsWith(typed) && command.includes(typed))
  return [...starting, ...containing].slice(0, limit)
}

export type SuggestKeyAction =
  | { type: 'select'; index: number }
  | { type: 'accept'; index: number }
  | { type: 'close'; passThrough: boolean }
  | { type: 'pass' }

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

/**
 * What a key does while the list is open. Nothing is selected at first, so an Enter typed out
 * of habit runs the line as typed instead of a suggestion; Enter on a selected item only fills the line.
 */
export function resolveSuggestKey(event: KeyLike, count: number, selected: number | null): SuggestKeyAction {
  if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || count === 0) return { type: 'pass' }
  switch (event.key) {
    case 'ArrowDown':
      return { type: 'select', index: selected === null ? 0 : (selected + 1) % count }
    case 'ArrowUp':
      return { type: 'select', index: selected === null ? count - 1 : (selected - 1 + count) % count }
    case 'Enter':
      return selected === null ? { type: 'close', passThrough: true } : { type: 'accept', index: selected }
    case 'Escape':
      return { type: 'close', passThrough: false }
    case 'Tab':
      return { type: 'close', passThrough: true }
    default:
      return { type: 'pass' }
  }
}

// Enter, Ctrl+C, Ctrl+D, Tab (the shell's own completion) and escape sequences (arrows, ↑ history recall, Esc)
const NON_TYPING_INPUT = new Set(['\r', '\x03', '\x04', '\t'])

/**
 * True for input that edits the line by hand (characters, backspace, paste). Only then do suggestions
 * open: a command recalled with ↑ must not open the list, or the next ↑ would go to the list
 * instead of the shell's history.
 */
export function isTypingInput(data: string): boolean {
  return !NON_TYPING_INPUT.has(data) && !data.startsWith('\x1b')
}

// East Asian wide ranges that take two terminal columns (Hangul, CJK, full-width forms)
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd]
]

const isWide = (codePoint: number) => WIDE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to)

/** Terminal columns the text takes (xterm draws wide characters over two cells) */
export function cellWidth(text: string): number {
  let width = 0
  for (const char of text) width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1
  return width
}
