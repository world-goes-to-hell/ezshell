import { useCallback, useRef } from 'react'
import type { IMarker, Terminal } from 'xterm'
import { useCommandHistoryStore } from '../stores/commandHistoryStore'
import { appendTypedInput, extractCommand, readInputLine, type TypedInput } from '../lib/commandCapture'

// Read the line anyway if the shell never answers Enter with a newline (e.g. a program reading the line raw)
const RECORD_FALLBACK_MS = 2000
// A command typed ahead of the echo is matched against finished lines for this long
const TYPED_AHEAD_TTL_MS = 10_000

const NOTHING_TYPED: TypedInput = { text: '', certain: true }

/**
 * Records the commands run in one xterm pane into the connection's history.
 *
 * The line is not read at Enter: the shell's echo can still be on its way (slow link, fast typing), which
 * recorded a cut-off command or nothing. Instead the row is marked at Enter and read when the shell answers
 * with a newline; by then everything typed before Enter has been echoed.
 *
 * Typing the next command before the shell answered the previous Enter puts the cursor on the same,
 * unfinished row, so that row cannot be marked. Such a command is remembered as typed and recorded only when
 * a finished line shows exactly it after a prompt, so command output (e.g. "# comment" lines) is never taken
 * for a command.
 */
export function useCommandRecorder(sessionId: string) {
  const termRef = useRef<Terminal | null>(null)
  const pendingRef = useRef<{ marker: IMarker; timer: ReturnType<typeof setTimeout> } | null>(null)
  const typedRef = useRef<TypedInput>(NOTHING_TYPED)
  const typedAheadRef = useRef<{ text: string; expiresAt: number }[]>([])

  const record = useCallback((command: string) => {
    useCommandHistoryStore.getState().record(sessionId, command)
  }, [sessionId])

  const settlePending = useCallback(() => {
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    clearTimeout(pending.timer)
    const row = pending.marker.line
    pending.marker.dispose()
    const term = termRef.current
    if (!term || row < 0) return
    // The normal buffer: a command may have switched to the alternate screen (vim) right after the echo
    const command = extractCommand(readInputLine(term.buffer.normal, row))
    if (command) record(command)
  }, [record])

  const matchTypedAhead = useCallback((term: Terminal) => {
    const now = Date.now()
    typedAheadRef.current = typedAheadRef.current.filter(entry => entry.expiresAt > now)
    const next = typedAheadRef.current[0]
    if (!next) return
    // The line feed just moved the cursor down: the finished line is the row above it
    const buffer = term.buffer.normal
    const finishedRow = buffer.baseY + buffer.cursorY - 1
    if (finishedRow < 0) return
    const command = extractCommand(readInputLine(buffer, finishedRow))
    if (command !== next.text) return
    typedAheadRef.current = typedAheadRef.current.slice(1)
    record(command)
  }, [record])

  const attach = useCallback((term: Terminal) => {
    termRef.current = term
    // The shell answers Enter with a newline after echoing everything typed before it
    const lineFed = term.onLineFeed(() => {
      if (pendingRef.current) settlePending()
      else if (typedAheadRef.current.length > 0) matchTypedAhead(term)
    })
    return () => {
      settlePending()
      lineFed.dispose()
      typedAheadRef.current = []
      typedRef.current = NOTHING_TYPED
      if (termRef.current === term) termRef.current = null
    }
  }, [settlePending, matchTypedAhead])

  /** Call from term.onData for every chunk the user sends */
  const handleData = useCallback((data: string) => {
    const term = termRef.current
    // Only a typed Enter: pasted text arrives as one chunk and may contain several lines
    if (data !== '\r') {
      typedRef.current = appendTypedInput(typedRef.current, data)
      return
    }
    const typed = typedRef.current
    typedRef.current = NOTHING_TYPED
    // vim, less, top and other full-screen programs draw on the alternate buffer
    if (!term || term.buffer.active.type !== 'normal') return

    if (pendingRef.current) {
      // The shell has not answered the previous Enter yet: this command was typed ahead of the echo
      const text = typed.text.trimEnd()
      if (typed.certain && text.trim().length > 0) {
        typedAheadRef.current = [...typedAheadRef.current, { text, expiresAt: Date.now() + TYPED_AHEAD_TTL_MS }]
      }
      return
    }
    const marker = term.registerMarker(0)
    if (!marker) return
    pendingRef.current = { marker, timer: setTimeout(settlePending, RECORD_FALLBACK_MS) }
  }, [settlePending])

  /** The line was replaced without keystrokes (history insert): the typed text no longer describes it */
  const noteLineReplaced = useCallback(() => {
    typedRef.current = { text: '', certain: false }
  }, [])

  return { attach, handleData, noteLineReplaced }
}
