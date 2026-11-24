// What xterm sends to the shell by itself rather than for a key the user pressed: focus reports
// (DECSET 1004, sent when the pane gains or loses focus), mouse reports (wheel and clicks while a program
// has mouse mode on) and answers to the program's queries (cursor position, device attributes, modes,
// window size, OSC colours, DCS). Claude Code turns focus reports on, so they flow whenever the pane is
// clicked away from or the chat view takes over.

const REPLIES = [
  /\x1b\[[IO]/g, // focus in / out
  /\x1b\[<\d+;\d+;\d+[Mm]/g, // SGR mouse
  /\x1b\[M[\s\S]{3}/g, // default mouse encoding: ESC [ M and three bytes
  /\x1b\[\d+;\d+;\d+M/g, // urxvt mouse
  // cursor position report. Same shape as F3 with a modifier (Ctrl+F3 is \x1b[1;5R), so that key alone
  // does not count as typing: unused in Claude's question dialog, where this check is used
  /\x1b\[\??\d+(?:;\d+)*R/g,
  /\x1b\[[?>=][\d;]*c/g, // device attributes
  /\x1b\[\??[\d;]*\$y/g, // mode report (DECRPM)
  /\x1b\[\d+(?:;\d+)*t/g, // window size / state report
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC answer (colours)
  /\x1bP[\s\S]*?\x1b\\/g // DCS answer (DECRQSS, XTGETTCAP)
]

/** Whether `data` holds anything besides xterm's own reports: something the user typed or pasted */
export function hasTypedInput(data: string): boolean {
  if (!data.includes('\x1b')) return data.length > 0
  let rest = data
  for (const reply of REPLIES) rest = rest.replace(reply, '')
  return rest.length > 0
}
