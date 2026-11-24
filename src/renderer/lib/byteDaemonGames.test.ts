import { describe, expect, it } from 'vitest'
import {
  CATCH_TARGET, COMMANDS, DEPLOY_STEPS, catchFactor, crawlMs, deployRisk, deployStake, isFridayEvening, keyChar,
  lineIntervalMs, randomLine, typingFactor, typingSeconds, charsPerMinute, catchSeconds
} from './byteDaemonGames'

describe('catch the bug', () => {
  it('speeds up over the round, and a container slows the bugs', () => {
    expect(lineIntervalMs(0)).toBeGreaterThan(lineIntervalMs(29_000))
    expect(crawlMs(0, false)).toBeGreaterThan(crawlMs(29_000, false))
    expect(crawlMs(10_000, true)).toBeGreaterThan(crawlMs(10_000, false))
  })

  it('draws lines of each level with plausible text', () => {
    const levels = new Set<string>()
    let seed = 0
    const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
    for (let i = 0; i < 200; i++) {
      const line = randomLine(rand)
      levels.add(line.level)
      expect(line.text.length).toBeGreaterThan(3)
    }
    expect([...levels].sort()).toEqual(['error', 'info', 'warn'])
  })

  it('pays by the score against a good round', () => {
    expect(catchFactor(CATCH_TARGET)).toBe(1)
    expect(catchFactor(0)).toBe(0)
    expect(catchSeconds).toBe(30)
  })
})

describe('command typing', () => {
  it('uses printable one-line commands', () => {
    for (const command of COMMANDS) expect(command).toMatch(/^[\x20-\x7e]{4,40}$/)
  })

  it('reads the key, and its place when a Korean input method is on', () => {
    expect(keyChar({ key: 'a', code: 'KeyA', shiftKey: false, isComposing: false })).toBe('a')
    expect(keyChar({ key: 'Process', code: 'KeyD', shiftKey: false, isComposing: true })).toBe('d')
    expect(keyChar({ key: 'ㅇ', code: 'KeyD', shiftKey: false, isComposing: false })).toBe('d')
    expect(keyChar({ key: 'Process', code: 'Minus', shiftKey: true, isComposing: true })).toBe('_')
    expect(keyChar({ key: 'Process', code: 'Digit3', shiftKey: true, isComposing: true })).toBe('#')
    expect(keyChar({ key: ' ', code: 'Space', shiftKey: false, isComposing: false })).toBe(' ')
    expect(keyChar({ key: 'Enter', code: 'Enter', shiftKey: false, isComposing: false })).toBeNull()
    expect(keyChar({ key: 'Shift', code: 'ShiftLeft', shiftKey: true, isComposing: false })).toBeNull()
  })

  it('gives more time with a cron, and pays by correct characters', () => {
    expect(typingSeconds(false)).toBe(30)
    expect(typingSeconds(true)).toBe(35)
    expect(typingFactor(120)).toBe(1)
    expect(charsPerMinute(60, 30_000)).toBe(120)
    expect(charsPerMinute(10, 0)).toBe(0)
  })
})

describe('friday deploy', () => {
  it('climbs four steps with rising multipliers and risk', () => {
    expect(DEPLOY_STEPS.map(step => step.name)).toEqual(['빌드', '테스트', '스테이징', '운영'])
    for (let i = 1; i < DEPLOY_STEPS.length; i++) {
      expect(DEPLOY_STEPS[i].mult).toBeGreaterThan(DEPLOY_STEPS[i - 1].mult)
      expect(DEPLOY_STEPS[i].risk).toBeGreaterThan(DEPLOY_STEPS[i - 1].risk)
    }
  })

  it('keeps the gamble close to even so it does not beat playing', () => {
    // Expected multiple when always stopping at a given step
    let survive = 1
    for (const step of DEPLOY_STEPS) {
      survive *= 1 - step.risk / 100
      expect(survive * step.mult).toBeLessThan(1.3)
    }
  })

  it('lowers the risk with a CI duck and raises it on friday evening', () => {
    const step = DEPLOY_STEPS[2]
    expect(deployRisk(step, { duck: true, fridayEvening: false })).toBe(step.risk - 5)
    expect(deployRisk(step, { duck: false, fridayEvening: true })).toBe(step.risk + 10)
    expect(isFridayEvening(new Date(2026, 10, 27, 18, 0))).toBe(true)
    expect(isFridayEvening(new Date(2026, 10, 27, 17, 59))).toBe(false)
    expect(isFridayEvening(new Date(2026, 10, 26, 19, 0))).toBe(false)
  })

  it('stakes at most half a game from the bytes there are', () => {
    expect(deployStake(1000, 0)).toBe(20)
    expect(deployStake(5, 0)).toBe(0)
    expect(deployStake(300, 100)).toBe(300)
  })
})
