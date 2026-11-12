import type { IDisposable, ILink, Terminal } from 'xterm'
import { cleanName, looksLikeName, splitPath, wordsInCells, type TerminalCell } from '../../lib/terminalTarget'
import { EDIT_MAX_BYTES } from '../../lib/remoteFileText'
import { openRemoteFileWindow } from '../../lib/remoteFileOpen'
import { openSftpAt } from '../../lib/sftpSync'
import { findTarget, knownTarget, type TerminalTarget } from './terminalTargetMenu'

/**
 * The pointer has to rest on a line this long before the server is asked about its words (a pointer
 * swept across the screen passes a line faster). Names already known are answered without waiting.
 */
const HOVER_DELAY_MS = 60
/** Words of one line looked up at most (a wide `ls` line has a dozen names) */
const MAX_WORDS_PER_LINE = 12

interface Options {
  sessionId: string
  /** The folder the terminal is in, as its prompt shows it; undefined when not known (split shells) */
  getCwd: () => string | undefined
  /** The tab's name, shown in the title of a file window opened from here */
  getSessionName: () => string
}

/** Ctrl+click: what one would most likely do with it */
function openTarget(sessionId: string, sessionName: string, target: TerminalTarget): void {
  if (target.isDirectory) {
    void openSftpAt(sessionId, target.path)
    return
  }
  const { folder } = splitPath(target.path)
  void openRemoteFileWindow(sessionId, sessionName, folder, target.name, target.size <= EDIT_MAX_BYTES ? 'edit' : 'preview')
}

const hintFor = (target: TerminalTarget): string =>
  `${target.path}\n우클릭: 메뉴 · Ctrl+클릭: ${target.isDirectory ? 'SFTP 에서 열기' : target.size <= EDIT_MAX_BYTES ? '편집' : '미리보기'}`

/**
 * Underlines the file and folder names of the line under the pointer, so it shows that a right-click
 * (or Ctrl+click) does something with them. The server is asked only about the line the pointer
 * rests on (one SFTP stat per word, remembered for a while), never about the whole screen.
 */
export function attachFileLinks(terminal: Terminal, { sessionId, getCwd, getSessionName }: Options): IDisposable {
  let latest = 0
  const element = terminal.element

  return terminal.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const request = ++latest
      const buffer = terminal.buffer.active
      const line = buffer.type === 'alternate' ? undefined : buffer.getLine(lineNumber - 1)
      if (!line) return callback(undefined)
      const cells: TerminalCell[] = []
      for (let x = 0; x < terminal.cols; x++) {
        const cell = line.getCell(x)
        cells.push({ text: cell?.getChars() ?? '', width: cell?.getWidth() ?? 1 })
      }
      const words = wordsInCells(cells)
        .map(word => ({ ...word, name: cleanName(word.text) }))
        .filter((word): word is typeof word & { name: string } => word.name !== null && looksLikeName(word.name))
        .slice(0, MAX_WORDS_PER_LINE)
      if (words.length === 0) return callback(undefined)

      const answer = (targets: Array<TerminalTarget | null>): void => {
        const links: ILink[] = []
        targets.forEach((target, i) => {
          if (!target) return
          const word = words[i]
          links.push({
            text: word.text,
            range: { start: { x: word.start + 1, y: lineNumber }, end: { x: word.end + 1, y: lineNumber } },
            // Underlined, but the pointer stays as it is: a plain click still only places the cursor
            decorations: { underline: true, pointerCursor: false },
            activate: (event) => {
              if (event.ctrlKey || event.metaKey) openTarget(sessionId, getSessionName(), target)
            },
            hover: () => { if (element) element.title = hintFor(target) },
            leave: () => { element?.removeAttribute('title') }
          })
        })
        callback(links.length > 0 ? links : undefined)
      }

      // Everything on this line was asked about a moment ago: no waiting, no request
      const cwd = getCwd()
      const known = words.map(word => knownTarget(sessionId, word.name, cwd))
      if (known.every(target => target !== undefined)) return answer(known as Array<TerminalTarget | null>)

      window.setTimeout(() => {
        // The pointer moved on to another line: nothing is asked for this one
        if (request !== latest) return callback(undefined)
        void Promise.all(words.map(word => findTarget(sessionId, word.name, cwd))).then(answer)
      }, HOVER_DELAY_MS)
    }
  })
}
