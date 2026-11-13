import type { IDecoration, IDisposable, IMarker, Terminal } from 'xterm'
import {
  fileZone, listingBase, lookupName, visiblePart, zoneBlocks, zoneHasOutput,
  type FileZone, type ListingBase, type ZoneBlock, type ZoneCommand
} from '../../lib/terminalFileZone'
import { extractCommand, readInputLine } from '../../lib/commandCapture'
import { resolveName } from '../../lib/terminalTarget'
import { useTerminalStore } from '../../stores/terminalStore'
import './terminalFileZone.css'

const PREF_KEY = 'terminalFileZone'
const PREF_EVENT = 'ezshell:file-zone-pref'
/** Command lines remembered in one zone (a long session in one folder drops the oldest) */
const MAX_COMMANDS = 200
/** Rows looked at, from a block's end, for a line that is not a prompt */
const MAX_ROWS_CHECKED = 200

/** Whether the zone's border is drawn (the lookup rule applies either way) */
export function isFileZoneShown(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setFileZoneShown(shown: boolean): void {
  try {
    if (shown) localStorage.removeItem(PREF_KEY)
    else localStorage.setItem(PREF_KEY, 'off')
  } catch {
    // Not remembered: still applied for now
  }
  window.dispatchEvent(new Event(PREF_EVENT))
}

export interface FileZoneController extends IDisposable {
  /** The zone now, in buffer rows; null when there is none */
  zone: () => FileZone | null
  /**
   * The name to look up for a word on buffer row `row`: `../test.txt` under `ls ../`, as it is in
   * the current folder, null when a relative name cannot be placed (outside the zone, `ls a b`).
   */
  lookup: (name: string, row: number) => string | null
}

const controllers = new WeakMap<Terminal, FileZoneController>()

/** The zone of a tab's main terminal; undefined for terminals without one (split shells) */
export const fileZoneOf = (terminal: Terminal): FileZoneController | undefined => controllers.get(terminal)

interface Drawn { decoration: IDecoration | undefined; anchor: IMarker | null }

/**
 * Keeps a marker on the row where the shell's folder last changed and one on every command line
 * typed since, and draws a border around each command's output with the folder its names are in
 * (the current one, or the one an `ls` listed). When the folder changes the old zone goes at once
 * (its names belong to the old folder), and the new marker is set by an empty write's callback:
 * xterm parses writes in order, so by then the output that brought the new folder (and anything
 * queued before it, such as the echo of the typed `cd`) is on screen and the cursor is on the new
 * prompt. xterm hides a decoration whose marker row is off screen, so only the visible part of a
 * block is drawn, anchored at its first row. Blocks of prompt lines only are not drawn.
 */
export function attachFileZone(terminal: Terminal, sessionId: string): FileZoneController {
  const cwdOf = () => useTerminalStore.getState().terminals.get(sessionId)?.currentPath
  let startMarker: IMarker | null = null
  let startLost = false
  let commands: Array<{ marker: IMarker; base: ListingBase }> = []
  // Bumped on every folder change: a marker requested for an older folder is not set
  let generation = 0
  let drawn: Drawn[] = []
  let drawnKey = ''
  let frame = 0

  const cursorRow = () => terminal.buffer.active.baseY + terminal.buffer.active.cursorY

  const zone = (): FileZone | null => {
    if (!cwdOf()) return null
    const start = startMarker && !startMarker.isDisposed ? startMarker.line : startLost ? 0 : null
    return fileZone({ start, cursorRow: cursorRow(), isAlternate: terminal.buffer.active.type === 'alternate' })
  }

  const zoneCommands = (): ZoneCommand[] => commands
    .filter(c => !c.marker.isDisposed)
    .map(c => ({ row: c.marker.line, base: c.base }))

  /** Whether a block holds a line that is not a prompt; a block longer than what is checked has output */
  const hasOutput = (block: FileZone): boolean => {
    const buffer = terminal.buffer.active
    const first = Math.max(block.start, block.end - MAX_ROWS_CHECKED + 1)
    const lines: string[] = []
    for (let row = block.end; row >= first; row--) lines.push(buffer.getLine(row)?.translateToString(true) ?? '')
    return zoneHasOutput(lines) || first > block.start
  }

  const labelOf = (block: ZoneBlock, cwd: string): string =>
    block.base.kind === 'dir' ? (resolveName(block.base.dir, cwd, null) ?? `${cwd}/${block.base.dir}`) : cwd

  const clear = () => {
    for (const { decoration, anchor } of drawn) {
      decoration?.dispose()
      anchor?.dispose()
    }
    drawn = []
    drawnKey = ''
  }

  const drawBlock = (block: ZoneBlock, label: string): Drawn | null => {
    const part = visiblePart(block, terminal.buffer.active.viewportY, terminal.rows)
    if (!part) return null
    // A marker of its own on the first visible row (the shared ones stay as they are)
    const anchor = terminal.registerMarker(part.top - cursorRow()) ?? null
    if (!anchor) return null
    const decoration = terminal.registerDecoration({ marker: anchor, width: terminal.cols, height: part.height, layer: 'top' })
    decoration?.onRender((element) => {
      element.classList.add('terminal-file-zone')
      element.classList.toggle('is-cut-top', part.cutTop)
      element.classList.toggle('is-cut-bottom', part.cutBottom)
      let tag = element.querySelector<HTMLSpanElement>('.terminal-file-zone-label')
      if (!tag) {
        tag = document.createElement('span')
        tag.className = 'terminal-file-zone-label'
        element.appendChild(tag)
      }
      tag.textContent = label
      tag.title = `이 테두리 안의 이름은 ${label} 기준으로 찾습니다`
    })
    return { decoration, anchor }
  }

  const draw = () => {
    frame = 0
    const current = zone()
    const cwd = cwdOf() ?? ''
    const blocks = current && isFileZoneShown() ? zoneBlocks(current, zoneCommands()) : []
    const viewportTop = terminal.buffer.active.viewportY
    // Off-screen blocks first, then the line reading: while output streams this runs every frame
    const visible = blocks
      .filter(block => block.base.kind !== 'none')
      .map(block => ({ block, part: visiblePart(block, viewportTop, terminal.rows) }))
      .filter(({ block, part }) => part !== null && hasOutput(block))
    const key = visible.map(({ block, part }) =>
      `${part!.top}+${part!.height}${part!.cutTop ? 't' : ''}${part!.cutBottom ? 'b' : ''}:${labelOf(block, cwd)}`
    ).join('|') + `@${terminal.cols}:${terminal.options.fontSize}`
    if (key === drawnKey) return
    clear()
    drawn = visible.map(({ block }) => drawBlock(block, labelOf(block, cwd))).filter((d): d is Drawn => d !== null)
    drawnKey = key
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  /** No zone until the next marker: the old one's names belong to another folder */
  const dropZone = () => {
    const old = startMarker
    startMarker = null
    startLost = false
    old?.dispose()
    commands.forEach(c => c.marker.dispose())
    commands = []
  }

  /** Sets the zone's marker on the cursor row once everything written so far has been parsed */
  const markAfterPendingOutput = () => {
    const requested = ++generation
    terminal.write('', () => {
      if (requested !== generation || !cwdOf()) return
      dropZone()
      const marker = terminal.registerMarker(0) ?? null
      startMarker = marker
      marker?.onDispose(() => {
        // Pushed out of the scrollback (or cleared): the zone now begins at the top of the buffer
        if (startMarker === marker) startLost = true
      })
      schedule()
    })
  }

  /**
   * Enter on a shell prompt: a marker on that command line, and the folder its output lists, read
   * from the line once the echo of what was typed has been parsed. Enter elsewhere (a password, a
   * full-screen program, a line without a prompt) leaves no marker.
   */
  const onEnter = () => {
    if (!cwdOf() || terminal.buffer.active.type === 'alternate') return
    const marker = terminal.registerMarker(0)
    if (!marker) return
    const requested = generation
    terminal.write('', () => {
      if (requested !== generation || marker.isDisposed) {
        marker.dispose()
        return
      }
      const command = extractCommand(readInputLine(terminal.buffer.normal, marker.line))
      if (command === null) {
        marker.dispose()
        return
      }
      commands = [...commands.filter(c => !c.marker.isDisposed), { marker, base: listingBase(command) }]
      while (commands.length > MAX_COMMANDS) commands.shift()?.marker.dispose()
      schedule()
    })
  }

  let lastCwd = cwdOf()
  if (lastCwd !== undefined) markAfterPendingOutput()
  const unsubscribe = useTerminalStore.subscribe((state) => {
    const cwd = state.terminals.get(sessionId)?.currentPath
    if (cwd === lastCwd) return
    lastCwd = cwd
    generation++
    dropZone()
    if (cwd !== undefined) markAfterPendingOutput()
    schedule()
  })

  const disposables = [
    terminal.onData((data) => { if (data.includes('\r')) onEnter() }),
    terminal.onWriteParsed(schedule),
    terminal.onScroll(schedule),
    // Scrolling by the scrollbar does not raise onScroll, but it does redraw rows; unchanged blocks are skipped
    terminal.onRender(schedule),
    terminal.onResize(() => {
      drawnKey = ''
      schedule()
    })
  ]
  const onPref = () => {
    drawnKey = ''
    schedule()
  }
  window.addEventListener(PREF_EVENT, onPref)

  const controller: FileZoneController = {
    zone,
    lookup: (name, row) => lookupName(name, row, zone(), zoneCommands()),
    dispose: () => {
      if (frame) cancelAnimationFrame(frame)
      unsubscribe()
      window.removeEventListener(PREF_EVENT, onPref)
      disposables.forEach(d => d.dispose())
      generation++
      clear()
      dropZone()
      controllers.delete(terminal)
    }
  }
  controllers.set(terminal, controller)
  return controller
}
