// The right button of a terminal that has a right-click menu belongs to the app. With mouse reporting on
// (Codex, Claude Code, vim, htop), xterm also sends the click to the program, and Codex pastes the
// clipboard into its composer on a right click: opening the menu typed the clipboard into the agent
// (2026-11-20 user report; the chat view then refused to send, the composer not being empty).

const SGR_REPORT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
// The default encoding: ESC [ M and three bytes (button, column, row, each + 32)
const DEFAULT_REPORT = /\x1b\[M([\s\S])[\s\S]{2}/g
const WHEEL = 64
const isRightButton = (code: number) => !(code & WHEEL) && (code & 3) === 2

/**
 * A filter for what xterm sends to the shell: drops the mouse reports of the right button (press, drag,
 * release) and keeps everything else. One per terminal: the default encoding's release does not say
 * which button it releases, so the filter remembers a right press it dropped.
 */
export function createRightClickFilter(): (data: string) => string {
  let rightHeld = false
  return (data) => {
    if (!data.includes('\x1b[')) return data
    return data
      .replace(SGR_REPORT, (report, code: string) => (isRightButton(Number(code)) ? '' : report))
      .replace(DEFAULT_REPORT, (report, button: string) => {
        const code = button.charCodeAt(0) - 32
        if (isRightButton(code)) {
          rightHeld = true
          return ''
        }
        if (rightHeld && !(code & WHEEL) && !(code & 32) && (code & 3) === 3) {
          rightHeld = false
          return ''
        }
        return report
      })
  }
}
