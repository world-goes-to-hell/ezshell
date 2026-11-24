import { useEffect, useRef, useState } from 'react'
import { DaemonArt } from './DaemonArt'
import { useByteDaemonStore, type ByteDaemonView } from '../../stores/byteDaemonStore'
import {
  PRODUCERS, costOf, formatBytes, formatRate, nextLocked, rateOf, revealedProducers, type Producer
} from '../../lib/byteDaemon'
import { deployStake } from '../../lib/byteDaemonGames'
import type { ArtKey } from '../../lib/byteDaemonArt'

const LOG_EVERY_MS = 2600
const LOG_ROWS = 3

const durationText = (ms: number) => {
  const minutes = Math.round(ms / 60000)
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`
}

function Bytes({ value }: { value: number }) {
  const [number, unit] = formatBytes(value).split(' ')
  return <div className="bd-bytes">{number}<small>{unit}</small></div>
}

/** While the popover shows, owned producers print a line now and then (only while it is open) */
function useProducerChatter() {
  const pushLog = useByteDaemonStore(state => state.pushLog)
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return
      const { owned } = useByteDaemonStore.getState().save
      const working = PRODUCERS.filter(p => owned[p.id] > 0)
      if (!working.length) return
      const producer = working[Math.floor(Math.random() * working.length)]
      const line = producer.logs[Math.floor(Math.random() * producer.logs.length)]
      pushLog(`[${producer.role}] ${line} +${formatBytes(producer.rate * owned[producer.id] * LOG_EVERY_MS / 1000)}`)
    }, LOG_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [pushLog])
}

function GameRow({ art, name, desc, best, unit, view, disabled, disabledReason }: {
  art: ArtKey; name: string; desc: string; best: string; unit: string; view: ByteDaemonView; disabled?: boolean; disabledReason?: string
}) {
  const setView = useByteDaemonStore(state => state.setView)
  return (
    <div className="bd-game">
      <span className="bd-game-icon"><DaemonArt name={art} size={30} /></span>
      <span className="bd-game-text"><span className="bd-game-name">{name}</span><span className="bd-game-desc">{desc}</span></span>
      <span className="bd-game-best">{best}<em>{unit}</em></span>
      <button type="button" className="bd-play" onClick={() => setView(view)} disabled={disabled} title={disabled ? disabledReason : undefined}
        aria-label={`${name} 시작`}>시작</button>
    </div>
  )
}

function ProducerRow({ producer, owned, bytes }: { producer: Producer; owned: number; bytes: number }) {
  const buy = useByteDaemonStore(state => state.buy)
  const price = costOf(producer, owned)
  const output = owned > 0 ? `+${formatRate(producer.rate * owned)}` : `하나에 +${formatRate(producer.rate)}`
  return (
    <div className="bd-prod">
      <span className="bd-prod-art"><DaemonArt name={producer.art} size={34} /></span>
      <span className="bd-prod-text">
        <span className="bd-prod-name">{producer.name}{owned > 0 && <span className="bd-count">×{owned}</span>}</span>
        <span className="bd-prod-meta">{producer.role} · {output}{producer.perk && <> · <span className={owned > 0 ? 'bd-perk is-on' : 'bd-perk'}>{producer.perk}</span></>}</span>
      </span>
      <button type="button" className="bd-buy" disabled={bytes < price} onClick={() => buy(producer.id)}
        aria-label={`${producer.name} 사기, ${formatBytes(price)}`}>{formatBytes(price)}</button>
    </div>
  )
}

export function ByteDaemonHome({ onClose }: { onClose: () => void }) {
  const save = useByteDaemonStore(state => state.save)
  const log = useByteDaemonStore(state => state.log)
  const click = useByteDaemonStore(state => state.click)
  const claimAway = useByteDaemonStore(state => state.claimAway)
  const [pops, setPops] = useState<{ id: number; text: string }[]>([])
  const [cheer, setCheer] = useState(false)
  const popSeq = useRef(0)
  const cheerTimer = useRef<number | undefined>(undefined)
  useProducerChatter()
  useEffect(() => () => window.clearTimeout(cheerTimer.current), [])

  const rate = rateOf(save.owned)
  const locked = nextLocked(save)
  const revealed = revealedProducers(save)
  const stake = deployStake(save.bytes, rate)

  const pet = () => {
    const amount = click()
    const id = ++popSeq.current
    setPops(list => [...list.slice(-4), { id, text: `+${formatBytes(amount)}` }])
    window.setTimeout(() => setPops(list => list.filter(pop => pop.id !== id)), 800)
    setCheer(true)
    window.clearTimeout(cheerTimer.current)
    cheerTimer.current = window.setTimeout(() => setCheer(false), 500)
  }

  return (
    <>
      <header className="bd-head">
        <button type="button" className="bd-avatar" onClick={pet} aria-label="데몬 쓰다듬기 (바이트 얻기)" title="쓰다듬으면 바이트가 생깁니다">
          <DaemonArt name="daemon" face={cheer ? 'happy' : 'awake'} size={48} className="bd-bob" />
          {pops.map(pop => <span key={pop.id} className="bd-pop" aria-hidden="true">{pop.text}</span>)}
        </button>
        <div className="bd-title">
          <div className="bd-name">바이트 데몬</div>
          <Bytes value={save.bytes} />
          <div className="bd-rate">
            초당 {formatRate(rate)}{locked ? ` · 다음 친구까지 ${formatBytes(locked.remaining)}` : ' · 친구를 모두 모았습니다'}
          </div>
        </div>
        <button type="button" className="bd-close" onClick={onClose} aria-label="닫기" title="닫기 (Esc)">✕</button>
      </header>
      <div className="bd-body">
        {save.away && (
          <div className="bd-away" role="status">
            <span className="bd-zzz" aria-hidden="true">z<sup>z</sup></span>
            <span>데몬이 <b>{durationText(save.away.ms)}</b> 동안 <b>+{formatBytes(save.away.amount)}</b> 모았습니다</span>
            <button type="button" onClick={claimAway}>받기</button>
          </div>
        )}
        <section aria-label="미니 게임">
          <div className="bd-sec-title">미니 게임 <span>한 판에 최대 {formatBytes(Math.max(40, rate * 60) * 1.5)}</span></div>
          <div className="bd-games">
            <GameRow art="bug" name="오류 잡기" desc="ERROR 줄의 벌레를 잡으세요 · 30초" best={save.best.bugs.toLocaleString('ko-KR')} unit="최고 점수" view="bugs" />
            <GameRow art="keyboard" name="명령어 타자" desc="나오는 명령을 그대로 빠르게 · 30초" best={save.best.typing.toLocaleString('ko-KR')} unit="최고 타/분" view="typing" />
            <GameRow art="rocket" name="금요일 배포" desc={stake ? `판돈 ${formatBytes(stake)} · 어디서 멈출까` : '판돈이 모자랍니다 (10 B 부터)'}
              best={save.best.deploy ? `×${save.best.deploy}` : '-'} unit="최고 배율" view="deploy"
              disabled={!stake} disabledReason="바이트가 10 B 이상 있어야 합니다" />
          </div>
        </section>
        <section aria-label="생산자">
          <div className="bd-sec-title">생산자 <span>초당 {formatRate(rate)}</span></div>
          <div className="bd-prods">
            {revealed.map(producer => <ProducerRow key={producer.id} producer={producer} owned={save.owned[producer.id]} bytes={save.bytes} />)}
            {locked && (
              <div className="bd-prod is-locked">
                <span className="bd-prod-art bd-silhouette"><DaemonArt name={locked.producer.art} size={34} /></span>
                <span className="bd-prod-text"><span className="bd-prod-name">???</span><span className="bd-prod-meta">바이트를 {formatBytes(locked.remaining)} 더 모으면 나타납니다</span></span>
                <button type="button" className="bd-buy" disabled>잠김</button>
              </div>
            )}
          </div>
        </section>
      </div>
      <div className="bd-log" aria-label="게임 로그">
        <div className="bd-log-title">게임 로그</div>
        {/* Always three rows: a growing log would move the buttons above while the pointer aims at them */}
        {Array.from({ length: LOG_ROWS }, (_, index) => {
          const line = log[index]
          if (line) return <div key={line.id} className={`bd-log-line is-${line.kind}`}>{line.text}</div>
          return <div key={`empty-${index}`} className="bd-log-line is-empty">{index === 0 && !log.length ? '데몬을 쓰다듬거나 게임을 해 보세요.' : ' '}</div>
        })}
      </div>
    </>
  )
}
