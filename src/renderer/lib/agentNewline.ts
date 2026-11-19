// Shift+Enter in a local terminal running Claude Code or Codex adds a line instead of sending the prompt.
// xterm sends the same \r for Enter and Shift+Enter; both CLIs take ESC + Enter as "new line" (Claude
// Code's own /terminal-setup binds Shift+Enter to it; Codex checked on 0.170.0). Only while an agent
// runs in that shell: in a plain PowerShell, ESC clears the line being typed.

export const AGENT_NEWLINE = '\x1b\r'

type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing'>

/** Whether the key is Shift+Enter alone (not while an input method is composing) */
export const isShiftEnter = (event: KeyLike): boolean =>
  event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing

/** What to send for this key instead of xterm's own, or null to let xterm handle it */
export function agentNewlineFor(event: KeyLike, runsAgent: () => boolean): string | null {
  return isShiftEnter(event) && runsAgent() ? AGENT_NEWLINE : null
}
