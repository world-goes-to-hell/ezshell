import { useEffect, useRef, useState } from 'react'
import { DaemonArt } from './DaemonArt'
import { GameHeader, GameResult, Hud } from './GameParts'
import { useByteDaemonStore } from '../../stores/byteDaemonStore'
import { formatBytes, rateOf } from '../../lib/byteDaemon'
import { DEPLOY_STEPS, deployRisk, deployStake, isFridayEvening } from '../../lib/byteDaemonGames'

type Phase =
  | { kind: 'ready' }
  | { kind: 'climb'; stake: number; level: number }
  | { kind: 'done'; won: boolean; stake: number; level: number; payout: number; best: boolean }

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']
const nowText = (date: Date) => `${WEEKDAYS[date.getDay()]} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

/** Pay out the step reached; returns the payout and whether it is a new best */
function cashOut(stake: number, level: number) {
  const step = DEPLOY_STEPS[level]
  const payout = Math.round(stake * step.mult)
  const { reward, record } = useByteDaemonStore.getState()
  const best = record('deploy', step.mult)
  reward(payout, `[금요일 배포] ${step.name} ×${step.mult} +${formatBytes(payout)}`)
  return { payout, best }
}

export function DeployGame() {
  const save = useByteDaemonStore(state => state.save)
  const takeStake = useByteDaemonStore(state => state.stake)
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' })
  const [note, setNote] = useState('')
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const now = new Date()
  const friday = isFridayEvening(now)
  const duck = save.owned.ci > 0
  const stake = deployStake(save.bytes, rateOf(save.owned))

  // Leaving in the middle keeps what was reached (or gives the stake back before the first step)
  useEffect(() => () => {
    const current = phaseRef.current
    if (current.kind !== 'climb') return
    if (current.level >= 0) cashOut(current.stake, current.level)
    else useByteDaemonStore.getState().reward(current.stake, `[금요일 배포] 취소 · 판돈 ${formatBytes(current.stake)} 돌려받음`)
  }, [])

  const start = () => {
    if (!stake || !takeStake(stake)) return
    setNote('')
    setPhase({ kind: 'climb', stake, level: -1 })
  }

  const stop = () => {
    if (phase.kind !== 'climb' || phase.level < 0) return
    setPhase({ kind: 'done', won: true, stake: phase.stake, level: phase.level, ...cashOut(phase.stake, phase.level) })
  }

  const challenge = () => {
    if (phase.kind !== 'climb') return
    const level = phase.level + 1
    const step = DEPLOY_STEPS[level]
    if (!step) return
    if (Math.random() * 100 < deployRisk(step, { duck, fridayEvening: friday })) {
      useByteDaemonStore.getState().pushLog(`[금요일 배포] ${step.name} 에서 롤백 −${formatBytes(phase.stake)}`)
      setPhase({ kind: 'done', won: false, stake: phase.stake, level, payout: 0, best: false })
      return
    }
    if (level === DEPLOY_STEPS.length - 1) {
      setPhase({ kind: 'done', won: true, stake: phase.stake, level, ...cashOut(phase.stake, level) })
      return
    }
    setNote(`${step.name} 통과! 지금 멈추면 ×${step.mult}`)
    setPhase({ kind: 'climb', stake: phase.stake, level })
  }

  if (phase.kind === 'done') {
    const step = DEPLOY_STEPS[phase.level]
    const lines = phase.won
      ? [`${step.name} 까지 가서 ×${step.mult}`, `받은 바이트 +${formatBytes(phase.payout)} (판돈 ${formatBytes(phase.stake)})`, phase.best ? '새 최고 배율입니다!' : '퇴근하셔도 됩니다']
      : [`${step.name} 단계에서 롤백되었습니다`, `판돈 −${formatBytes(phase.stake)}`, friday ? '금요일 저녁 배포는 원래 위험합니다' : '다음엔 조금 일찍 멈춰 볼까요?']
    return (
      <>
        <GameHeader title="금요일 배포" face={phase.won ? 'happy' : 'dizzy'} />
        <GameResult face={phase.won ? 'happy' : 'dizzy'} title={phase.won ? (phase.level === DEPLOY_STEPS.length - 1 ? '운영 배포 성공!' : '무사히 멈췄습니다') : '롤백!'}
          lines={lines} onAgain={stake ? () => setPhase({ kind: 'ready' }) : undefined} againLabel="한 번 더 배포" lost={!phase.won} />
      </>
    )
  }

  const level = phase.kind === 'climb' ? phase.level : -1
  const next = DEPLOY_STEPS[level + 1]
  const shownStake = phase.kind === 'climb' ? phase.stake : stake
  return (
    <>
      <GameHeader title="금요일 배포" face={phase.kind === 'climb' ? 'awake' : 'happy'} />
      <Hud items={[
        { value: nowText(now), label: '지금' },
        { value: formatBytes(shownStake), label: '판돈' },
        { value: save.best.deploy ? `×${save.best.deploy}` : '-', label: '최고 배율', highlight: true }
      ]} />
      <div className="bd-deploy">
        <ol className="bd-ladder" aria-label="배포 단계">
          {DEPLOY_STEPS.map((step, index) => {
            const risk = deployRisk(step, { duck, fridayEvening: friday })
            const state = index <= level ? ' is-passed' : index === level + 1 && phase.kind === 'climb' ? ' is-next' : ''
            return (
              <li key={step.name} className={`bd-rung${state}${index === level ? ' is-current' : ''}`}>
                {index === level && <span className="bd-rider bd-bob"><DaemonArt name="daemon" face="happy" size={28} /></span>}
                <span className="bd-rung-icon"><DaemonArt name={step.art} size={28} /></span>
                <span className="bd-rung-name">{step.name}<small>{step.sub}</small></span>
                <span className="bd-risk"><i style={{ width: `${risk}%` }} /><span>롤백 {risk}%</span></span>
                <span className="bd-mult">×{step.mult}</span>
              </li>
            )
          })}
        </ol>
        {phase.kind === 'ready' ? (
          <>
            <p className="bd-deploy-rule">판돈을 걸고 한 단계씩 배포합니다. 멈추면 그 단계의 배율만큼 받고, 롤백되면 판돈을 잃습니다.</p>
            <button type="button" className="bd-primary bd-wide" onClick={start} disabled={!stake}>
              {stake ? `판돈 ${formatBytes(stake)} 걸고 배포 시작` : '판돈이 모자랍니다 (10 B 부터)'}
            </button>
          </>
        ) : (
          <>
            <div className="bd-pot">
              <span>{level >= 0 ? '지금 멈추면' : '아직 배포 전'}</span>
              <b>{level >= 0 ? `×${DEPLOY_STEPS[level].mult} · ${formatBytes(Math.round(phase.stake * DEPLOY_STEPS[level].mult))}` : formatBytes(phase.stake)}</b>
            </div>
            <div className="bd-deploy-actions">
              <button type="button" className="bd-secondary" onClick={stop} disabled={level < 0}>여기서 멈추기</button>
              <button type="button" className="bd-primary" onClick={challenge} autoFocus>
                {next.name} 도전 · 롤백 {deployRisk(next, { duck, fridayEvening: friday })}%
              </button>
            </div>
            <div className="bd-deploy-note" role="status">{note}</div>
          </>
        )}
        <p className="bd-deploy-foot">
          금요일 18시가 넘으면 롤백 확률이 10%p 오릅니다{friday ? ' (지금 적용 중)' : ''}
          {duck && ' · 고무 오리가 롤백 확률을 5%p 낮춥니다'}
        </p>
      </div>
    </>
  )
}
