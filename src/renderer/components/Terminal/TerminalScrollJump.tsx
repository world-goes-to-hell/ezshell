import { useEffect, useState, type MouseEvent } from 'react'
import type { Terminal } from 'xterm'
import { RiArrowDownDoubleLine, RiArrowUpDoubleLine } from 'react-icons/ri'
import { samePlace, scrollPlace, type ScrollPlace } from '../../lib/terminalScrollJump'
import './TerminalScrollJump.css'

const FITS: ScrollPlace = { scrollable: false, atTop: true, atBottom: true }

/**
 * Jump to the start or the newest line of a server's log (2026-11-27 user request: a Spring Boot or Vue
 * start log runs to thousands of lines). Shown once the log has scrollback; the terminal keeps the focus.
 */
export function TerminalScrollJump({ terminal }: { terminal: Terminal | null }) {
  const [place, setPlace] = useState<ScrollPlace>(FITS)

  useEffect(() => {
    if (!terminal) return
    let frame = 0
    // Output repaints many times a second: read the place once per frame, and only redraw when it changes
    const read = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const next = scrollPlace(terminal.buffer.active)
        setPlace(current => samePlace(current, next) ? current : next)
      })
    }
    read()
    const scrolled = terminal.onScroll(read)
    const rendered = terminal.onRender(read)
    const switched = terminal.buffer.onBufferChange(read)
    return () => {
      cancelAnimationFrame(frame)
      scrolled.dispose()
      rendered.dispose()
      switched.dispose()
    }
  }, [terminal])

  if (!terminal || !place.scrollable) return null
  const keepFocus = (event: MouseEvent) => event.preventDefault()
  return (
    <div className="terminal-scroll-jump" role="group" aria-label="로그 이동" data-following={place.atBottom || undefined}>
      <button type="button" title="맨 위로" aria-label="맨 위로" disabled={place.atTop}
        onMouseDown={keepFocus} onClick={() => terminal.scrollToTop()}>
        <RiArrowUpDoubleLine size={15} aria-hidden="true" />
      </button>
      <button type="button" title="맨 아래로" aria-label="맨 아래로" disabled={place.atBottom}
        onMouseDown={keepFocus} onClick={() => terminal.scrollToBottom()}>
        <RiArrowDownDoubleLine size={15} aria-hidden="true" />
      </button>
    </div>
  )
}
