import type { IDisposable, Terminal } from 'xterm'
import { webLinksIn } from '../../lib/markdownRender'

const MAX_LINK_LENGTH = 4096

export const TERMINAL_WEB_LINK_EVENT = 'ezshell:terminal-web-link'
export type TerminalWebLink = { x: number; y: number; href: string }

function showLink(event: MouseEvent, href: string) {
  if (event.button !== 0 || !/^https?:\/\//i.test(href) || href.length > MAX_LINK_LENGTH) return
  const detail: TerminalWebLink = { x: event.clientX, y: event.clientY, href }
  window.dispatchEvent(new CustomEvent(TERMINAL_WEB_LINK_EVENT, { detail }))
}

/** Read the wrapped line through the buffer so every character maps back to its terminal cell. */
function linksOnLine(terminal: Terminal, lineNumber: number) {
  const buffer = terminal.buffer.active
  const row = lineNumber - 1
  const limit = Math.ceil(MAX_LINK_LENGTH / terminal.cols)
  let first = row
  let last = row
  while (first > Math.max(0, row - limit) && buffer.getLine(first)?.isWrapped) first--
  while (last < row + limit && buffer.getLine(last + 1)?.isWrapped) last++

  const positions: Array<{ x: number; y: number; end: number }> = []
  let text = ''
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y)
    if (!line) break
    for (let x = 0; x < terminal.cols; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      text += chars
      for (let index = 0; index < chars.length; index++) positions.push({ x: x + 1, y: y + 1, end: x + cell.getWidth() })
    }
  }
  return webLinksIn(text).flatMap(link => {
    const start = positions[link.index]
    const end = positions[link.lastIndex - 1]
    if (!start || !end || start.y > lineNumber || end.y < lineNumber || link.url.length > MAX_LINK_LENGTH) return []
    return [{
      text: link.url,
      range: { start: { x: start.x, y: start.y }, end: { x: end.end, y: end.y } },
      activate: showLink
    }]
  })
}

/** Covers both plain HTTP(S) text and OSC 8 hyperlinks, with the terminal owning cleanup. */
export function attachTerminalWebLinks(terminal: Terminal) {
  let provider: IDisposable | undefined
  terminal.loadAddon({
    activate(term) {
      term.options.linkHandler = { activate: showLink }
      provider = term.registerLinkProvider({
        provideLinks(row, callback) {
          const links = linksOnLine(term, row)
          callback(links.length ? links : undefined)
        }
      })
    },
    dispose() { provider?.dispose() }
  })
}
