import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOOK_COMMANDS } from '../agentHookReport.js'
import { CODEX_HOOK_ARGS, codexProjectHooksPossible, observeCodexHookReview } from './codexHookLaunch.js'

afterEach(() => vi.useRealTimers())

describe('Codex hook launch', () => {
  // Codex warned at every start about SessionEnd / Interrupt above 3 s and an async SessionEnd (2026-11-25)
  it('gives the ten Codex events the stable commands with the limits Codex actually runs', () => {
    expect(CODEX_HOOK_ARGS).toHaveLength(20)
    const events = []
    for (let i = 0; i < CODEX_HOOK_ARGS.length; i += 2) {
      expect(CODEX_HOOK_ARGS[i]).toBe('-c')
      const [, event, posix, windows, timeout, async] = /^hooks\.(\w+)=\[\{hooks=\[\{type='command',command=("[^"]+"),command_windows=("[^"]+"),timeout=(\d+),async=(true|false)\}\]\}\]$/.exec(CODEX_HOOK_ARGS[i + 1])
      expect(JSON.parse(posix)).toBe(HOOK_COMMANDS.codex)
      expect(JSON.parse(windows)).toBe(HOOK_COMMANDS.codexWindows)
      expect(timeout).toBe(event === 'SessionEnd' || event === 'Interrupt' ? '3' : '5')
      expect(async).toBe(event === 'Stop' || event === 'SessionEnd' ? 'false' : 'true')
      events.push(event)
    }
    expect(events).toContain('Interrupt')
    expect(new Set(events).size).toBe(10)
  })

  it('waits for an actual turn after the first regular prompt before timing a decline', () => {
    vi.useFakeTimers()
    const onDecline = vi.fn(() => true)
    const review = observeCodexHookReview({ cols: 80, rows: 24, mayDecline: () => true, onDecline, onReviewChange: vi.fn() })
    try {
      vi.advanceTimersByTime(30_000)
      review.input('\r', 'pending')
      review.input('/model', 'pending')
      review.input('\r', 'pending')
      review.turnStarted()
      vi.advanceTimersByTime(30_000)
      expect(onDecline).not.toHaveBeenCalled()
      review.input('first prompt', 'pending')
      review.input('\r', 'pending')
      vi.advanceTimersByTime(15_000)
      expect(onDecline).not.toHaveBeenCalled()
      review.turnStarted()
      vi.advanceTimersByTime(9_999)
      expect(onDecline).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onDecline).toHaveBeenCalledOnce()
    } finally { review.close() }
  })

  it('cancels the decline when the first hook arrives after a slow turn start', () => {
    vi.useFakeTimers()
    const onDecline = vi.fn()
    const review = observeCodexHookReview({ cols: 80, rows: 24, mayDecline: () => true, onDecline, onReviewChange: vi.fn() })
    review.input('first prompt', 'pending')
    review.input('\r', 'pending')
    vi.advanceTimersByTime(15_000)
    review.turnStarted()
    review.close()
    vi.advanceTimersByTime(10_000)
    expect(onDecline).not.toHaveBeenCalled()
  })

  it('detects checkout hooks from a nested launch and treats ambiguous paths conservatively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezshell-codex-project-'))
    try {
      const repo = join(dir, 'repo')
      const cwd = join(repo, 'nested')
      mkdirSync(cwd, { recursive: true })
      mkdirSync(join(repo, '.git'))
      mkdirSync(join(repo, '.codex'))
      const config = join(repo, '.codex', 'config.toml')
      writeFileSync(config, '[features]\nhooks = true\n')
      expect(codexProjectHooksPossible(cwd)).toBe(true)
      writeFileSync(config, '[features]\nfoo = true\n')
      expect(codexProjectHooksPossible(cwd)).toBe(false)
      writeFileSync(config, '[[hooks.Stop]]\n')
      expect(codexProjectHooksPossible(cwd)).toBe(true)
      expect(codexProjectHooksPossible(join(dir, 'missing'))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
