import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { DaemonArt } from './DaemonArt'
import { GameHeader, GameResult, Hud, TimeBar } from './GameParts'
import { useByteDaemonStore } from '../../stores/byteDaemonStore'
import { formatBytes, gameReward, rateOf } from '../../lib/byteDaemon'
import { COMBO_MAX, COMMANDS, charsPerMinute, keyChar, typingFactor, typingSeconds } from '../../lib/byteDaemonGames'

const shuffled = (items: readonly string[]) => {
  const list = [...items]
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

function TypingRound({ onAgain }: { onAgain: () => void }) {
  const cron = useByteDaemonStore(state => state.save.owned.cron > 0)
  const total = useMemo(() => typingSeconds(cron) * 1000, [cron])
  const order = useMemo(() => shuffled(COMMANDS), [])
  const [index, setIndex] = useState(0)
  const [typed, setTyped] = useState(0)
  const [combo, setCombo] = useState(1)
  const [miss, setMiss] = useState(0)
  const [left, setLeft] = useState(total)
  const [focused, setFocused] = useState(true)
  const [tapping, setTapping] = useState(0)
  const [history, setHistory] = useState<{ id: number; text: string; combo: number }[]>([])
  const [result, setResult] = useState<{ cpm: number; correct: number; reward: number; best: boolean } | null>(null)
  const correct = useRef(0)
  const started = useRef(Date.now())
  const input = useRef<HTMLInputElement>(null)

  const finish = useCallback(() => {
    const { save, reward, record } = useByteDaemonStore.getState()
    const cpm = charsPerMinute(correct.current, total)
    const amount = gameReward(rateOf(save.owned), typingFactor(correct.current))
    const best = record('typing', cpm)
    reward(amount, `[명령어 타자] ${cpm}타/분 +${formatBytes(amount)}`)
    setResult({ cpm, correct: correct.current, reward: amount, best })
  }, [total])

  useEffect(() => {
    started.current = Date.now()
    const timer = window.setInterval(() => {
      const remaining = total - (Date.now() - started.current)
      setLeft(Math.max(0, remaining))
      if (remaining <= 0) {
        window.clearInterval(timer)
        finish()
      }
    }, 200)
    return () => window.clearInterval(timer)
  }, [total, finish])

  const command = order[index % order.length]

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Esc closes the popover; shortcuts with Ctrl/Alt/Meta stay the app's
    if (result || event.key === 'Escape' || event.ctrlKey || event.metaKey || event.altKey) return
    const typedChar = keyChar({ key: event.key, code: event.code, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })
    if (typedChar === null) return
    event.preventDefault()
    if (typedChar !== command[typed]) {
      setCombo(1)
      setMiss(value => value + 1)
      return
    }
    correct.current++
    setTapping(value => value + 1)
    if (typed + 1 < command.length) {
      setTyped(typed + 1)
      return
    }
    setHistory(list => [{ id: Date.now(), text: command, combo }, ...list].slice(0, 3))
    setIndex(index + 1)
    setTyped(0)
    setCombo(Math.min(COMBO_MAX, combo + 1))
  }

  if (result) {
    return (
      <>
        <GameHeader title="명령어 타자" />
        <GameResult face={result.correct > 0 ? 'happy' : 'awake'} title={result.best ? '새 최고 기록!' : '라운드 끝'} onAgain={onAgain}
          lines={[`${result.cpm}타/분 · 맞게 친 글자 ${result.correct}개`, `받은 바이트 +${formatBytes(result.reward)}`, cron ? '시계 고양이 덕분에 5초 더 쳤습니다' : '시계 고양이(cron)가 있으면 5초 더 칩니다']} />
      </>
    )
  }

  const elapsed = total - left
  return (
    <>
      <GameHeader title="명령어 타자" />
      <Hud items={[
        { value: Math.ceil(left / 1000), label: '남은 초' },
        // The first seconds would read thousands a minute from a few keys
        { value: elapsed < 3000 ? '-' : charsPerMinute(correct.current, elapsed), label: '타/분' },
        { value: `×${combo}`, label: '콤보', highlight: true }
      ]} />
      <TimeBar left={left} total={total} />
      <div className="bd-typing">
        <div className="bd-type-scene" aria-hidden="true">
          <DaemonArt name="daemon" face="happy" size={72} className="bd-bob" />
          <DaemonArt name="keyboard" size={58} />
          {tapping > 0 && <span key={tapping} className="bd-tap">타닥</span>}
        </div>
        <label className={`bd-type-target${focused ? ' is-focused' : ''}`}>
          <span className="bd-type-line">
            <span className="bd-type-prompt">$</span>
            <span className="bd-type-done">{command.slice(0, typed)}</span>
            <span key={miss} className={`bd-type-cur${miss ? ' is-miss' : ''}`}>{command[typed] === ' ' ? ' ' : command[typed]}</span>
            <span className="bd-type-rest">{command.slice(typed + 1)}</span>
          </span>
          <input ref={input} autoFocus autoComplete="off" spellCheck={false} aria-label={`입력할 명령: ${command}`}
            onKeyDown={onKeyDown} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            onInput={event => { event.currentTarget.value = '' }} onCompositionEnd={event => { event.currentTarget.value = '' }} />
          <span className="bd-type-hint">{focused ? '그대로 쳐 보세요 · 틀리면 콤보가 처음부터' : '여기를 누르면 이어서 칩니다'}</span>
        </label>
        <div className="bd-type-list">
          <b>다음 명령</b>
          <span>{order[(index + 1) % order.length]} · {order[(index + 2) % order.length]}</span>
        </div>
        {history.length > 0 && (
          <div className="bd-type-list">
            <b>완료</b>
            {history.map(item => <span key={item.id} className="is-ok">✓ {item.text}<em>콤보 ×{item.combo}</em></span>)}
          </div>
        )}
      </div>
    </>
  )
}

export function TypingGame() {
  const [round, setRound] = useState(0)
  return <TypingRound key={round} onAgain={() => setRound(value => value + 1)} />
}
