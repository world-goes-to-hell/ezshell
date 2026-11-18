import type { IDecoration, IDisposable, IMarker, Terminal } from 'xterm'
import {
  completedListingRange, fileZone, historicalListing, isListing, isRelativeName, listingBase, lookupName, visiblePart, zoneBlocks, zoneHasOutput,
  type FileZone, type HistoricalListing, type ListingBase, type ZoneBlock, type ZoneCommand
} from '../../lib/terminalFileZone'
import { extractCommand, readInputLine, textAfterPrompt } from '../../lib/commandCapture'
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
interface CommandMarker {
  marker: IMarker
  base: ListingBase
  listing: boolean
  history: { listing: HistoricalListing; prompt: string } | null
}
interface ArchivedListing {
  first: IMarker
  last: IMarker
  folder: string
  verified: boolean
}

function archiveRange(entry: ArchivedListing): FileZone | null {
  return entry.verified && !entry.first.isDisposed && !entry.last.isDisposed && entry.first.line <= entry.last.line
    ? { start: entry.first.line, end: entry.last.line } : null
}

function disposeArchive(entry: ArchivedListing): void {
  entry.first.dispose()
  entry.last.dispose()
}

/**
 * Keeps a marker on the row where the shell's folder last changed and one on every command line
 * typed since, and draws a border around each command's output with the folder its names are in
 * (the current one, or the one an `ls` listed). When the folder changes, live lookup stops at once
 * and completed listings with a known absolute folder are kept. The new zone starts in a write callback:
 * xterm parses writes in order, so by then the output that brought the new folder (and anything
 * queued before it, such as the echo of the typed `cd`) is on screen and the cursor is on the new
 * prompt. xterm hides a decoration whose marker row is off screen, so only the visible part of a
 * block is drawn, anchored at its first row. Blocks of prompt lines only are not drawn.
 */
