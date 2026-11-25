import type { IDecoration, IDisposable, IMarker, Terminal } from 'xterm'
import { visibleRowLevels, type RowLevel } from '../../lib/terminalLogRows'
import './terminalLogHighlight.css'

const PREF_KEY = 'terminalLogHighlight'
const PREF_EVENT = 'ezshell:log-highlight-pref'

/** Whether error and warning lines are tinted in terminals (on unless turned off) */
export function isLogHighlightOn(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setLogHighlightOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PREF_KEY)
    else localStorage.setItem(PREF_KEY, 'off')
  } catch {
    // Not remembered: still applied for now
  }
  window.dispatchEvent(new Event(PREF_EVENT))
}

interface Drawn { marker: IMarker; decoration: IDecoration | undefined; level: RowLevel; cols: number }

/**
 * Tints the error and warning lines on a terminal's screen (`tail -f`, `docker logs -f`, `journalctl`).
 * Only the rows on screen are read, once per frame at most, and nothing is sent to the server. A
 * row's tint is a decoration on a marker of that buffer row, so it moves with the line as output
 * scrolls; a row that keeps its level keeps its decoration (recreating them every frame flickers).
 * Full-screen programs (vim, less, top) are left alone.
 */
export interface LogHighlight extends IDisposable {
  /**
   * Paused while something covers the terminal (a local pane's chat view): the tints are removed and the
   * screen is not read every frame; resuming draws them again
   */
  setPaused(paused: boolean): void
}

export function attachLogHighlight(terminal: Terminal): LogHighlight {
  let drawn: Drawn[] = []
  let frame = 0
  let paused = false

  const release = (item: Drawn) => {
    item.decoration?.dispose()
    item.marker.dispose()
  }

  const clear = () => {
    drawn.forEach(release)
    drawn = []
  }

  const draw = () => {
    frame = 0
    const buffer = terminal.buffer.active
    if (paused || !isLogHighlightOn() || buffer.type === 'alternate') {
      clear()
      return
    }
    const cursorRow = buffer.baseY + buffer.cursorY
    const levels = visibleRowLevels(buffer, buffer.viewportY, terminal.rows, cursorRow)

    const kept: Drawn[] = []
    const covered = new Set<number>()
    for (const item of drawn) {
      const row = item.marker.isDisposed ? -1 : item.marker.line
      if (row >= 0 && !covered.has(row) && levels.get(row) === item.level && item.cols === terminal.cols) {
        kept.push(item)
        covered.add(row)
      } else {
        release(item)
      }
    }
    for (const [row, level] of levels) {
      if (covered.has(row)) continue
      const marker = terminal.registerMarker(row - cursorRow)
      if (!marker) continue
      const decoration = terminal.registerDecoration({ marker, width: terminal.cols, layer: 'bottom' })
      decoration?.onRender((element) => {
        element.classList.add('terminal-log-row', `is-${level}`)
      })
      kept.push({ marker, decoration, level, cols: terminal.cols })
    }
    drawn = kept
  }

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  const disposables = [
    terminal.onWriteParsed(schedule),
    terminal.onScroll(schedule),
    // Scrolling by the scrollbar does not raise onScroll, but it does redraw rows
    terminal.onRender(schedule),
    terminal.onResize(schedule)
  ]
  // The setting is changed from a menu in this window, or in another window (detached terminals)
  const onStorage = (event: StorageEvent) => { if (event.key === PREF_KEY) schedule() }
  window.addEventListener(PREF_EVENT, schedule)
  window.addEventListener('storage', onStorage)
  schedule()

  return {
    setPaused: (next) => {
      if (next === paused) return
      paused = next
      schedule()
    },
    dispose: () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener(PREF_EVENT, schedule)
      window.removeEventListener('storage', onStorage)
      disposables.forEach(d => d.dispose())
      clear()
    }
  }
}
