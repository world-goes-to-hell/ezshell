import { useCallback, useMemo, useRef, useState } from 'react'
import type { Terminal } from 'xterm'
import { CommandHistoryPopup } from '../components/Terminal/CommandHistoryPopup'
import { useCommandHistoryStore } from '../stores/commandHistoryStore'
import { useHistorySuggestions } from './useHistorySuggestions'
import { useCommandRecorder } from './useCommandRecorder'
import { buildInsertSequence, isHistoryShortcut } from '../lib/commandCapture'
import {
  registerMainInputTarget,
  setFocusedInputTarget,
  unregisterInputTarget,
  type InputTarget
} from '../lib/terminalInputTargets'

type PaneRole = 'main' | 'split'

/**
 * Command history wiring for one xterm pane (a tab's main terminal or a split):
 * records commands on Enter, opens the Ctrl+Shift+H popup, suggests saved commands while typing, and registers the pane as the
 * insert target for the history panel. Terminals are created inside effects, so the pane
 * hands its instance over with attach() and routes key/data events through the returned handlers.
 */
export function useTerminalCommandHistory(sessionId: string, role: PaneRole, send: (data: string) => void) {
  const termRef = useRef<Terminal | null>(null)
  const sendRef = useRef(send)
  sendRef.current = send
  const [popupAnchor, setPopupAnchor] = useState<DOMRect | null>(null)

  const recorder = useCommandRecorder(sessionId)
  const noteLineReplacedRef = useRef(recorder.noteLineReplaced)
  noteLineReplacedRef.current = recorder.noteLineReplaced

  const target = useMemo<InputTarget>(() => ({
    insert: (command) => {
      noteLineReplacedRef.current()
      sendRef.current(buildInsertSequence(command))
      termRef.current?.focus()
    }
  }), [])

  const suggestions = useHistorySuggestions(sessionId, (command) => target.insert(command))

  const attach = useCallback((term: Terminal) => {
    termRef.current = term
    const detachSuggestions = suggestions.attach(term)
    const detachRecorder = recorder.attach(term)
    if (role === 'main') registerMainInputTarget(sessionId, target)
    const handleFocus = () => setFocusedInputTarget(sessionId, target)
    const textarea = term.textarea
    textarea?.addEventListener('focus', handleFocus)
    // Resolve the history key early so the first Enter is not slowed down by the lookup
    useCommandHistoryStore.getState().resolveKey(sessionId)

    return () => {
      detachRecorder()
      detachSuggestions()
      textarea?.removeEventListener('focus', handleFocus)
      unregisterInputTarget(sessionId, target)
      if (termRef.current === term) termRef.current = null
    }
  }, [sessionId, role, target, suggestions.attach, recorder.attach])

  /** Call from term.onData before sending: feeds the suggestions and records commands on Enter. */
  const handleData = useCallback((data: string) => {
    suggestions.handleData(data)
    recorder.handleData(data)
  }, [suggestions.handleData, recorder.handleData])

  /** Call from attachCustomKeyEventHandler; true means the event was handled and xterm must ignore it. */
  const handleKeyEvent = useCallback((event: KeyboardEvent) => {
    // While the suggestion list is open, ↑↓ / Enter / Esc belong to it
    if (suggestions.handleKeyEvent(event)) return true
    if (!isHistoryShortcut(event)) return false
    const term = termRef.current
    if (event.type === 'keydown' && term?.element && term.buffer.active.type === 'normal') {
      setPopupAnchor(term.element.getBoundingClientRect())
    }
    return true
  }, [suggestions.handleKeyEvent])

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

  return {
    attach,
    handleData,
    handleKeyEvent,
    popup: (
      <>
        {popup}
        {suggestions.popup}
      </>
    )
  }
}
