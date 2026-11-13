import type { IDecoration, IDisposable, IMarker, Terminal } from 'xterm'
import { allowsName, fileZone, visiblePart, type FileZone } from '../../lib/terminalFileZone'
import { useTerminalStore } from '../../stores/terminalStore'
import './terminalFileZone.css'

const PREF_KEY = 'terminalFileZone'
const PREF_EVENT = 'ezshell:file-zone-pref'

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
  /** Whether a name on buffer row `row` may be looked up (relative names only inside the zone) */
  allows: (name: string, row: number) => boolean
}

const controllers = new WeakMap<Terminal, FileZoneController>()

/** The zone of a tab's main terminal; undefined for terminals without one (split shells) */
export const fileZoneOf = (terminal: Terminal): FileZoneController | undefined => controllers.get(terminal)

/**
 * Keeps a marker on the row where the shell's folder last changed and draws a border around the
 * output since then, with the folder at its top right. The marker is set after the output that
 * brought the new folder has been parsed, so it sits on the new prompt. xterm hides a decoration
 * whose marker row is off screen, so only the visible part is drawn, anchored at its first row.
 */
export function attachFileZone(terminal: Terminal, sessionId: string): FileZoneController {
  const cwdOf = () => useTerminalStore.getState().terminals.get(sessionId)?.currentPath
  let startMarker: IMarker | null = null
  let startLost = false
  let pendingMark = cwdOf() !== undefined
  let decoration: IDecoration | null = null
  let anchor: IMarker | null = null
  let drawn = ''
  let frame = 0

  const cursorRow = () => terminal.buffer.active.baseY + terminal.buffer.active.cursorY

  const zone = (): FileZone | null => {
    if (!cwdOf()) return null
    const start = startMarker && !startMarker.isDisposed ? startMarker.line : startLost ? 0 : null
    return fileZone({ start, cursorRow: cursorRow(), isAlternate: terminal.buffer.active.type === 'alternate' })
  }

  const clear = () => {
    decoration?.dispose()
    decoration = null
    if (anchor && anchor !== startMarker) anchor.dispose()
    anchor = null
    drawn = ''
  }

  const draw = () => {
    frame = 0
    const current = zone()
    const part = current && isFileZoneShown() ? visiblePart(current, terminal.buffer.active.viewportY, terminal.rows) : null
    if (!part) {
      clear()
      return
    }
    const cwd = cwdOf() ?? ''
    const key = `${part.top}:${part.height}:${part.cutTop}:${part.cutBottom}:${terminal.cols}:${terminal.options.fontSize}:${cwd}`
    if (key === drawn) return
    clear()
    const marker = startMarker && !startMarker.isDisposed && startMarker.line === part.top
      ? startMarker
      : terminal.registerMarker(part.top - cursorRow())
    if (!marker) return
    anchor = marker
    decoration = terminal.registerDecoration({ marker, width: terminal.cols, height: part.height, layer: 'top' }) ?? null
    decoration?.onRender((element) => {
      element.classList.add('terminal-file-zone')
      element.classList.toggle('is-cut-top', part.cutTop)
      element.classList.toggle('is-cut-bottom', part.cutBottom)
      let label = element.querySelector<HTMLSpanElement>('.terminal-file-zone-label')
      if (!label) {
        label = document.createElement('span')
        label.className = 'terminal-file-zone-label'
        element.appendChild(label)
      }
      label.textContent = cwd
      label.title = `이 테두리 안의 이름은 ${cwd} 기준으로 찾습니다`
    })
    drawn = key
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  const setStart = () => {
    startMarker?.dispose()
    startMarker = terminal.registerMarker(0) ?? null
    startLost = false
    startMarker?.onDispose(() => {
      // Pushed out of the scrollback (or cleared): the zone now begins at the top of the buffer
      if (startMarker?.isDisposed) startLost = true
    })
  }

  // A new folder: the marker goes on the row the cursor is on once that output has been parsed
  let lastCwd = cwdOf()
  const unsubscribe = useTerminalStore.subscribe((state) => {
    const cwd = state.terminals.get(sessionId)?.currentPath
    if (cwd === lastCwd) return
    lastCwd = cwd
    pendingMark = cwd !== undefined
    if (cwd === undefined) {
      startMarker?.dispose()
      startMarker = null
      startLost = false
    }
    schedule()
  })

  const disposables = [
    terminal.onWriteParsed(() => {
      if (pendingMark) {
        pendingMark = false
        setStart()
      }
      schedule()
    }),
    terminal.onScroll(schedule),
    // Scrolling by the scrollbar does not raise onScroll, but it does redraw rows; an unchanged zone is skipped
    terminal.onRender(schedule),
    terminal.onResize(() => {
      drawn = ''
      schedule()
    })
  ]
  const onPref = () => {
    drawn = ''
    schedule()
  }
  window.addEventListener(PREF_EVENT, onPref)

  const controller: FileZoneController = {
    zone,
    allows: (name, row) => allowsName(name, row, zone()),
    dispose: () => {
      if (frame) cancelAnimationFrame(frame)
      unsubscribe()
      window.removeEventListener(PREF_EVENT, onPref)
      disposables.forEach(d => d.dispose())
      clear()
      startMarker?.dispose()
      controllers.delete(terminal)
    }
  }
  controllers.set(terminal, controller)
  return controller
}
