import type { Terminal } from 'xterm'
import { toast, useToastStore } from '../stores/toastStore'

// A selection gesture ends on mouseup; waiting a tick lets xterm finish updating it
const SELECTION_SETTLE_MS = 0
const COPY_TOAST_DURATION_MS = 2000

/** Copy text to the clipboard and show a short confirmation toast. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    const lineCount = text.split('\n').length
    useToastStore.getState().addToast({
      type: 'success',
      title: '복사됨',
      message: lineCount > 1 ? `${lineCount}줄을 클립보드에 복사했습니다` : `${text.length}자를 클립보드에 복사했습니다`,
      duration: COPY_TOAST_DURATION_MS
    })
    return true
  } catch (error) {
    console.error('Failed to copy terminal selection:', error)
    toast.error('복사 실패', '클립보드에 접근할 수 없습니다')
    return false
  }
}

/**
 * Ctrl+V in the terminal. The caller returns false from xterm's custom key handler so xterm does
 * not send ^V; the browser still fires its native paste event, which xterm turns into input
 * (with bracketed paste and newline handling). Sending the clipboard ourselves as well pasted twice.
 * Matched on the physical key: with the Korean input mode on, event.key is 'ㅍ' instead of 'v'.
 */
export function isPasteShortcut(event: KeyboardEvent): boolean {
  return event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'KeyV'
}

/**
 * Copy-on-select: when a mouse drag (or double/triple click) selection ends,
 * copy it once. Listening to onSelectionChange instead would fire on every
 * mouse move while dragging and spam the toast.
 * Returns a cleanup function.
 */
export function enableCopyOnSelect(term: Terminal): () => void {
  const element = term.element
  if (!element) return () => {}

  let lastCopied = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const handleMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const selection = term.hasSelection() ? term.getSelection() : ''
      // Skip empty selections and re-copying the same text (e.g. clicking inside an existing selection)
      if (!selection.trim() || selection === lastCopied) return
      lastCopied = selection
      copyToClipboard(selection)
    }, SELECTION_SETTLE_MS)
  }

  // A drag that starts in the terminal often ends outside it (dragging past the line end onto a
  // side panel), so the mouseup is awaited on the document rather than on the terminal element
  const handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    document.addEventListener('mouseup', handleMouseUp, { capture: true, once: true })
  }

  // Once the selection is cleared, selecting the same text again should copy again
  const selectionListener = term.onSelectionChange(() => {
    if (!term.hasSelection()) lastCopied = ''
  })

  // Capture phase: xterm handles mousedown on inner layers and may stop it from bubbling
  element.addEventListener('mousedown', handleMouseDown, true)
  return () => {
    if (timer) clearTimeout(timer)
    element.removeEventListener('mousedown', handleMouseDown, true)
    document.removeEventListener('mouseup', handleMouseUp, true)
    selectionListener.dispose()
  }
}
