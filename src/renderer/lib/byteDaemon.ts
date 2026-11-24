// Byte Daemon: the economy of the mini game hidden in the status bar (docs/plan/2026-11-24-byte-daemon-mini-game.md).
// Pure functions over a plain save object; the store keeps the save and the time.

export type ProducerId = 'alias' | 'script' | 'cron' | 'container' | 'ci' | 'cluster' | 'agents' | 'datacenter'
export type ArtName = 'note' | 'scroll' | 'cat' | 'hamster' | 'duck' | 'octopus' | 'robots' | 'sheep'

export interface Producer {
  id: ProducerId
  /** The character */
  name: string
  /** What it stands for */
  role: string
  art: ArtName
  baseCost: number
  /** Bytes per second, each */
  rate: number
  /** How owning one helps a game */
  perk?: string
  /** Lines it prints in the game log */
  logs: readonly string[]
}

export const PRODUCERS: readonly Producer[] = [
  { id: 'alias', name: '메모지 요정', role: 'alias', art: 'note', baseCost: 15, rate: 0.5, logs: ['ll', 'gs', 'k get po', '..'] },
  { id: 'script', name: '두루마리', role: '셸 스크립트', art: 'scroll', baseCost: 120, rate: 4, logs: ['./backup.sh', './deploy.sh', './cleanup.sh'] },
  { id: 'cron', name: '시계 고양이', role: 'cron', art: 'cat', baseCost: 1100, rate: 30, perk: '타자 시간 +5초', logs: ['backup.sh ✓', '@daily rotate-logs ✓', '*/5 health-check ✓'] },
  { id: 'container', name: '상자 햄스터', role: '컨테이너', art: 'hamster', baseCost: 12_000, rate: 220, perk: '벌레 속도 −15%', logs: ['api-1 started', 'redis healthy', 'worker-3 restarted'] },
  { id: 'ci', name: '고무 오리', role: 'CI 파이프라인', art: 'duck', baseCost: 130_000, rate: 1600, perk: '롤백 확률 −5%p', logs: ['build #1204 passed', 'lint ✓ test ✓', 'artifact uploaded'] },
  { id: 'cluster', name: '문어 선장', role: '클러스터', art: 'octopus', baseCost: 1_400_000, rate: 12_000, logs: ['scaled web to 12 pods', 'rollout complete', 'node-4 joined'] },
  { id: 'agents', name: '꼬마 로봇들', role: '에이전트 군단', art: 'robots', baseCost: 20_000_000, rate: 100_000, logs: ['리팩터링 완료', '테스트 고침', 'PR 리뷰 끝'] },
  { id: 'datacenter', name: '구름 양', role: '데이터센터', art: 'sheep', baseCost: 330_000_000, rate: 900_000, logs: ['rack B-12 online', 'cooling nominal', 'region ap-2 ready'] }
]

const PRODUCER_IDS = PRODUCERS.map(p => p.id)
export const COST_GROWTH = 1.15
/** Time away is paid up to this */
export const AWAY_CAP_MS = 8 * 60 * 60 * 1000
/** A gap this long is shown as a reward to claim rather than added silently */
export const AWAY_NOTICE_MS = 5 * 60 * 1000
const MAX_BYTES = 1e300
const MAX_OWNED = 100_000

export interface AwayReward {
  amount: number
  ms: number
}

export interface ByteDaemonSave {
  v: 1
  bytes: number
  /** Bytes earned in all, for revealing producers */
  earned: number
  owned: Record<ProducerId, number>
  /** When production was last added (ms) */
  settledAt: number
  /** Production while away, held until claimed. Stored with settledAt so it is never paid twice */
  away: AwayReward | null
  best: { bugs: number; typing: number; deploy: number }
  /** The status bar icon is hidden (command palette) */
  hidden: boolean
}

export const emptySave = (now: number): ByteDaemonSave => ({
  v: 1,
  bytes: 0,
  earned: 0,
  owned: Object.fromEntries(PRODUCER_IDS.map(id => [id, 0])) as Record<ProducerId, number>,
  settledAt: now,
  away: null,
  best: { bugs: 0, typing: 0, deploy: 0 },
  hidden: false
})

export const costOf = (producer: Producer, owned: number) => Math.ceil(producer.baseCost * COST_GROWTH ** owned)

export const rateOf = (owned: Record<ProducerId, number>) =>
  PRODUCERS.reduce((sum, p) => sum + p.rate * (owned[p.id] ?? 0), 0)

/** Bytes for one click on the daemon */
export const clickValue = (rate: number) => Math.max(2, rate * 0.2)

/** What one good game is worth: a minute of production, never less than 40 B */
export const gameUnit = (rate: number) => Math.max(40, rate * 60)

/** factor: how well the game went, 1 = a good game, up to 1.5 */
export const gameReward = (rate: number, factor: number) =>
  Math.round(gameUnit(rate) * Math.min(1.5, Math.max(0, factor)))

