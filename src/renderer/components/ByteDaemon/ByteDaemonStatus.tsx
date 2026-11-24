import { useCallback, useEffect, useRef } from 'react'
import { DaemonStatusIcon } from './DaemonArt'
import { ByteDaemonHome } from './ByteDaemonHome'
import { CatchBugGame } from './CatchBugGame'
import { TypingGame } from './TypingGame'
import { DeployGame } from './DeployGame'
import { useByteDaemonStore } from '../../stores/byteDaemonStore'
import { useUIStore } from '../../stores/uiStore'
import './ByteDaemon.css'

const TICK_MS = 500

/** Production is added only while the popover is open and the window shows */
function useTicking(open: boolean) {
  const tick = useByteDaemonStore(state => state.tick)
  useEffect(() => {
    if (!open) return
    let timer = window.setInterval(tick, TICK_MS)
    const onVisibility = () => {
      window.clearInterval(timer)
      if (document.hidden) return
      tick()
      timer = window.setInterval(tick, TICK_MS)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [open, tick])
}

function ByteDaemonPanel({ onClose }: { onClose: () => void }) {
  const view = useByteDaemonStore(state => state.view)
  const panel = useRef<HTMLDivElement>(null)
  // Keyboard users land in the popover; a game's own input takes focus after this
  useEffect(() => { panel.current?.focus({ preventScroll: true }) }, [])
  return (
    <div className="bd-panel" role="dialog" aria-label="바이트 데몬" tabIndex={-1} ref={panel}>
      {view === 'bugs' ? <CatchBugGame /> : view === 'typing' ? <TypingGame /> : view === 'deploy' ? <DeployGame /> : <ByteDaemonHome onClose={onClose} />}
    </div>
  )
}

/**
 * The Byte Daemon: a small mini game hidden at the right end of the status bar
 * (docs/plan/2026-11-24-byte-daemon-mini-game.md). Hidden in Zen mode and from the command palette.
 */
export function ByteDaemonStatus() {
  const hidden = useByteDaemonStore(state => state.save.hidden)
  const open = useByteDaemonStore(state => state.open)
  const setOpen = useByteDaemonStore(state => state.setOpen)
  const zenMode = useUIStore(state => state.zenMode)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const shown = !hidden && !zenMode
  useTicking(open && shown)

  /** Close; give focus back to where it was unless the user clicked somewhere else */
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    const target = returnFocus.current
    returnFocus.current = null
    if (!restoreFocus) return
    if (target && target.isConnected && target !== document.body) target.focus({ preventScroll: true })
    else trigger.current?.focus({ preventScroll: true })
  }, [setOpen])

  useEffect(() => {
    if (open && !shown) close(false)
  }, [open, shown, close])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      close(true)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [open, close])

  if (!shown) return null

  return (
    <div className="bd-status" ref={root}>
      <button type="button" ref={trigger} className={`bd-trigger${open ? ' is-open' : ''}`}
        aria-label="바이트 데몬 (미니 게임)" title="바이트 데몬" aria-haspopup="dialog" aria-expanded={open}
        onPointerDown={() => { if (!open) returnFocus.current = document.activeElement as HTMLElement | null }}
        onClick={() => {
          if (open) return close(true)
          returnFocus.current ??= trigger.current
          setOpen(true)
        }}>
        <DaemonStatusIcon asleep className="bd-icon-asleep" />
        <DaemonStatusIcon asleep={false} className="bd-icon-awake" />
        <i className="bd-zz" aria-hidden="true">z</i><i className="bd-zz is-second" aria-hidden="true">z</i>
      </button>
      {open && <ByteDaemonPanel onClose={() => close(true)} />}
    </div>
  )
}
