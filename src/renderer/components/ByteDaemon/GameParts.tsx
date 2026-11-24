import type { ReactNode } from 'react'
import { DaemonArt } from './DaemonArt'
import type { DaemonFace } from '../../lib/byteDaemonArt'
import { useByteDaemonStore } from '../../stores/byteDaemonStore'

export function GameHeader({ title, face = 'happy', onExit }: { title: string; face?: DaemonFace; onExit?: () => void }) {
  const setView = useByteDaemonStore(state => state.setView)
  return (
    <div className="bd-game-head">
      <button type="button" className="bd-back" onClick={() => (onExit ?? (() => setView('home')))()}>← 나가기</button>
      <h3>{title}</h3>
      <DaemonArt name="daemon" face={face} size={32} className="bd-bob" />
    </div>
  )
}

export function Hud({ items }: { items: { value: ReactNode; label: string; highlight?: boolean }[] }) {
  return (
    <div className="bd-hud">
      {items.map(item => (
        <div key={item.label} className={item.highlight ? 'is-highlight' : undefined}>
          <b>{item.value}</b><span>{item.label}</span>
        </div>
      ))}
    </div>
  )
}

export function TimeBar({ left, total }: { left: number; total: number }) {
  return (
    <div className="bd-timebar" role="progressbar" aria-label="남은 시간" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.ceil(left)}>
      <i style={{ width: `${Math.max(0, Math.min(100, left / total * 100))}%` }} />
    </div>
  )
}

/** The end of a round: what happened, what it paid, and again or back */
export function GameResult({ face, title, lines, onAgain, againLabel = '다시 하기', lost = false }: {
  face: DaemonFace
  title: string
  /** The second line is the bytes: green when won, red when lost */
  lines: ReactNode[]
  onAgain?: () => void
  againLabel?: string
  lost?: boolean
}) {
  const setView = useByteDaemonStore(state => state.setView)
  return (
    <div className={`bd-result${lost ? ' is-lost' : ''}`}>
      <DaemonArt name="daemon" face={face} size={84} className={face === 'happy' ? 'bd-bob' : undefined} />
      <h4>{title}</h4>
      <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <div className="bd-result-actions">
        {onAgain && <button type="button" className="bd-primary" onClick={onAgain}>{againLabel}</button>}
        <button type="button" className="bd-secondary" onClick={() => setView('home')}>돌아가기</button>
      </div>
    </div>
  )
}