export function earn(save: ByteDaemonSave, amount: number): ByteDaemonSave {
  if (!(amount > 0)) return save
  return { ...save, bytes: Math.min(MAX_BYTES, save.bytes + amount), earned: Math.min(MAX_BYTES, save.earned + amount) }
}

export function spend(save: ByteDaemonSave, amount: number): ByteDaemonSave | null {
  if (!(amount >= 0) || save.bytes < amount) return null
  return { ...save, bytes: save.bytes - amount }
}

export function buy(save: ByteDaemonSave, id: ProducerId): ByteDaemonSave | null {
  const producer = PRODUCERS.find(p => p.id === id)
  if (!producer) return null
  const paid = spend(save, costOf(producer, save.owned[id]))
  return paid && { ...paid, owned: { ...paid.owned, [id]: paid.owned[id] + 1 } }
}

/**
 * Add production up to `now`. A long gap becomes an away reward to claim; the reward and the new
 * time change together, so settling again pays nothing twice. A clock that went back pays nothing.
 */
export function settle(save: ByteDaemonSave, now: number): ByteDaemonSave {
  if (!(now > save.settledAt)) return now === save.settledAt ? save : { ...save, settledAt: now }
  const elapsed = Math.min(now - save.settledAt, AWAY_CAP_MS)
  const amount = rateOf(save.owned) * elapsed / 1000
  if (elapsed < AWAY_NOTICE_MS || amount <= 0) return { ...earn(save, amount), settledAt: now }
  const away = save.away
    ? { amount: save.away.amount + amount, ms: Math.min(AWAY_CAP_MS, save.away.ms + elapsed) }
    : { amount, ms: elapsed }
  return { ...save, away, settledAt: now }
}

export const claimAway = (save: ByteDaemonSave): ByteDaemonSave =>
  save.away ? { ...earn(save, save.away.amount), away: null } : save

const revealAt = (producer: Producer) => producer.baseCost / 2
// The first producer shows from the start: it is the first goal
const isRevealed = (save: ByteDaemonSave, producer: Producer) =>
  producer === PRODUCERS[0] || save.owned[producer.id] > 0 || save.earned >= revealAt(producer)

/** Producers owned or close enough to show (lifetime bytes reached half their price) */
export const revealedProducers = (save: ByteDaemonSave) => PRODUCERS.filter(p => isRevealed(save, p))

/** The first producer still hidden, and how many lifetime bytes until it shows */
export function nextLocked(save: ByteDaemonSave): { producer: Producer; remaining: number } | null {
  const producer = PRODUCERS.find(p => !isRevealed(save, p))
  return producer ? { producer, remaining: revealAt(producer) - save.earned } : null
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
const short = (value: number) => value < 100 ? String(Math.round(value * 10) / 10) : String(Math.round(value))

export function formatBytes(bytes: number): string {
  if (!(bytes >= 1024)) return `${Math.max(0, Math.floor(bytes || 0))} B`
  const unit = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${short(bytes / 1024 ** unit)} ${UNITS[unit]}`
}

export const formatRate = (rate: number) =>
  rate >= 1024 ? `${formatBytes(rate)}/초` : `${rate < 10 ? short(rate) : Math.floor(rate)} B/초`

// ---------- the save in localStorage ----------

const finite = (value: unknown, max = MAX_BYTES): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_OWNED ? value : 0

/** Read a stored save, field by field: anything not plausible falls back to a fresh value */
export function parseSave(raw: string | null, now: number): ByteDaemonSave {
  const fresh = emptySave(now)
  if (!raw) return fresh
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fresh
    data = parsed as Record<string, unknown>
  } catch {
    return fresh
  }
  if (data.v !== 1) return fresh
  const owned = typeof data.owned === 'object' && data.owned ? data.owned as Record<string, unknown> : {}
  const best = typeof data.best === 'object' && data.best ? data.best as Record<string, unknown> : {}
  const away = typeof data.away === 'object' && data.away ? data.away as Record<string, unknown> : null
  return {
    v: 1,
    bytes: finite(data.bytes) ? data.bytes : 0,
    earned: finite(data.earned) ? data.earned : 0,
    owned: Object.fromEntries(PRODUCER_IDS.map(id => [id, count(owned[id])])) as Record<ProducerId, number>,
    settledAt: finite(data.settledAt, Number.MAX_SAFE_INTEGER) ? data.settledAt : now,
    away: away && finite(away.amount) && finite(away.ms, AWAY_CAP_MS) ? { amount: away.amount, ms: away.ms } : null,
    best: {
      bugs: finite(best.bugs) ? best.bugs : 0,
      typing: finite(best.typing) ? best.typing : 0,
      deploy: finite(best.deploy) ? best.deploy : 0
    },
    hidden: data.hidden === true
  }
}
