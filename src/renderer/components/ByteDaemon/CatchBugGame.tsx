import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { DaemonArt } from './DaemonArt'
import { GameHeader, GameResult, Hud, TimeBar } from './GameParts'
import { useByteDaemonStore } from '../../stores/byteDaemonStore'
import { formatBytes, gameReward, rateOf } from '../../lib/byteDaemon'
import {
  BUG_POINTS, COMBO_MAX, INFO_PENALTY, catchFactor, catchSeconds, crawlMs, lineIntervalMs, randomLine, type LogLevel
} from '../../lib/byteDaemonGames'

const ROWS = 11
const TOTAL_MS = catchSeconds * 1000

interface Row {
  id: number
  level: LogLevel
  text: string
  time: string
  bug?: { dur: number; left: number; caught?: boolean }
}

interface Float {
  id: number
  x: number
  y: number
  text: string
  minus: boolean
}

const clock = () => new Date().toTimeString().slice(0, 8)
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function CatchRound({ onAgain }: { onAgain: () => void }) {
  const slower = useByteDaemonStore(state => state.save.owned.container > 0)
  const [rows, setRows] = useState<Row[]>([])
  const [floats, setFloats] = useState<Float[]>([])
  const [score, setScore] = useState(0)
  const [combo, setCombo] = useState(1)
  const [left, setLeft] = useState(TOTAL_MS)
  const [result, setResult] = useState<{ score: number; reward: number; best: boolean } | null>(null)
  const scoreRef = useRef(0)
  const seq = useRef(0)
  const live = useRef(new Set<number>())
  const timers = useRef(new Set<number>())
  const board = useRef<HTMLDivElement>(null)
  const still = useRef(reducedMotion())

  const later = (fn: () => void, ms: number) => {
    const id = window.setTimeout(() => { timers.current.delete(id); fn() }, ms)
    timers.current.add(id)
  }

  const finish = useCallback(() => {
    for (const id of timers.current) window.clearTimeout(id)
    timers.current.clear()
    live.current.clear()
    const { save, reward, record } = useByteDaemonStore.getState()
    const final = scoreRef.current
    const amount = gameReward(rateOf(save.owned), catchFactor(final))
    const best = record('bugs', final)
    reward(amount, `[오류 잡기] ${final.toLocaleString('ko-KR')}점 +${formatBytes(amount)}`)
    setResult({ score: final, reward: amount, best })
  }, [])

  // Lines arrive faster as the round goes on; a bug that reaches the left edge gets away
  useEffect(() => {
    const started = Date.now()
    let spawnTimer = 0
    const spawn = () => {
      const elapsed = Date.now() - started
      if (elapsed >= TOTAL_MS) return
      const line = randomLine()
      const id = ++seq.current
      const bug = line.level === 'info' ? undefined : { dur: crawlMs(elapsed, slower), left: 25 + Math.random() * 55 }
      setRows(list => [...list, { id, ...line, time: clock(), bug }].slice(-ROWS))
      if (bug) {
        live.current.add(id)
        later(() => {
          if (!live.current.delete(id)) return
          setRows(list => list.map(row => row.id === id ? { ...row, bug: undefined } : row))
          setCombo(1)
        }, bug.dur)
      }
      spawnTimer = window.setTimeout(spawn, lineIntervalMs(elapsed))
    }
    spawn()
    const clockTimer = window.setInterval(() => {
      const remaining = TOTAL_MS - (Date.now() - started)
      setLeft(Math.max(0, remaining))
      if (remaining <= 0) {
        window.clearInterval(clockTimer)
        window.clearTimeout(spawnTimer)
        finish()
      }
    }, 200)
    const pending = timers.current
    return () => {
      window.clearTimeout(spawnTimer)
      window.clearInterval(clockTimer)
      for (const timer of pending) window.clearTimeout(timer)
      pending.clear()
    }
  }, [slower, finish])

  const float = (event: ReactPointerEvent, text: string, minus: boolean) => {
    const box = board.current?.getBoundingClientRect()
    if (!box) return
    const id = ++seq.current
    setFloats(list => [...list, { id, x: event.clientX - box.left, y: event.clientY - box.top - 12, text, minus }])
    later(() => setFloats(list => list.filter(item => item.id !== id)), 800)
  }

  const catchBug = (event: ReactPointerEvent, row: Row) => {
    event.stopPropagation()
    if (result || !live.current.delete(row.id) || row.level === 'info') return
    const gained = BUG_POINTS[row.level] * combo
    scoreRef.current += gained
    setScore(scoreRef.current)
    setCombo(value => Math.min(COMBO_MAX, value + 1))
    setRows(list => list.map(item => item.id === row.id && item.bug ? { ...item, bug: { ...item.bug, caught: true } } : item))
    later(() => setRows(list => list.map(item => item.id === row.id ? { ...item, bug: undefined } : item)), 450)
    float(event, `+${gained}`, false)
  }

  const missRow = (event: ReactPointerEvent, row: Row) => {
    if (result || row.level !== 'info') return
    scoreRef.current = Math.max(0, scoreRef.current - INFO_PENALTY)
    setScore(scoreRef.current)
    setCombo(1)
    float(event, `−${INFO_PENALTY}`, true)
  }

  if (result) {
    return (
      <>
        <GameHeader title="오류 잡기" face="happy" />
        <GameResult face={result.score > 0 ? 'happy' : 'awake'} title={result.best ? '새 최고 점수!' : '라운드 끝'} onAgain={onAgain}
          lines={[`점수 ${result.score.toLocaleString('ko-KR')}점`, `받은 바이트 +${formatBytes(result.reward)}`, '벌레가 많을수록, 콤보가 길수록 점수가 커집니다']} />
      </>
    )
  }

  return (
    <>
      <GameHeader title="오류 잡기" />
      <Hud items={[
        { value: Math.ceil(left / 1000), label: '남은 초' },
        { value: score.toLocaleString('ko-KR'), label: '점수' },
        { value: `×${combo}`, label: '콤보', highlight: true }
      ]} />
      <TimeBar left={left} total={TOTAL_MS} />
      <div className="bd-logbox" ref={board} style={{ height: ROWS * 28 + 2 }}>
        {rows.map(row => (
          <div key={row.id} className={`bd-logrow is-${row.level}`} onPointerDown={event => missRow(event, row)}>
            <span className="bd-logtime">{row.time}</span>
            <span className="bd-loglevel">{row.level.toUpperCase()}</span>
            <span className="bd-logtext">{row.text}</span>
            {row.bug && (
              <span className={`bd-critter${row.bug.caught ? ' is-caught' : ''}${still.current ? ' is-still' : ''}`}
                style={still.current ? { left: `${row.bug.left}%` } : { animationDuration: `${row.bug.dur}ms` }}
                onPointerDown={event => catchBug(event, row)} aria-hidden="true">
                <span><DaemonArt name={row.level === 'error' ? 'bug' : 'bugWarn'} size={row.level === 'error' ? 28 : 24} /></span>
              </span>
            )}
          </div>
        ))}
        {floats.map(item => <span key={item.id} className={`bd-float${item.minus ? ' is-minus' : ''}`} style={{ left: item.x, top: item.y }}>{item.text}</span>)}
      </div>
      <div className="bd-game-foot">
        <span><b className="is-error">ERROR</b> 벌레 {BUG_POINTS.error}점</span>
        <span><b className="is-warn">WARN</b> 벌레 {BUG_POINTS.warn}점</span>
        <span><b className="is-info">INFO</b> 줄을 누르면 −{INFO_PENALTY}점</span>
      </div>
    </>
  )
}

export function CatchBugGame() {
  const [round, setRound] = useState(0)
  return <CatchRound key={round} onAgain={() => setRound(value => value + 1)} />
}
