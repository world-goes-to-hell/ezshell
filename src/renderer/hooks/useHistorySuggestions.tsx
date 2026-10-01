import { useCallback, useId, useRef, useState } from 'react'
import type { Terminal } from 'xterm'
import { CommandSuggestPopup, type SuggestAnchor } from '../components/Terminal/CommandSuggestPopup'
import { useCommandHistoryStore } from '../stores/commandHistoryStore'
import {
  cellWidth,
  findSuggestions,
  isTypingInput,
  readTypedInput,
  resolveSuggestKey,
  type CursorBufferLike
} from '../lib/historySuggest'

interface SuggestState {
  items: string[]
  typed: string
  selected: number | null
  anchor: SuggestAnchor
}

const sameItems = (a: string[], b: string[]) => a.length === b.length && a.every((item, i) => item === b[i])

const sameState = (a: SuggestState, b: SuggestState) =>
  a.typed === b.typed && a.selected === b.selected && sameItems(a.items, b.items) &&
  a.anchor.left === b.anchor.left && a.anchor.top === b.anchor.top && a.anchor.bottom === b.anchor.bottom

/** IME composition (Korean input): the key finishes the syllable, it is not meant for the list */
const isComposing = (event: KeyboardEvent) => event.isComposing || event.keyCode === 229

/** Where the typed input starts on screen (start of the cursor row when the input wrapped) */
function anchorFor(term: Terminal, typed: string): SuggestAnchor | null {
  const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
  if (!screen || term.cols === 0 || term.rows === 0) return null
  const rect = screen.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  const cellW = rect.width / term.cols
  const cellH = rect.height / term.rows
  const { cursorX, cursorY } = term.buffer.active
  const startColumn = Math.max(0, cursorX - cellWidth(typed))
  return {
    left: rect.left + startColumn * cellW,
    top: rect.top + cursorY * cellH,
    bottom: rect.top + (cursorY + 1) * cellH
  }
}

/**
 * History autocomplete for one xterm pane: while the user types after a shell prompt, matching saved
 * commands of this connection are listed under the line. ↑↓ choose, Enter fills the line with the
 * choice (it does not run it), Esc closes. The terminal keeps focus the whole time.
 *
 * The terminal's key/data handlers are attached once when it is created, so the state they read
 * lives in refs.
 */
export function useHistorySuggestions(sessionId: string, insert: (command: string) => void) {
  const termRef = useRef<Terminal | null>(null)
  const insertRef = useRef(insert)
  insertRef.current = insert
  const [state, setState] = useState<SuggestState | null>(null)
  const stateRef = useRef<SuggestState | null>(null)
  // True after the user edited the line by hand; false after Enter, arrows, Tab, blur and the like
  const typingRef = useRef(false)
  // Esc keeps the list closed until the next character is typed
  const dismissedRef = useRef(false)
  // A key handled on keydown: its auto-repeat, keypress and keyup must not reach xterm (Enter would send "\r")
  const swallowedKeyRef = useRef<string | null>(null)
  // Output can arrive in many small writes; recompute once per frame
  const frameRef = useRef<number | null>(null)
  const optionIdPrefix = useId()
  const optionId = (index: number) => `${optionIdPrefix}-option-${index}`

  /** Screen readers follow the selected option while focus stays in the terminal's textarea */
  const syncA11y = useCallback((next: SuggestState | null) => {
    const textarea = termRef.current?.textarea
    if (!textarea) return
    if (next?.selected != null) textarea.setAttribute('aria-activedescendant', optionId(next.selected))
    else textarea.removeAttribute('aria-activedescendant')
  }, [])

  const update = useCallback((next: SuggestState | null) => {
    const current = stateRef.current
    if (next === null ? current === null : current !== null && sameState(current, next)) return
    stateRef.current = next
    setState(next)
    syncA11y(next)
  }, [syncA11y])

  const compute = useCallback(() => {
    frameRef.current = null
    const term = termRef.current
    if (!term || !typingRef.current || dismissedRef.current) return update(null)
    // Output may land in a pane the user has left; the list only belongs to the focused terminal
    if (document.activeElement !== term.textarea) return update(null)
    const buffer = term.buffer.active
    // vim, less, top and other full-screen programs draw on the alternate buffer
    if (buffer.type !== 'normal') return update(null)
    const typed = readTypedInput(buffer as unknown as CursorBufferLike)
    if (!typed) return update(null)

    const { keyBySession, entriesByKey } = useCommandHistoryStore.getState()
    const key = keyBySession[sessionId]
    const items = findSuggestions(key ? entriesByKey[key] ?? [] : [], typed)
    const anchor = anchorFor(term, typed)
    if (items.length === 0 || !anchor) return update(null)

    const prev = stateRef.current
    update({ items, typed, anchor, selected: prev && sameItems(prev.items, items) ? prev.selected : null })
  }, [sessionId, update])

  const refresh = useCallback(() => {
    if (!typingRef.current) return
    if (frameRef.current === null) frameRef.current = requestAnimationFrame(compute)
  }, [compute])

  const reset = useCallback(() => {
    typingRef.current = false
    swallowedKeyRef.current = null
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    update(null)
  }, [update])

  const attach = useCallback((term: Terminal) => {
    termRef.current = term
    const parsed = term.onWriteParsed(refresh)
    const resized = term.onResize(() => update(null))
    const scrolled = term.onScroll(() => update(null))
    const textarea = term.textarea
    textarea?.addEventListener('blur', reset)
    return () => {
      parsed.dispose()
      resized.dispose()
      scrolled.dispose()
      textarea?.removeEventListener('blur', reset)
      reset()
      if (termRef.current === term) termRef.current = null
    }
  }, [refresh, reset, update])

  /** Call from term.onData: typing opens / narrows the list; anything else closes it */
  const handleData = useCallback((data: string) => {
    if (isTypingInput(data)) {
      typingRef.current = true
      dismissedRef.current = false
      return
    }
    typingRef.current = false
    update(null)
  }, [update])

  /** Call from attachCustomKeyEventHandler; true means the key belongs to the list and xterm must ignore it */
  const handleKeyEvent = useCallback((event: KeyboardEvent) => {
    if (swallowedKeyRef.current === event.key) {
      if (event.type === 'keyup') swallowedKeyRef.current = null
      // keypress / keyup of the handled key, or its auto-repeat (holding Enter must not run the filled line)
      if (event.type !== 'keydown' || event.repeat) return true
      swallowedKeyRef.current = null
    }
    const current = stateRef.current
    if (!current || event.type !== 'keydown' || isComposing(event)) return false

    const action = resolveSuggestKey(event, current.items.length, current.selected)
    if (action.type === 'pass') return false
    if (action.type === 'close' && action.passThrough) {
      update(null)
      return false
    }

    swallowedKeyRef.current = event.key
    if (action.type === 'select') {
      update({ ...current, selected: action.index })
    } else if (action.type === 'accept') {
      typingRef.current = false
      update(null)
      insertRef.current(current.items[action.index])
    } else {
      dismissedRef.current = true
      update(null)
    }
    return true
  }, [update])

  const pick = (index: number) => {
    const current = stateRef.current
    if (!current) return
    typingRef.current = false
    update(null)
    insertRef.current(current.items[index])
  }

  const popup = state ? (
    <CommandSuggestPopup
      items={state.items}
      typed={state.typed}
      selected={state.selected}
      anchor={state.anchor}
      optionId={optionId}
      onPick={pick}
    />
  ) : null

  return { attach, handleData, handleKeyEvent, popup }
}
