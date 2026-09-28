import { useCallback, useMemo, useRef, useState } from 'react'
import type { Terminal } from 'xterm'
import { CommandHistoryPopup } from '../components/Terminal/CommandHistoryPopup'
import { useCommandHistoryStore } from '../stores/commandHistoryStore'
import { buildInsertSequence, extractCommand, isHistoryShortcut, readInputLine } from '../lib/commandCapture'
import {
  registerMainInputTarget,
  setFocusedInputTarget,
  unregisterInputTarget,
  type InputTarget
} from '../lib/terminalInputTargets'

type PaneRole = 'main' | 'split'

/**
 * Command history wiring for one xterm pane (a tab's main terminal or a split):
 * records commands on Enter, opens the Ctrl+Shift+H popup, and registers the pane as the
 * insert target for the history panel. Terminals are created inside effects, so the pane
 * hands its instance over with attach() and routes key/data events through the returned handlers.
 */
export function useTerminalCommandHistory(sessionId: string, role: PaneRole, send: (data: string) => void) {
  const termRef = useRef<Terminal | null>(null)
  const sendRef = useRef(send)
  sendRef.current = send
  const [popupAnchor, setPopupAnchor] = useState<DOMRect | null>(null)

  const target = useMemo<InputTarget>(() => ({
    insert: (command) => {
      sendRef.current(buildInsertSequence(command))
      termRef.current?.focus()
    }
  }), [])

  const attach = useCallback((term: Terminal) => {
    termRef.current = term
    if (role === 'main') registerMainInputTarget(sessionId, target)
    const handleFocus = () => setFocusedInputTarget(sessionId, target)
    const textarea = term.textarea
    textarea?.addEventListener('focus', handleFocus)
    // Resolve the history key early so the first Enter is not slowed down by the lookup
    useCommandHistoryStore.getState().resolveKey(sessionId)

    return () => {
      textarea?.removeEventListener('focus', handleFocus)
      unregisterInputTarget(sessionId, target)
      if (termRef.current === term) termRef.current = null
    }
  }, [sessionId, role, target])

  /** Call from term.onData before sending; records the line when the user presses Enter. */
  const handleData = useCallback((data: string) => {
    const term = termRef.current
    // Only a typed Enter: pasted text arrives as one chunk and may contain several lines
    if (data !== '\r' || !term) return
    const buffer = term.buffer.active
    // vim, less, top and other full-screen programs draw on the alternate buffer
    if (buffer.type !== 'normal') return
    const command = extractCommand(readInputLine(buffer))
    if (command) useCommandHistoryStore.getState().record(sessionId, command)
  }, [sessionId])

  /** Call from attachCustomKeyEventHandler; true means the event was handled and xterm must ignore it. */
  const handleKeyEvent = useCallback((event: KeyboardEvent) => {
    if (!isHistoryShortcut(event)) return false
    const term = termRef.current
    if (event.type === 'keydown' && term?.element && term.buffer.active.type === 'normal') {
      setPopupAnchor(term.element.getBoundingClientRect())
    }
    return true
  }, [])

  const closePopup = useCallback(() => {
    setPopupAnchor(null)
    termRef.current?.focus()
  }, [])

  const popup = popupAnchor ? (
    <CommandHistoryPopup
      sessionId={sessionId}
      anchor={popupAnchor}
      onInsert={(command) => {
        setPopupAnchor(null)
        target.insert(command)
      }}
      onClose={closePopup}
    />
  ) : null

  return { attach, handleData, handleKeyEvent, popup }
}