export function attachFileZone(terminal: Terminal, sessionId: string): FileZoneController {
  const cwdOf = () => useTerminalStore.getState().terminals.get(sessionId)?.currentPath
  let startMarker: IMarker | null = null
  let startLost = false
  let zoneCwd: string | undefined
  let zoneReady = false
  let commands: CommandMarker[] = []
  let archived: ArchivedListing[] = []
  // Bumped on every folder change: a marker requested for an older folder is not set
  let generation = 0
  let drawn: Drawn[] = []
  let drawnKey = ''
  let frame = 0

  const cursorRow = () => terminal.buffer.active.baseY + terminal.buffer.active.cursorY

  const zone = (): FileZone | null => {
    if (!zoneReady) return null
    const start = startMarker && !startMarker.isDisposed ? startMarker.line : startLost ? 0 : null
    return fileZone({ start, cursorRow: cursorRow(), isAlternate: terminal.buffer.active.type === 'alternate' })
  }

  const zoneCommands = (): ZoneCommand[] => commands
    .filter(c => !c.marker.isDisposed)
    .map(c => ({ row: c.marker.line, base: c.base, listing: c.listing }))

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

  const drawBlock = (block: FileZone, label: string): Drawn | null => {
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
    const blocks: Array<{ block: FileZone; label: string }> = []
    if (isFileZoneShown() && terminal.buffer.active.type === 'normal') {
      for (const entry of archived) {
        const block = archiveRange(entry)
        if (block) blocks.push({ block, label: entry.folder })
      }
      if (current) {
        for (const block of zoneBlocks(current, zoneCommands())) {
          if (block.listing && block.base.kind !== 'none') blocks.push({ block, label: labelOf(block, cwd) })
        }
      }
    }
    const viewportTop = terminal.buffer.active.viewportY
    // Off-screen blocks first, then the line reading: while output streams this runs every frame
    const visible = blocks
      .map(({ block, label }) => ({ block, label, part: visiblePart(block, viewportTop, terminal.rows) }))
      .filter(({ block, part }) => part !== null && hasOutput(block))
    const key = visible.map(({ label, part }) =>
      `${part!.top}+${part!.height}${part!.cutTop ? 't' : ''}${part!.cutBottom ? 'b' : ''}:${label}`
    ).join('|') + `@${terminal.cols}:${terminal.options.fontSize}`
    if (key === drawnKey) return
    clear()
    drawn = visible.map(({ block, label }) => drawBlock(block, label)).filter((d): d is Drawn => d !== null)
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
    zoneCwd = undefined
    zoneReady = false
    old?.dispose()
    commands.forEach(c => c.marker.dispose())
    commands = []
  }

  const archiveListings = () => {
    const buffer = terminal.buffer.active
    if (buffer.type !== 'normal') return
    archived = archived.filter(entry => {
      if (!entry.first.isDisposed && !entry.last.isDisposed) return true
      disposeArchive(entry)
      return false
    })
    const cursor = cursorRow()
    const recent = commands.filter(command => !command.marker.isDisposed)
    const directoryChecks = new Map<string, Promise<boolean>>()
    let sftp: ReturnType<typeof window.electronAPI.sftpOpen> | undefined
    recent.forEach(({ marker, history }, index) => {
      if (!history) return
      const lastRow = recent[index + 1]?.marker.line ?? cursor
      const block = completedListingRange(buffer, marker.line, lastRow, history.prompt)
      if (!block || !hasOutput(block)) return
      const first = terminal.registerMarker(block.start - cursor)
      const last = terminal.registerMarker(block.end - cursor)
      if (!first || !last) {
        first?.dispose()
        last?.dispose()
        return
      }
      const { folder, checkDirectory } = history.listing
      const entry = { first, last, folder, verified: !checkDirectory }
      archived.push(entry)
      if (!checkDirectory) return
      // A literal operand can name a file instead of the directory that the listing came from.
      let check = directoryChecks.get(folder)
      if (!check) {
        sftp ??= window.electronAPI.sftpOpen(sessionId)
        check = sftp.then(() => window.electronAPI.sftpStat?.(sessionId, folder))
          .then(stat => stat?.isDirectory === true, () => false)
        directoryChecks.set(folder, check)
      }
      void check.then(verified => {
        if (entry.first.isDisposed || entry.last.isDisposed) return
        if (!verified) disposeArchive(entry)
        else entry.verified = true
        schedule()
      })
    })
    while (archived.length > MAX_COMMANDS) disposeArchive(archived.shift()!)
  }

  /** Sets the zone's marker on the cursor row once everything written so far has been parsed */
  const markAfterPendingOutput = (cwd: string) => {
    const requested = ++generation
    terminal.write('', () => {
      if (requested !== generation || cwdOf() !== cwd) return
      if (zoneCwd) archiveListings()
      dropZone()
      const marker = terminal.registerMarker(0) ?? null
      startMarker = marker
      zoneCwd = cwd
      zoneReady = true
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
    const cwd = zoneCwd
    if (!zoneReady || !cwd || terminal.buffer.active.type === 'alternate') return
    const marker = terminal.registerMarker(0)
    if (!marker) return
    const zoneStart = startMarker
    terminal.write('', () => {
      if (zoneStart !== startMarker || zoneCwd !== cwd || marker.isDisposed) {
        marker.dispose()
        return
      }
      const input = readInputLine(terminal.buffer.normal, marker.line)
      const command = extractCommand(input)
      if (command === null) {
        marker.dispose()
        return
      }
      const typed = textAfterPrompt(input) ?? ''
      const prompt = input.slice(0, input.length - typed.length)
      const history = historicalListing(command, prompt, cwd)
      commands = [...commands.filter(c => !c.marker.isDisposed), {
        marker, base: listingBase(command), listing: isListing(command), history: history ? { listing: history, prompt } : null
      }]
      while (commands.length > MAX_COMMANDS) commands.shift()?.marker.dispose()
      schedule()
    })
  }

  let lastCwd = cwdOf()
  if (lastCwd !== undefined) markAfterPendingOutput(lastCwd)
  const unsubscribe = useTerminalStore.subscribe((state) => {
    const cwd = state.terminals.get(sessionId)?.currentPath
    if (cwd === lastCwd) return
    lastCwd = cwd
    zoneReady = false
    if (cwd !== undefined) markAfterPendingOutput(cwd)
    else {
      generation++
      dropZone()
      archived.forEach(disposeArchive)
      archived = []
    }
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
    lookup: (name, row) => {
      if (isRelativeName(name) && terminal.buffer.active.type === 'normal') {
        for (const entry of archived) {
          const block = archiveRange(entry)
          if (block && row >= block.start && row <= block.end) {
            return name.includes('/') ? null : resolveName(name, entry.folder, null)
          }
        }
      }
      return lookupName(name, row, zone(), zoneCommands())
    },
    dispose: () => {
      if (frame) cancelAnimationFrame(frame)
      unsubscribe()
      window.removeEventListener(PREF_EVENT, onPref)
      disposables.forEach(d => d.dispose())
      generation++
      clear()
      dropZone()
      archived.forEach(disposeArchive)
      archived = []
      controllers.delete(terminal)
    }
  }
  controllers.set(terminal, controller)
  return controller
}
