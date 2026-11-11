// Which xterm a right-click landed on: the tab's main terminal or one of its split shells. Each
// registers the element it is drawn in; the menu then copies from, pastes into and clears that one.
import type { Terminal } from 'xterm'

const panes = new Map<Element, Terminal>()

/** Returns the function that removes the registration (only if it is still this terminal's) */
export function registerTerminalPane(element: Element, terminal: Terminal): () => void {
  panes.set(element, terminal)
  return () => {
    if (panes.get(element) === terminal) panes.delete(element)
  }
}

/** The terminal drawn in the element or in one of its ancestors */
export function terminalPaneAt(target: EventTarget | null): Terminal | null {
  let element = target instanceof Element ? target : null
  while (element) {
    const terminal = panes.get(element)
    if (terminal) return terminal
    element = element.parentElement
  }
  return null
}
