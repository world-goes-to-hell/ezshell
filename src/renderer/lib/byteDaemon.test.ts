import { describe, expect, it } from 'vitest'
import {
  AWAY_CAP_MS, AWAY_NOTICE_MS, PRODUCERS, buy, claimAway, clickValue, costOf, emptySave, formatBytes, formatRate,
  gameReward, gameUnit, nextLocked, parseSave, rateOf, revealedProducers, settle, type ByteDaemonSave
} from './byteDaemon'

const owning = (owned: Partial<ByteDaemonSave['owned']>, extra: Partial<ByteDaemonSave> = {}): ByteDaemonSave =>
  ({ ...emptySave(0), ...extra, owned: { ...emptySave(0).owned, ...owned } })

describe('byte daemon economy', () => {
  it('lets the first alias be bought after a handful of clicks', () => {
    const first = costOf(PRODUCERS[0], 0)
    const clicks = Math.ceil(first / clickValue(0))
    expect(clicks).toBeGreaterThanOrEqual(5)
    expect(clicks).toBeLessThanOrEqual(10)
  })

  it('raises the price 1.15 times per producer owned', () => {
    const alias = PRODUCERS[0]
    expect(costOf(alias, 1)).toBe(Math.ceil(alias.baseCost * 1.15))
    expect(costOf(alias, 10)).toBe(Math.ceil(alias.baseCost * 1.15 ** 10))
  })

  it('adds up the production of every producer owned', () => {
    const save = owning({ alias: 3, cron: 2 })
    const alias = PRODUCERS.find(p => p.id === 'alias')!
    const cron = PRODUCERS.find(p => p.id === 'cron')!
    expect(rateOf(save.owned)).toBeCloseTo(alias.rate * 3 + cron.rate * 2)
  })

  it('buys only what the bytes cover and keeps the old save untouched', () => {
    const poor = owning({}, { bytes: 10 })
    expect(buy(poor, 'alias')).toBeNull()
    const rich = owning({}, { bytes: 100 })
    const after = buy(rich, 'alias')!
    expect(after.owned.alias).toBe(1)
    expect(after.bytes).toBe(100 - costOf(PRODUCERS[0], 0))
    expect(rich.owned.alias).toBe(0)
  })

  it('pays a game from a minimum early and from a minute of production later, capped at 1.5', () => {
    expect(gameUnit(0)).toBe(40)
    expect(gameUnit(100)).toBe(6000)
    expect(gameReward(100, 1)).toBe(6000)
    expect(gameReward(100, 3)).toBe(9000)
    expect(gameReward(100, -1)).toBe(0)
  })
})

describe('settling production over time', () => {
  it('adds production silently for a short gap', () => {
    const save = owning({ alias: 10 }, { settledAt: 1000 })
    const result = settle(save, 1000 + 60_000)
    expect(result.bytes).toBeCloseTo(rateOf(save.owned) * 60)
    expect(result.away).toBeNull()
    expect(result.settledAt).toBe(61_000)
  })

  it('holds a long absence as a reward to claim, together with the new time', () => {
    const save = owning({ alias: 10 }, { settledAt: 0 })
    const later = settle(save, AWAY_NOTICE_MS + 1000)
    expect(later.bytes).toBe(0)
    expect(later.away?.amount).toBeCloseTo(rateOf(save.owned) * (AWAY_NOTICE_MS + 1000) / 1000)
    expect(later.settledAt).toBe(AWAY_NOTICE_MS + 1000)
    // Settling again at the same moment pays nothing twice
    const again = settle(later, AWAY_NOTICE_MS + 1000)
    expect(again.away?.amount).toBe(later.away?.amount)
    expect(again.bytes).toBe(0)
    const claimed = claimAway(again)
    expect(claimed.bytes).toBeCloseTo(later.away!.amount)
    expect(claimed.earned).toBeCloseTo(later.away!.amount)
    expect(claimed.away).toBeNull()
  })

  it('pays at most eight hours away', () => {
    const save = owning({ alias: 1 }, { settledAt: 0 })
    const result = settle(save, AWAY_CAP_MS * 3)
    expect(result.away?.ms).toBe(AWAY_CAP_MS)
    expect(result.away?.amount).toBeCloseTo(rateOf(save.owned) * AWAY_CAP_MS / 1000)
  })

  it('pays nothing when the clock went back, and starts again from now', () => {
    const save = owning({ alias: 5 }, { settledAt: 50_000, bytes: 7 })
    const result = settle(save, 10_000)
    expect(result.bytes).toBe(7)
    expect(result.settledAt).toBe(10_000)
  })
})

describe('producers shown', () => {
  it('shows the first producer from the very start as the first goal', () => {
    expect(revealedProducers(emptySave(0)).map(p => p.id)).toEqual(['alias'])
    expect(nextLocked(emptySave(0))?.producer.id).toBe('script')
  })

  it('reveals producers as lifetime bytes reach half their price, and names the next one', () => {
    const save = owning({}, { earned: PRODUCERS[1].baseCost / 2 })
    expect(revealedProducers(save).map(p => p.id)).toEqual(['alias', 'script'])
    expect(nextLocked(save)?.producer.id).toBe('cron')
    expect(nextLocked(save)?.remaining).toBeCloseTo(PRODUCERS[2].baseCost / 2 - save.earned)
  })
})

describe('reading the save', () => {
  it('starts fresh from nothing or garbage', () => {
    expect(parseSave(null, 5)).toEqual(emptySave(5))
    expect(parseSave('{oops', 5)).toEqual(emptySave(5))
    expect(parseSave(JSON.stringify({ v: 2 }), 5)).toEqual(emptySave(5))
  })

  it('keeps valid fields and drops bad ones', () => {
    const raw = JSON.stringify({
      v: 1, bytes: 120, earned: 500, settledAt: 3, hidden: true,
      owned: { alias: 4, script: -2, cron: 1.5, bogus: 9 },
      away: { amount: 30, ms: 600_000 }, best: { bugs: 900, typing: 'x', deploy: 5 }
    })
    const save = parseSave(raw, 10)
    expect(save.bytes).toBe(120)
    expect(save.owned).toEqual({ ...emptySave(0).owned, alias: 4 })
    expect(save.away).toEqual({ amount: 30, ms: 600_000 })
    expect(save.best).toEqual({ bugs: 900, typing: 0, deploy: 5 })
    expect(save.hidden).toBe(true)
  })

  it('rejects numbers that are not finite or not plausible', () => {
    const save = parseSave(JSON.stringify({ v: 1, bytes: 1e400, earned: -5, settledAt: 'now', owned: {} }), 10)
    expect(save.bytes).toBe(0)
    expect(save.earned).toBe(0)
    expect(save.settledAt).toBe(10)
  })
})

describe('byte units', () => {
  it('shows bytes with 1024 steps', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512.7)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12.4 * 1024 ** 2)).toBe('12.4 MB')
    expect(formatBytes(300 * 1024 ** 3)).toBe('300 GB')
    expect(formatRate(48)).toBe('48 B/초')
    expect(formatRate(0.5)).toBe('0.5 B/초')
  })
})
